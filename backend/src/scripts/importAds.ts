/**
 * Импорт рекламных расходов из CSV-отчётов кабинета Kaspi Pay → Маркетинг.
 *   npx tsx src/scripts/importAds.ts
 * Берёт все файлы data/*Отчёт по товарам*.csv, суммирует «Расходы на рекламу»
 * по коду мастер-товара, привязывает к нашему SKU через sku.master_code,
 * заливает в ad_spend.
 *
 * Период берётся из имени каждого файла отдельно, поэтому дневные и недельные
 * отчёты могут лежать в data/ вместе. Дневной отчёт («2026-07-08 - 2026-07-08»)
 * кладёт всю сумму на один день — из таких строк и складывается дневной ДРР.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const num = (s: string): number => {
  const v = parseFloat((s ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : 0;
};

interface AdAgg { spend: number; views: number; clicks: number; orders: number; }

const files = readdirSync(DATA_DIR).filter((f) => f.includes('Отчёт по товарам') && f.endsWith('.csv'));
console.log(`[ads] файлов по товарам: ${files.length}`);

/**
 * Дедуп повторных скачиваний: один и тот же отчёт, сохранённый как "(4)" и "(5)",
 * иначе сложился бы дважды и удвоил расходы. Считаем по содержимому, а не по
 * мастер-коду — один товар может честно рекламироваться в двух РАЗНЫХ кампаниях
 * за тот же период, и такие строки надо суммировать.
 *
 * Ключ включает период: одинаковое содержимое под разными датами — это разные
 * отчёты (или опечатка в имени), терять их молча нельзя.
 */
const seenHashes = new Map<string, string>(); // period+sha256 → первый файл с таким содержимым

/** Отчёты, сгруппированные по периоду: "start..end" → мастер-код → метрики. */
const periods = new Map<string, { start: string; end: string; byMaster: Map<string, AdAgg> }>();
let rowsTotal = 0, dupSkipped = 0;

