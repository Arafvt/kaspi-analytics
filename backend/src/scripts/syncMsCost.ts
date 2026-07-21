/**
 * Себестоимость (закуп ¥) из МойСклад → sku_costs.cogs_yuan.
 *   npx tsx src/scripts/syncMsCost.ts
 *
 * В МойСклад закупочная цена лежит в стандартном buyPrice карточки товара, в валюте
 * ЮАНЬ (CNY). Публичного «артикула Каспи» в карточках нет (поле есть, но пустое),
 * поэтому связываем Kaspi SKU ↔ МС по коду модели FaizFull (F043, FL144, FAIZ162…),
 * который сидит в названии Kaspi-товара и в поле article карточки МС.
 *
 * Матчинг — по «сильным» токенам (буквы+цифры, редкие), чтобы не сцепить по «64GB»/«10».
 * Это ДЕМО-связка на чтение: МС ничего не меняем. Себест ₸ = закуп¥ × fx_cny (курс
 * приложения, настройка). Доставку из Китая (вес × цена-за-1кг $) тут НЕ пишем —
 * нужен отдельный $-курс; добавим следующим шагом.
 *
 * Бэкап текущих себестоимостей: таблица sku_costs_backup_msdemo (создана вручную).
 * Откат: TRUNCATE sku_costs; INSERT INTO sku_costs SELECT * FROM sku_costs_backup_msdemo;
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, '../../../.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  if (!(line.slice(0, i).trim() in process.env)) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
process.env.DATABASE_URL = 'postgres://kaspi_user:kaspi_pass@localhost:5433/kaspi_rnp';

const TOKEN = process.env.MOYSKLAD_TOKEN;
if (!TOKEN) {
  console.error('[ms-cost] нет MOYSKLAD_TOKEN в .env');
  process.exit(1);
}

const { query, closePool } = await import('../db/pool.js');

const BASE = 'https://api.moysklad.ru/api/remap/1.2';
// undici сам шлёт accept-encoding (gzip) и распаковывает — вручную не ставим.
// Accept тоже не ставим: МС требует РОВНО 'application/json;charset=utf-8', а дефолтный '*/*' принимает.
const HEADERS: Record<string, string> = {
  authorization: `Bearer ${TOKEN}`,
};

interface Attr { name: string; value: unknown }
interface Product {
  code: string | null;
  article: string | null;
  name: string | null;
  weight: number | null;
  buyPrice?: { value: number | null } | null;
  attributes?: Attr[] | null;
}

// ── матчинг Kaspi ↔ МС по коду модели ────────────────────────────────────────
const HOMO: Record<string, string> = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X' };
const deHomo = (s: string) => s.replace(/[АВЕКМНОРСТУХ]/g, (c) => HOMO[c] ?? c);
const isUnit = (t: string) => /^\d+(GB|TB|MB|MAH|WT|W|CM|MM|M|A|MP|K)$/.test(t) || /^\d+$/.test(t);
const isCode = (t: string) => /[A-Z]/.test(t) && /\d/.test(t) && t.length >= 2 && !isUnit(t);
const isWord = (t: string) => /^[A-Z]{4,}$/.test(t);
const STOP = new Set([
  'FAIZFULL', 'FAIZ', 'POWER', 'BANK', 'USB', 'TYPE', 'BLACK', 'WHITE', 'BLUE', 'GREEN', 'ORANGE', 'PINK',
  'GRAY', 'GREY', 'BEIGE', 'TITAN', 'SILVER', 'RED', 'BROWN', 'GOLD', 'PURPLE', 'IPHONE', 'SAMSUNG', 'GALAXY', 'APPLE', 'ULTRA',
]);
const COLORS: Record<string, string> = { ЧЕРН: 'BLACK', ЧЁРН: 'BLACK', БЕЛ: 'WHITE', СИН: 'BLUE', ЗЕЛ: 'GREEN', ОРАНЖ: 'ORANGE', РОЗ: 'PINK', СЕР: 'GRAY', БЕЖ: 'BEIGE', ТИТАН: 'TITAN', ЗОЛОТ: 'GOLD', КОРИЧ: 'BROWN' };

function sig(str: string): Set<string> {
  const raw = deHomo(String(str || '').toUpperCase()).split(/[^A-ZА-Я0-9]+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const comp = raw[i]!.replace(/[^A-Z0-9]/g, '');
    const hasDigit = /\d/.test(comp);
    if (hasDigit && comp.length >= 2 && !STOP.has(comp)) out.add(comp);
    if (!hasDigit && comp.length >= 4 && !STOP.has(comp) && /^[A-Z]+$/.test(comp)) out.add(comp);
    const next = raw[i + 1];
    if (next) {
      const nc = next.replace(/[^A-Z0-9]/g, '');
      if (/^[A-Z]+$/.test(comp) && /^\d+$/.test(nc) && comp.length + nc.length >= 3) {
        const merged = comp + nc;
        if (!STOP.has(merged)) out.add(merged);
      }
    }
  }
  return out;
}
const colorOf = (name: string): string | null => {
  const u = name.toUpperCase();
  for (const k of Object.keys(COLORS)) if (u.includes(k)) return COLORS[k]!;
  return null;
};

