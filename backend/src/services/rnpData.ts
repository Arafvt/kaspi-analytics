/**
 * Адаптер БД → движок РНП → DTO для фронта.
 * Читает sales_daily + справочники, прогоняет через rnpDashboard и собирает
 * структуру в точности под frontend types/dashboard.ts (DashboardData).
 *
 * Косты пока могут быть пустыми → дефолты (комиссия 12%, налог 3%, COGS 0):
 * заказы/выкупы/штуки реальные из API, маржа/прибыль — ориентировочные, пока не введены косты.
 */
import { query } from '../db/pool.js';
import {
  buildProductRow, sumSets, forecastSet,
  type ProductInput, type MetricSet, type SkuPlan,
} from './rnpDashboard.js';
import { div, aggregateFacts, calcSkuMetrics, type DailyFact, type SkuCosts } from './rnpCalc.js';

// Стандартная комиссия Kaspi 2026 (предоплата) = 10,9%; рассрочка = 12,5%.
// Источник: офиц. PDF тарифов. Точные ставки по категориям — в кабинете продавца.
const DEF_COMMISSION = 0.109;
const DEF_TAX = 0.03;

interface SalesRow {
  sku: string; day: string;
  orders_sum: number; orders_qty: number;
  returns_sum: number; returns_qty: number;
  delivery_cost: number;
}

const emptyBlock = (): MetricSet => ({
  ordersSum: 0, ordersQty: 0, buyoutSum: 0, buyoutQty: 0, adSum: 0, drr: 0, profit: 0, margin: 0,
});

function monthContext(month: string): { daysInMonth: number; daysPassed: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Date();
  const cur = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const daysPassed = month === cur ? Math.min(now.getUTCDate(), daysInMonth) : daysInMonth;
  return { daysInMonth, daysPassed };
}

/** Топ-таблица «План дня vs динамика»: 8 метрик, агрегат по дням. */
function buildDailyMetrics(products: { daily: MetricSet[] }[], days: string[]) {
  const defs = [
    { key: 'ordersSum', label: 'Заказы ₸', format: 'money', higherIsBetter: true, field: 'ordersSum' as const, ratio: false },
    { key: 'ordersQty', label: 'Заказы шт', format: 'qty', higherIsBetter: true, field: 'ordersQty' as const, ratio: false },
    { key: 'buyoutSum', label: 'Выкупы ₸', format: 'money', higherIsBetter: true, field: 'buyoutSum' as const, ratio: false },
    { key: 'buyoutQty', label: 'Выкупы шт', format: 'qty', higherIsBetter: true, field: 'buyoutQty' as const, ratio: false },
    { key: 'adSum', label: 'Реклама ₸', format: 'money', higherIsBetter: true, field: 'adSum' as const, ratio: false },
    { key: 'drr', label: 'ДРР %', format: 'pct', higherIsBetter: false, field: 'drr' as const, ratio: true },
    { key: 'profit', label: 'Прибыль ₸', format: 'money', higherIsBetter: true, field: 'profit' as const, ratio: false },
    { key: 'margin', label: 'Маржа %', format: 'pct', higherIsBetter: true, field: 'margin' as const, ratio: true },
  ];
  return defs.map((d) => {
    const values = days.map((_, i) => {
      if (!d.ratio) return products.reduce((s, p) => s + (p.daily[i]?.[d.field] ?? 0), 0);
      // относительные пересчитываем из сумм за день
      if (d.field === 'drr') {
        const ad = products.reduce((s, p) => s + (p.daily[i]?.adSum ?? 0), 0);
        const ord = products.reduce((s, p) => s + (p.daily[i]?.ordersSum ?? 0), 0);
        return div(ad, ord);
      }
      const prof = products.reduce((s, p) => s + (p.daily[i]?.profit ?? 0), 0);
      const buy = products.reduce((s, p) => s + (p.daily[i]?.buyoutSum ?? 0), 0);
      return div(prof, buy);
    });
    const planDay = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return { key: d.key, label: d.label, format: d.format, higherIsBetter: d.higherIsBetter, planDay, values };
  });
}

