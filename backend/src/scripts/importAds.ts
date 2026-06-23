/**
 * Импорт рекламных расходов из CSV-отчётов кабинета Kaspi Pay → Маркетинг.
 *   npx tsx src/scripts/importAds.ts [period_month=2026-06]
 * Берёт все файлы data/*Отчёт по товарам*.csv, суммирует «Расходы на рекламу»
 * по коду мастер-товара, привязывает к нашему SKU через sku.master_code,
 * заливает в ad_spend (sku, period_month, amount).
 */
import { readFileSync, readdirSync } from 'node:fs';
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

const DATA_DIR = join(here, '../../../data');
const PERIOD = process.argv[2] ?? '2026-06';
const num = (s: string): number => {
  const v = parseFloat((s ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};

const files = readdirSync(DATA_DIR).filter((f) => f.includes('Отчёт по товарам') && f.endsWith('.csv'));
console.log(`[ads] файлов по товарам: ${files.length}`);

interface AdAgg { spend: number; views: number; clicks: number; orders: number; }
const byMaster = new Map<string, AdAgg>();
let rowsTotal = 0;
for (const f of files) {
  const lines = readFileSync(join(DATA_DIR, f), 'utf8').split(/\r?\n/);
  const header = (lines[0] ?? '').replace(/^﻿/, '').split(';');
  const iSpend = header.indexOf('Расходы на рекламу');
  const iViews = header.indexOf('Просмотры');
  const iClicks = header.indexOf('Клики');
  const iOrders = header.indexOf('Все заказы');
  if (iSpend < 0) { console.log(`  ! пропуск ${f}: нет колонки "Расходы на рекламу"`); continue; }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split(';');
    const master = (cols[0] ?? '').trim();
    if (!master) continue;
    const a = byMaster.get(master) ?? { spend: 0, views: 0, clicks: 0, orders: 0 };
    a.spend += num(cols[iSpend] ?? '');
    a.views += iViews >= 0 ? num(cols[iViews] ?? '') : 0;
    a.clicks += iClicks >= 0 ? num(cols[iClicks] ?? '') : 0;
    a.orders += iOrders >= 0 ? num(cols[iOrders] ?? '') : 0;
    byMaster.set(master, a);
    rowsTotal++;
  }
}
console.log(`[ads] строк ${rowsTotal}, уникальных мастер-товаров ${byMaster.size}`);

const skuRows = await query<{ sku: string; master_code: string }>(
  `SELECT sku, master_code FROM sku WHERE master_code IS NOT NULL`,
);
const masterToSku = new Map(skuRows.map((r) => [r.master_code, r.sku]));

const bySku = new Map<string, AdAgg>();
let matched = 0, unmatched = 0, totalSpend = 0;
for (const [master, a] of byMaster) {
  const sku = masterToSku.get(master);
  if (!sku) { unmatched++; continue; }
  const cur = bySku.get(sku) ?? { spend: 0, views: 0, clicks: 0, orders: 0 };
  cur.spend += a.spend; cur.views += a.views; cur.clicks += a.clicks; cur.orders += a.orders;
  bySku.set(sku, cur);
  matched++;
  totalSpend += a.spend;
}
console.log(`[ads] привязано master→sku: ${matched}, не найдено: ${unmatched}, сумма рекламы ${Math.round(totalSpend)} ₸`);

// чистим рекламу этого периода и заливаем заново (идемпотентно)
await query(`DELETE FROM ad_spend WHERE period_month = $1`, [PERIOD]);
for (const [sku, a] of bySku) {
  await query(
    `INSERT INTO ad_spend (sku, period_month, amount, ad_views, ad_clicks, ad_orders)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sku, period_month) DO UPDATE SET
       amount = EXCLUDED.amount, ad_views = EXCLUDED.ad_views,
       ad_clicks = EXCLUDED.ad_clicks, ad_orders = EXCLUDED.ad_orders`,
    [sku, PERIOD, Math.round(a.spend), Math.round(a.views), Math.round(a.clicks), Math.round(a.orders)],
  );
}
console.log(`[ads] ГОТОВО: ad_spend по ${bySku.size} SKU за ${PERIOD}`);
await closePool();