async function main(): Promise<number> {
  // 1) все товары МС
  const products: Product[] = [];
  for (let off = 0; off < 20000; off += 1000) {
    const res = await fetch(`${BASE}/entity/product?limit=1000&offset=${off}`, { headers: HEADERS });
    if (res.status === 401 || res.status === 403) {
      console.error(`[ms-cost] ${res.status} — токен МойСклад недействителен. Обнови MOYSKLAD_TOKEN.`);
      return 2;
    }
    if (!res.ok) { console.error(`[ms-cost] offset ${off}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`); return 1; }
    const j = (await res.json()) as { rows?: Product[]; meta?: { size?: number } };
    const rows = j.rows ?? [];
    products.push(...rows);
    if (rows.length < 1000) break;
  }
  const withPrice = products.filter((p) => p.buyPrice && (p.buyPrice.value ?? 0) > 0).length;
  console.log(`[ms-cost] товаров в МС: ${products.length}, с закупкой ¥: ${withPrice}`);

  // 2) сигнатуры МС + df токенов (для «редкости»)
  const df = new Map<string, number>();
  const ms = products.map((p) => {
    const g = sig(p.article ?? '');
    for (const t of g) df.set(t, (df.get(t) ?? 0) + 1);
    const perKgAttr = (p.attributes ?? []).find((a) => a.name === 'цена за 1кг');
    return {
      article: p.article ?? '', code: p.code ?? '', name: p.name ?? '',
      yuan: p.buyPrice?.value ? p.buyPrice.value / 100 : 0,
      weight: p.weight ?? 0,
      perKg: perKgAttr ? String(perKgAttr.value ?? '') : '',
      sig: g,
    };
  });
  const isStrong = (t: string) => (isCode(t) || isWord(t)) && (df.get(t) ?? 0) <= 6;

  // 3) наши Kaspi SKU (все из таблицы sku — покрывает юнитку)
  const skus = await query<{ sku: string; name: string | null }>(`SELECT sku, name FROM sku`);

  // 4) курсы: ¥→₸ (fx_cny) и $→₸ (fx_usd, для доставки). Доллара в МС нет — берём из настройки.
  const fxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_cny'`);
  const fx = fxRows[0] ? Number(fxRows[0].value) : 78;
  const usdRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_usd'`);
  const fxUsd = usdRows[0] ? Number(usdRows[0].value) : 0; // 0 → доставку не считаем
  const perKgNum = (s: string) => Number(String(s).replace(',', '.').replace(/[^\d.]/g, '')) || 0;

  // 5) матчинг + запись
  let matched = 0, updated = 0, withDelivery = 0;
  const unmatched: string[] = [];
  for (const k of skus) {
    if (!k.name || !k.name.trim()) { unmatched.push(k.sku); continue; }
    const kg = sig(k.name);
    let best: (typeof ms)[number] | null = null, bestScore = 0, bestShared: string[] = [];
    for (const m of ms) {
      const shared = [...m.sig].filter((t) => kg.has(t) && isStrong(t));
      if (!shared.length) continue;
      let score = 0;
      for (const t of shared) score += Math.log((ms.length + 1) / ((df.get(t) ?? 0) + 1)) * (1 + Math.min(t.length, 8) / 4);
      if (score > bestScore) { bestScore = score; best = m; bestShared = shared; }
    }
    if (!best || !best.yuan) { unmatched.push(k.sku); continue; }
    // выбор карточки по цвету среди совпавших по тем же токенам
    const kColor = colorOf(k.name);
    let pick = best;
    if (kColor) {
      const same = ms.filter((m) => bestShared.every((t) => m.sig.has(t)));
      const byColor = same.find((m) => m.article.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(kColor));
      if (byColor && byColor.yuan) pick = byColor;
    }
    matched++;
    const cogs = Math.round(pick.yuan * fx);
    // вес и цена-за-кг — исходники доставки; саму доставку считаем = вес × $/кг × курс$
    const perKg = perKgNum(pick.perKg) || null;
    const weight = pick.weight > 0 ? pick.weight : null;
    const china = fxUsd > 0 && weight != null && perKg != null ? Math.round(weight * perKg * fxUsd) : null;
    if (china != null) withDelivery++;
    const res = await query(
      `INSERT INTO sku_costs (sku, cogs, cogs_yuan, weight, delivery_per_kg, china_delivery, packaging, updated_at)
       SELECT $1, $2, $3, $4, $5, $6, COALESCE((SELECT packaging FROM sku_costs WHERE sku = $1), 0), now()
       WHERE EXISTS (SELECT 1 FROM sku WHERE sku = $1)
       ON CONFLICT (sku) DO UPDATE SET cogs = EXCLUDED.cogs, cogs_yuan = EXCLUDED.cogs_yuan,
         weight = COALESCE(EXCLUDED.weight, sku_costs.weight),
         delivery_per_kg = COALESCE(EXCLUDED.delivery_per_kg, sku_costs.delivery_per_kg),
         china_delivery = COALESCE(EXCLUDED.china_delivery, sku_costs.china_delivery), updated_at = now()
       RETURNING sku`,
      [k.sku, cogs, pick.yuan, weight, perKg, china],
    );
    if (res.length) updated++;
  }

  console.log(`[ms-cost] ГОТОВО: сматчено ${matched}/${skus.length}, записано ${updated}, курс ¥ ${fx}, курс $ ${fxUsd || '— (доставка не считалась)'}`);
  if (fxUsd > 0) console.log(`[ms-cost] доставка из Китая посчитана у ${withDelivery} SKU (вес × $/кг × ${fxUsd})`);
  console.log(`[ms-cost] не сматчено: ${unmatched.length} (стёкла по модели iPhone, товары без названия и т.п.)`);
  return 0;
}

process.exitCode = await main();
await closePool();
