/**
 * Обогащение фото товаров. В Kaspi API картинок нет — берём с публичной
 * страницы товара (og:image) по коду мастер-товара.
 *   npx tsx src/scripts/enrichImages.ts
 * Для каждого SKU без image_url:
 *   offer → master code (через /orderentries/{id}/product) → публичная страница → og:image.
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

async function masterCode(orderCode: string, entryNumber: number): Promise<string | null> {
  const entryId = b64(`${orderCode}##${entryNumber}`);
  try {
    const r = await fetch(`${BASE}/v2/orderentries/${entryId}/product`, {
      headers: { 'X-Auth-Token': TOKEN, Accept: 'application/vnd.api+json' },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { attributes?: { code?: string } } };
    return j?.data?.attributes?.code ?? null;
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

const rows = await query<{ sku: string; order_code: string; entry_number: number }>(`
  SELECT s.sku, r.order_code, r.entry_number
  FROM sku s
  JOIN LATERAL (
    SELECT order_code, entry_number FROM orders_raw o WHERE o.sku = s.sku LIMIT 1
  ) r ON true
  WHERE s.image_url IS NULL
`);

console.log(`[enrich] товаров без фото: ${rows.length}`);
let ok = 0, fail = 0;
for (const row of rows) {
  const mc = await masterCode(row.order_code, row.entry_number);
  await sleep(180);
  if (!mc) { fail++; continue; }
  const img = await ogImage(mc);
  await sleep(250);
  if (img) {
    await query(`UPDATE sku SET master_code=$2, image_url=$3 WHERE sku=$1`, [row.sku, mc, img]);
    ok++;
  } else {
    await query(`UPDATE sku SET master_code=$2 WHERE sku=$1`, [row.sku, mc]);
    fail++;
  }
  if ((ok + fail) % 20 === 0) console.log(`[enrich] ${ok + fail}/${rows.length} (с фото: ${ok})`);
}
console.log(`[enrich] ГОТОВО: с фото ${ok}, без ${fail}`);
await closePool();