export async function getDashboard(month: string) {
  const ctx = monthContext(month);

  const sales = await query<SalesRow>(
    `SELECT sku, to_char(day,'YYYY-MM-DD') AS day,
            orders_sum, orders_qty, returns_sum, returns_qty, delivery_cost
       FROM sales_daily
      WHERE to_char(day,'YYYY-MM') = $1
      ORDER BY day`,
    [month],
  );

  if (sales.length === 0) {
    return { month, days: [], summary: { plan: emptyBlock(), forecast: emptyBlock(), fact: emptyBlock() }, daily: [], products: [] };
  }

  const days = [...new Set(sales.map((r) => r.day))].sort();

  const skuMeta = new Map(
    (await query<{ sku: string; name: string; category_code: string; image_url: string | null }>(
      `SELECT sku, name, category_code, image_url FROM sku`,
    )).map((r) => [r.sku, r]),
  );
  const costMap = new Map(
    (await query<{ sku: string; cogs: number; packaging: number; china_delivery: number | null }>(
      `SELECT sku, cogs, packaging, china_delivery FROM sku_costs`,
    )).map((r) => [r.sku, r]),
  );
  const commMap = new Map(
    (await query<{ category_code: string; rate: number }>(`SELECT category_code, rate FROM category_commission`))
      .map((r) => [r.category_code, r.rate]),
  );
  const adMap = new Map(
    (await query<{ sku: string; amount: number }>(`SELECT sku, amount FROM ad_spend WHERE period_month = $1`, [month]))
      .map((r) => [r.sku, r.amount]),
  );
  const taxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'tax_rate'`);
  const taxRate = taxRows[0] ? Number(taxRows[0].value) : DEF_TAX;
  const planMap = new Map(
    (await query<{ sku: string; plan_sum: number; plan_qty: number; target_drr: number; plan_profit: number }>(
      `SELECT sku, plan_sum, plan_qty, target_drr, plan_profit FROM sales_plan WHERE period_month = $1`, [month],
    )).map((r) => [r.sku, r]),
  );

  const bySku = new Map<string, SalesRow[]>();
  for (const r of sales) {
    const arr = bySku.get(r.sku) ?? [];
    arr.push(r);
    bySku.set(r.sku, arr);
  }

  const noPlan: SkuPlan = { ordersSum: 0, ordersQty: 0, buyoutSum: 0, buyoutQty: 0, adSum: 0, profit: 0 };
  // план из sales_plan → SkuPlan движка (выкуп ≈ заказы, реклама = план×целевой ДРР)
  const toPlan = (sku: string): SkuPlan => {
    const p = planMap.get(sku);
    if (!p) return noPlan;
    const sum = Number(p.plan_sum) || 0;
    const qty = Number(p.plan_qty) || 0;
    return { ordersSum: sum, ordersQty: qty, buyoutSum: sum, buyoutQty: qty, adSum: Math.round(sum * (Number(p.target_drr) || 0)), profit: Number(p.plan_profit) || 0 };
  };

  const products = [...bySku.entries()].map(([sku, rows]) => {
    const meta = skuMeta.get(sku);
    const cost = costMap.get(sku);
    const catRate = meta?.category_code ? commMap.get(meta.category_code) : undefined;
    const costs: SkuCosts = {
      cogs: (cost?.cogs ?? 0) + (cost?.china_delivery ?? 0), // себест с доставкой из Китая
      packaging: cost?.packaging ?? 0,
      commissionRate: catRate ?? DEF_COMMISSION,
      taxRate,
      adSpend: adMap.get(sku) ?? 0,
    };
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const daily: DailyFact[] = days.map((d) => {
      const r = byDay.get(d);
      return {
        day: d,
        ordersSum: r?.orders_sum ?? 0, ordersQty: r?.orders_qty ?? 0,
        returnsSum: r?.returns_sum ?? 0, returnsQty: r?.returns_qty ?? 0,
        deliveryCost: r?.delivery_cost ?? 0,
      };
    });
    const input: ProductInput = {
      sku, name: meta?.name ?? sku, article: meta?.category_code ?? '', price: 0, daily, costs, plan: toPlan(sku),
    };
    const row = buildProductRow(input, ctx);
    const f = row.factMonth;
    const price = f.buyoutQty > 0 ? Math.round(f.buyoutSum / f.buyoutQty) : 0;
    const returnPct = f.ordersSum > 0 ? (f.ordersSum - f.buyoutSum) / f.ordersSum : 0;
    const buyoutPct = f.ordersQty > 0 ? f.buyoutQty / f.ordersQty : 0;

    return {
      sku,
      name: row.name,
      article: meta?.category_code ?? '',
      price,
      seller: '',
      image: meta?.image_url ?? '',
      ordersQty: f.ordersQty,
      revenue: f.ordersSum,
      marginNoAds: row.marginNoAds,
      marginWAds: row.marginWAds,
      stock: { stock: 0, daysLeft: 0, returnPct, buyoutPct, drr: f.drr },
      planDay: row.planDay,
      planMonth: row.planMonth,
      forecastMonth: row.forecastMonth,
      factMonth: row.factMonth,
      spark: row.daily.map((d) => d.buyoutSum),
      daily: row.daily,
    };
  });

  const fact = sumSets(products.map((p) => p.factMonth));
  const plan = sumSets(products.map((p) => p.planMonth));
  const forecast = forecastSet(fact, ctx);
  const daily = buildDailyMetrics(products, days);

  return { month, days, summary: { plan, forecast, fact }, daily, products };
}

// ── UNIT: юнит-экономика с полной разбивкой расходов ──────────
export interface UnitItem {
  sku: string;
  name: string;
  image: string;
  category: string;
  revenue: number;
  units: number;
  returnPct: number;
  commission: number;
  delivery: number;
  tax: number;
  cogsTotal: number;     // себест С доставкой Китая (= себест без дост + доставка Китай) × выкуп
  adSpend: number;
  marginNoAds: number;
  drr: number;
  marginWAds: number;
  krr: number;
  profit: number;
  roi: number;
  payout: number;
  // рекламные метрики (только по рекламируемым товарам)
  adViews: number;
  adClicks: number;
  ctr: number;        // клики / показы
  conversion: number; // заказы с рекламы / клики
  cogsYuan: number;   // закуп в юанях (за единицу)
  fxRate: number;     // курс ¥→₸ (глобальный)
  cogsNoDeliv: number;    // себест БЕЗ доставки (закуп×курс) × выкуп
  chinaDelivery: number;  // доставка из Китая × выкуп (всего)
  chinaPerUnit: number;   // доставка из Китая за 1 шт, ₸ (редактируемое)
}

export async function getUnit(month: string): Promise<{ period: string; items: UnitItem[] }> {
  const sales = await query<SalesRow>(
    `SELECT sku, to_char(day,'YYYY-MM-DD') AS day, orders_sum, orders_qty, returns_sum, returns_qty, delivery_cost
       FROM sales_daily WHERE to_char(day,'YYYY-MM') = $1`,
    [month],
  );
  if (sales.length === 0) return { period: month, items: [] };

  const skuMeta = new Map(
    (await query<{ sku: string; name: string; category_code: string; image_url: string | null }>(
      `SELECT sku, name, category_code, image_url FROM sku`,
    )).map((r) => [r.sku, r]),
  );
  const costMap = new Map(
    (await query<{ sku: string; cogs: number; packaging: number; cogs_yuan: number | null; china_delivery: number | null }>(
      `SELECT sku, cogs, packaging, cogs_yuan, china_delivery FROM sku_costs`,
    )).map((r) => [r.sku, r]),
  );
  const commMap = new Map(
    (await query<{ category_code: string; rate: number }>(`SELECT category_code, rate FROM category_commission`))
      .map((r) => [r.category_code, r.rate]),
  );
  const adMap = new Map(
    (await query<{ sku: string; amount: number; ad_views: number; ad_clicks: number; ad_orders: number }>(
      `SELECT sku, amount, ad_views, ad_clicks, ad_orders FROM ad_spend WHERE period_month = $1`, [month],
    )).map((r) => [r.sku, r]),
  );
  const taxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'tax_rate'`);
  const taxRate = taxRows[0] ? Number(taxRows[0].value) : DEF_TAX;
  const fxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_cny'`);
  const fxRate = fxRows[0] ? Number(fxRows[0].value) : 78;

  const bySku = new Map<string, SalesRow[]>();
  for (const r of sales) {
    const arr = bySku.get(r.sku) ?? [];
    arr.push(r);
    bySku.set(r.sku, arr);
  }

  const items: UnitItem[] = [...bySku.entries()].map(([sku, rows]) => {
    const meta = skuMeta.get(sku);
    const cost = costMap.get(sku);
    const ad = adMap.get(sku);
    const catRate = meta?.category_code ? commMap.get(meta.category_code) : undefined;
    const baseCogs = cost?.cogs ?? 0;            // себест без доставки, ₸/шт
    const chinaPerUnit = cost?.china_delivery ?? 0; // доставка из Китая, ₸/шт
    const costs: SkuCosts = {
      cogs: baseCogs + chinaPerUnit,             // полная себест (с доставкой Китая)
      packaging: cost?.packaging ?? 0,
      commissionRate: catRate ?? DEF_COMMISSION,
      taxRate,
      adSpend: ad?.amount ?? 0,
    };
    const facts: DailyFact[] = rows.map((r) => ({
      day: r.day,
      ordersSum: r.orders_sum, ordersQty: r.orders_qty,
      returnsSum: r.returns_sum, returnsQty: r.returns_qty,
      deliveryCost: r.delivery_cost,
    }));
    const m = calcSkuMetrics(aggregateFacts(facts), costs);
    const views = ad?.ad_views ?? 0;
    const clicks = ad?.ad_clicks ?? 0;
    const adOrders = ad?.ad_orders ?? 0;
    return {
      sku,
      name: meta?.name ?? sku,
      image: meta?.image_url ?? '',
      category: meta?.category_code ?? '—',
      revenue: m.ordersSum,
      units: m.ordersQty,
      returnPct: m.returnPct,
      commission: m.commission,
      delivery: m.delivery,
      tax: m.tax,
      cogsTotal: m.cogsTotal, // = (себест без дост + доставка Китай) × выкуп
      adSpend: m.adSpend,
      marginNoAds: m.marginWithoutAdv,
      drr: m.drr,
      marginWAds: m.marginWithAdv,
      krr: m.krr,
      profit: m.profitWithAdv,
      roi: m.roi,
      payout: m.buyoutSum - m.commission - m.delivery,
      adViews: views,
      adClicks: clicks,
      ctr: div(clicks, views),
      conversion: div(adOrders, clicks),
      cogsYuan: cost?.cogs_yuan ?? 0,
      fxRate,
      cogsNoDeliv: baseCogs * m.buyoutQty,
      chinaDelivery: chinaPerUnit * m.buyoutQty,
      chinaPerUnit,
    };
  }).sort((a, b) => b.revenue - a.revenue);

  return { period: month, items };
}

