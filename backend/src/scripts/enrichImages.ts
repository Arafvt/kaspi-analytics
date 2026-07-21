/**
 * Обогащение справочника товаров из мастер-товара Kaspi.
 *   npx tsx src/scripts/enrichImages.ts
 * Для каждого SKU без image_url ИЛИ без имени:
 *   offer → /orderentries/{id}/product (даёт master code + имя) → публичная страница → og:image.
 *
 * Зачем нужен, помимо фото:
 *  • master_code — по нему importAds привязывает рекламу к товару; без него расход
 *    товара молча теряется, поэтому скрипт вызывается из sync-ads.ps1 ПЕРЕД импортом;
 *  • name — Kaspi отдаёт пустой offer.name у части позиций (держатель F162, мыши M44/m64/m76,
 *    наушники FB56/Faiz 70, часы ONYX 8PRO, колонка Fk300). В мастер-товаре имя есть.
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

const { query, closePool } = await import('../db/pool.js');
const { config } = await import('../config/env.js');

const TOKEN = config.kaspi.token;
const BASE = config.kaspi.base;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface Master { code: string; name: string | null; }

/** Мастер-товар позиции заказа: код (для рекламы) и имя (когда offer.name пуст). */
async function masterProduct(orderCode: string, entryNumber: number): Promise<Master | null> {
  const entryId = b64(`${orderCode}##${entryNumber}`);
  try {
    const r = await fetch(`${BASE}/v2/orderentries/${entryId}/product`, {
      headers: { 'X-Auth-Token': TOKEN, Accept: 'application/vnd.api+json' },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { attributes?: { code?: string; name?: string } } };
    const a = j?.data?.attributes;
    if (!a?.code) return null;
    return { code: a.code, name: a.name?.trim() || null };
  } catch {
    return null;
  }
}

async function ogImage(masterCodeVal: string): Promise<string | null> {
  try {
    const r = await fetch(`https://kaspi.kz/shop/p/-${masterCodeVal}/`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<meta property="og:image" content="([^"]+)"/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// Берём и тех, у кого нет фото, и тех, у кого пустое имя (это разные дыры).
const rows = await query<{ sku: string; order_code: string; entry_number: number }>(`
  SELECT s.sku, r.order_code, r.entry_number
  FROM sku s
  JOIN LATERAL (
    SELECT order_code, entry_number FROM orders_raw o WHERE o.sku = s.sku LIMIT 1
  ) r ON true
  WHERE s.image_url IS NULL OR s.master_code IS NULL OR s.name IS NULL OR trim(s.name) = ''
`);

console.log(`[enrich] товаров к обогащению: ${rows.length}`);
let ok = 0, fail = 0, named = 0;
for (const row of rows) {
  const m = await masterProduct(row.order_code, row.entry_number);
  await sleep(180);
  if (!m) { fail++; continue; }
  const img = await ogImage(m.code);
  await sleep(250);
  // COALESCE(NULLIF(...)) — имя из заказа приоритетнее: имя мастер-товара
  // подставляем, только если своего нет. Фото и master_code обновляем всегда.
  const r = await query<{ named: boolean }>(
    `UPDATE sku
        SET master_code = $2::text,
            image_url   = COALESCE($3::text, image_url),
            name        = COALESCE(NULLIF(trim(name), ''), $4::text)
      WHERE sku = $1::text
      RETURNING (NULLIF(trim(name), '') IS NOT NULL AND $4::text IS NOT NULL) AS named`,
    [row.sku, m.code, img, m.name],
  );
  if (r[0]?.named) named++;
  if (img) ok++; else fail++;
  if ((ok + fail) % 20 === 0) console.log(`[enrich] ${ok + fail}/${rows.length} (с фото: ${ok})`);
}
console.log(`[enrich] ГОТОВО: с фото ${ok}, без ${fail}, восстановлено имён ${named}`);
await closePool();
