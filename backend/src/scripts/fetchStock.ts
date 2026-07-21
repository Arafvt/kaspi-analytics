/**
 * Загрузка остатков товаров из кабинета продавца Kaspi.
 *   npx tsx src/scripts/fetchStock.ts
 *
 * Публичный Shop API остатки НЕ отдаёт: он про заказы, а остатки в Kaspi заливаются
 * XML-прайсом в одну сторону. Читаем их из приватного BFF кабинета:
 *   GET mc.shop.kaspi.kz/bff/offer-view/list?m={merchant}&p={page}&l=100&a=true
 *     → { data: [{ sku, title, availabilities:[{storeId, stockCount}], minPrice, ... }], total }
 *   a=true — товары в продаже (204 шт), a=false — архив (389).
 * Максимум 100 на страницу: l=200 отдаёт 400.
 *
 * Авторизация — кука кабинета (KASPI_MC_COOKIE), ОТДЕЛЬНАЯ от маркетинговой
 * (KASPI_MARKETING_SESSION) и с другим merchant id. Живёт недолго: при 401/403
 * выходим с кодом 2, как fetchAds, — sync-ads.ps1 это ловит.
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

const MERCHANT = process.env.KASPI_MC_MERCHANT_ID;
const COOKIE = process.env.KASPI_MC_COOKIE;
if (!MERCHANT || !COOKIE) {
  console.error('[stock] нет KASPI_MC_MERCHANT_ID / KASPI_MC_COOKIE в .env');
  process.exit(1);
}

const { query, closePool } = await import('../db/pool.js');

const BASE = 'https://mc.shop.kaspi.kz/bff/offer-view';
const PAGE = 100; // жёсткий предел BFF: l=200 → HTTP 400
const HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9',
  origin: 'https://kaspi.kz',
  referer: 'https://kaspi.kz/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'x-auth-version': '3',
  cookie: COOKIE,
};

interface Availability { storeId: string; stockCount: number; available: string }
interface Offer {
  sku: string;
  title: string | null;
  model: string | null;
  masterSku: string | null;
  available: boolean;
  minPrice: number | null;
  availabilities: Availability[] | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Код возврата ставим через process.exitCode и выходим НОРМАЛЬНО, дав пулу закрыться.
 * process.exit() поверх закрывающегося пула роняет libuv («Assertion failed ... async.c»),
 * и наружу уходит мусорный -1073740791 вместо 2 — sync-ads.ps1 тогда не видит,
 * что сессия протухла.
 */
async function main(): Promise<number> {
  const offers: Offer[] = [];
  let total = 0;

  for (let page = 0; page < 50; page++) {
    const url = `${BASE}/list?m=${MERCHANT}&p=${page}&l=${PAGE}&a=true`;
    let res: Response;
    try {
      res = await fetch(url, { headers: HEADERS });
    } catch (e) {
      console.error(`[stock] сеть: ${(e as Error).message}`);
      return 1;
    }
    if (res.status === 401 || res.status === 403) {
      console.error(`\n[stock] ${res.status} — сессия кабинета недействительна.`);
      console.error('[stock] Обнови KASPI_MC_COOKIE в .env (залогинься в кабинет, Copy as cURL) и запусти снова.');
      return 2;
    }
    if (!res.ok) {
      console.error(`[stock] страница ${page}: HTTP ${res.status}`);
      return 1;
    }

    const j = (await res.json()) as { data?: Offer[]; total?: number };
    const batch = j.data ?? [];
    total = j.total ?? total;
    offers.push(...batch);
    if (batch.length < PAGE) break;
    await sleep(250);
  }

  if (offers.length === 0) {
    console.error('[stock] кабинет вернул пустой список — проверь куку');
    return 1;
  }
  console.log(`[stock] товаров в продаже: ${offers.length}${total ? ` из ${total}` : ''}`);

  const startedAt = new Date().toISOString();
  let totalStock = 0, zero = 0;
  for (const o of offers) {
    const stores = (o.availabilities ?? []).filter((a) => a.stockCount != null);
    const stock = stores.reduce((s, a) => s + (a.stockCount || 0), 0);
    totalStock += stock;
    if (stock === 0) zero++;
    await query(
      `INSERT INTO sku_stock (sku, name, stock, price, available, master_code, stores, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name, stock = EXCLUDED.stock, price = EXCLUDED.price,
         available = EXCLUDED.available, master_code = EXCLUDED.master_code,
         stores = EXCLUDED.stores, updated_at = now()`,
      [o.sku, o.title ?? o.model ?? null, stock, o.minPrice ?? 0, o.available ?? true,
        o.masterSku ?? null, JSON.stringify(stores.map((a) => ({ storeId: a.storeId, stockCount: a.stockCount })))],
    );
  }

  // Товар пропал с витрины → его остаток больше не подтверждён этим прогоном.
  // Сравниваем со временем НАЧАЛА записи, а не с «минуту назад»: длинный прогон
  // иначе обнулил бы товары, которые сам же только что записал.
  const gone = await query<{ n: string }>(
    `UPDATE sku_stock SET stock = 0, available = false, updated_at = now()
      WHERE updated_at < $1 AND available = true
      RETURNING sku AS n`,
    [startedAt],
  );

  console.log(`[stock] ГОТОВО: остаток ${totalStock} шт, товаров без остатка ${zero}, снято с витрины ${gone.length}`);
  return 0;
}

process.exitCode = await main();
await closePool();