// ── PLAN: план/факт по SKU за месяц ───────────────────────────
export interface PlanItem {
  sku: string;
  name: string;
  image: string;
  category: string;
  planSum: number;
  factSum: number;
  planQty: number;
  factQty: number;
  targetDrr: number;
  planProfit: number;   // план прибыли ₸ (ручной)
  planMargin: number;   // план маржи (= planProfit / planSum), доля
  marginWAds: number;   // факт маржи с ДРР
  profit: number;       // факт прибыли с ДРР
  approved: boolean;
}

export async function getPlan(month: string): Promise<{ month: string; items: PlanItem[] }> {
  const sales = await query<SalesRow>(
    `SELECT sku, to_char(day,'YYYY-MM-DD') AS day, orders_sum, orders_qty, returns_sum, returns_qty, delivery_cost
       FROM sales_daily WHERE to_char(day,'YYYY-MM') = $1`,
    [month],
  );
  const plans = await query<{ sku: string; plan_sum: number; plan_qty: number; target_drr: number; plan_profit: number; approved: boolean }>(
    `SELECT sku, plan_sum, plan_qty, target_drr, plan_profit, approved FROM sales_plan WHERE period_month = $1`,
    [month],
  );

  const skuMeta = new Map(
    (await query<{ sku: string; name: string; category_code: string; image_url: string | null }>(
      `SELECT sku, name, category_code, image_url FROM sku`,
    )).map((r) => [r.sku, r]),
  );
  const costMap = new Map(
    (await query<{ sku: string; cogs: number; packaging: number; china_delivery: number | null }>(
      `SELECT sku, cogs, packaging, china_delivery FROM sku_costs`,
    )).map((r) => [r.sku, r]),
  );
  const commMap = new Map(
    (await query<{ category_code: string; rate: number }>(`SELECT category_code, rate FROM category_commission`))
      .map((r) => [r.category_code, r.rate]),
  );
  const adMap = new Map(
    (await query<{ sku: string; amount: number }>(`SELECT sku, amount FROM ad_spend WHERE period_month = $1`, [month]))
      .map((r) => [r.sku, r.amount]),
  );
  const taxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'tax_rate'`);
  const taxRate = taxRows[0] ? Number(taxRows[0].value) : DEF_TAX;
  const planMap = new Map(plans.map((p) => [p.sku, p]));

  const bySku = new Map<string, SalesRow[]>();
  for (const r of sales) {
    const arr = bySku.get(r.sku) ?? [];
    arr.push(r);
    bySku.set(r.sku, arr);
  }

  // SKU = у кого есть факт ∪ у кого задан план
  const allSkus = new Set<string>([...bySku.keys(), ...planMap.keys()]);

  const items: PlanItem[] = [...allSkus].map((sku) => {
    const meta = skuMeta.get(sku);
    const cost = costMap.get(sku);
    const catRate = meta?.category_code ? commMap.get(meta.category_code) : undefined;
    const costs: SkuCosts = {
      cogs: (cost?.cogs ?? 0) + (cost?.china_delivery ?? 0),
      packaging: cost?.packaging ?? 0,
      commissionRate: catRate ?? DEF_COMMISSION,
      taxRate,
      adSpend: adMap.get(sku) ?? 0,
    };
    const facts: DailyFact[] = (bySku.get(sku) ?? []).map((r) => ({
      day: r.day,
      ordersSum: r.orders_sum, ordersQty: r.orders_qty,
      returnsSum: r.returns_sum, returnsQty: r.returns_qty,
      deliveryCost: r.delivery_cost,
    }));
    const m = calcSkuMetrics(aggregateFacts(facts), costs);
    const pl = planMap.get(sku);
    const planSum = Number(pl?.plan_sum) || 0;
    const planProfit = Number(pl?.plan_profit) || 0;
    return {
      sku,
      name: meta?.name ?? sku,
      image: meta?.image_url ?? '',
      category: meta?.category_code ?? '—',
      planSum,
      factSum: m.ordersSum,
      planQty: Number(pl?.plan_qty) || 0,
      factQty: m.ordersQty,
      targetDrr: Number(pl?.target_drr) || 0,
      planProfit,
      planMargin: planSum > 0 ? planProfit / planSum : 0,
      marginWAds: m.marginWithAdv,
      profit: m.profitWithAdv,
      approved: pl?.approved ?? false,
    };
  }).sort((a, b) => b.factSum - a.factSum || b.planSum - a.planSum);

  return { month, items };
}

/** Сохранить план по SKU за месяц (UPSERT). */
export async function savePlan(b: {
  sku: string; month: string; planSum?: number; planQty?: number; targetDrr?: number; planProfit?: number; approved?: boolean;
}): Promise<{ ok: boolean }> {
  await query(
    `INSERT INTO sales_plan (sku, period_month, plan_sum, plan_qty, target_drr, plan_profit, approved)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (sku, period_month) DO UPDATE SET
       plan_sum = EXCLUDED.plan_sum, plan_qty = EXCLUDED.plan_qty,
       target_drr = EXCLUDED.target_drr, plan_profit = EXCLUDED.plan_profit, approved = EXCLUDED.approved`,
    [b.sku, b.month, Math.round(Number(b.planSum) || 0), Math.round(Number(b.planQty) || 0),
      Number(b.targetDrr) || 0, Math.round(Number(b.planProfit) || 0), b.approved ?? false],
  );
  return { ok: true };
}