for (const f of files) {
  const content = readFileSync(join(DATA_DIR, f), 'utf8');

  // Период берём из имени КАЖДОГО файла: "2026-07-08 - 2026-07-08 Отчёт по товарам.csv".
  // Дневной отчёт (start === end) кладёт всю сумму на один день — так считается дневной ДРР.
  const m = f.match(/(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
  if (!m?.[1] || !m[2]) { console.log(`  ! пропуск ${f}: в имени нет периода "YYYY-MM-DD - YYYY-MM-DD"`); continue; }
  const [, start, end] = m;

  const hash = `${start}..${end}:${createHash('sha256').update(content).digest('hex')}`;
  const twin = seenHashes.get(hash);
  if (twin) { console.log(`  ~ дубль ${f} — копия "${twin}", пропуск`); dupSkipped++; continue; }
  seenHashes.set(hash, f);

  const lines = content.split(/\r?\n/);
  const header = (lines[0] ?? '').replace(/^﻿+/, '').split(';');
  const iSpend = header.indexOf('Расходы на рекламу');
  const iViews = header.indexOf('Просмотры');
  const iClicks = header.indexOf('Клики');
  const iOrders = header.indexOf('Все заказы');
  if (iSpend < 0) { console.log(`  ! пропуск ${f}: нет колонки "Расходы на рекламу"`); continue; }

  const key = `${start}..${end}`;
  const per = periods.get(key) ?? { start, end, byMaster: new Map<string, AdAgg>() };
  periods.set(key, per);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split(';');
    const master = (cols[0] ?? '').trim();
    if (!master) continue;
    const a = per.byMaster.get(master) ?? { spend: 0, views: 0, clicks: 0, orders: 0 };
    a.spend += num(cols[iSpend] ?? '');
    a.views += iViews >= 0 ? num(cols[iViews] ?? '') : 0;
    a.clicks += iClicks >= 0 ? num(cols[iClicks] ?? '') : 0;
    a.orders += iOrders >= 0 ? num(cols[iOrders] ?? '') : 0;
    per.byMaster.set(master, a);
    rowsTotal++;
  }
}
console.log(`[ads] строк ${rowsTotal}, периодов ${periods.size}, дублей пропущено ${dupSkipped}`);

/**
 * PK (sku, period_start): два отчёта с одинаковой датой начала (недельный 06-09 и
 * дневной 06-09) затёрли бы друг друга. Ловим до записи, а не после.
 */
const byStart = new Map<string, string>();
for (const { start, end } of periods.values()) {
  const clash = byStart.get(start);
  if (clash) {
    console.error(`[ads] ОШИБКА: периоды "${clash}" и "${start}..${end}" начинаются в один день — они перезапишут друг друга.`);
    console.error('[ads] Оставь в data/ только непересекающиеся отчёты (или только дневные, или только недельные).');
    process.exit(1);
  }
  byStart.set(start, `${start}..${end}`);
}

const skuRows = await query<{ sku: string; master_code: string }>(
  `SELECT sku, master_code FROM sku WHERE master_code IS NOT NULL`,
);
const masterToSku = new Map(skuRows.map((r) => [r.master_code, r.sku]));

for (const { start, end, byMaster } of [...periods.values()].sort((a, b) => a.start.localeCompare(b.start))) {
  const periodMonth = start.slice(0, 7);
  const bySku = new Map<string, AdAgg>();
  let matched = 0, unmatched = 0, totalSpend = 0;
  // Считаем не только ЧИСЛО непривязанных мастеров, но и их СУММУ: мастер без
  // расхода — безобидный шум, а мастер с деньгами означает, что реклама пропала
  // из отчётности. По одному счётчику это неразличимо.
  let lostSpend = 0;
  const lostTop: Array<{ master: string; spend: number }> = [];

  for (const [master, a] of byMaster) {
    const sku = masterToSku.get(master);
    if (!sku) {
      unmatched++;
      lostSpend += a.spend;
      if (a.spend > 0) lostTop.push({ master, spend: a.spend });
      continue;
    }
    const cur = bySku.get(sku) ?? { spend: 0, views: 0, clicks: 0, orders: 0 };
    cur.spend += a.spend; cur.views += a.views; cur.clicks += a.clicks; cur.orders += a.orders;
    bySku.set(sku, cur);
    matched++;
    totalSpend += a.spend;
  }

  // чистим рекламу этого периода и заливаем заново (идемпотентно)
  await query(`DELETE FROM ad_spend WHERE period_start = $1`, [start]);
  for (const [sku, a] of bySku) {
    await query(
      `INSERT INTO ad_spend (sku, period_start, period_end, period_month, amount, ad_views, ad_clicks, ad_orders)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (sku, period_start) DO UPDATE SET
         period_end = EXCLUDED.period_end, period_month = EXCLUDED.period_month,
         amount = EXCLUDED.amount, ad_views = EXCLUDED.ad_views,
         ad_clicks = EXCLUDED.ad_clicks, ad_orders = EXCLUDED.ad_orders`,
      [sku, start, end, periodMonth, Math.round(a.spend), Math.round(a.views), Math.round(a.clicks), Math.round(a.orders)],
    );
  }
  const kind = start === end ? 'день' : 'период';
  console.log(`[ads] ${kind} ${start}${start === end ? '' : ` … ${end}`}: SKU ${bySku.size}, реклама ${Math.round(totalSpend)} ₸, не сматчено мастеров ${unmatched} (на ${Math.round(lostSpend)} ₸)`);
  if (lostSpend > 0) {
    lostTop.sort((a, b) => b.spend - a.spend);
    for (const l of lostTop.slice(0, 5)) console.log(`     потеря: мастер ${l.master} — ${Math.round(l.spend)} ₸ (нет в таблице sku)`);
    console.log('     починка: npx tsx src/scripts/enrichImages.ts (проставит master_code), затем импорт заново');
  }
}
console.log('[ads] ГОТОВО');
await closePool();
