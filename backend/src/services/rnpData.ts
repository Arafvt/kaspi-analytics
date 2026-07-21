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

// Комиссия Kaspi 2026 с НДС 16% (с 05.01.2026): электроника 12,5%, аксессуары 15,5%.
// Точные ставки по категориям — в category_commission; здесь дефолт для категорий без ставки.
const DEF_COMMISSION = 0.125;
const DEF_TAX = 0.03;
// Окно для «хватит N дней»: неделя сглаживает выходные, но ещё ловит свежий тренд.
const STOCK_WINDOW_DAYS = 7;
// Надбавка за рассрочку в Магазине (повышенная «комиссия за продажу в рассрочку» Kaspi),
// доля от выручки по сроку. Точные ставки — в договоре/кабинете; правятся в настройках (settings).
const DEFAULT_CREDIT_UPLIFT: Record<string, number> = { '3': 0.0075, '6': 0.025, '12': 0.05, '24': 0.07 };

/** Ставки надбавки за рассрочку по сроку: из settings (credit_uplift_3/6/12/24), иначе дефолт. */
export async function loadUpliftRates(): Promise<Record<string, number>> {
  const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key LIKE 'credit_uplift_%'`);
  const rates: Record<string, number> = { ...DEFAULT_CREDIT_UPLIFT };
  for (const r of rows) {
    const term = r.key.replace('credit_uplift_', '');
    const v = Number(r.value);
    if (Number.isFinite(v) && v >= 0) rates[term] = v;
  }
  return rates;
}

/** Надбавка за рассрочку (₸) + доля рассрочки по SKU за месяц (из raw, только выкупленные). */
async function creditBySku(month: string): Promise<Map<string, { uplift: number; creditSum: number; totalSum: number }>> {
  const rates = await loadUpliftRates();
  const rows = await query<{ sku: string; term: string | null; s: number }>(
    `SELECT sku,
            CASE WHEN raw->>'paymentMode' = 'PAY_WITH_CREDIT' THEN raw->>'creditTerm' END AS term,
            SUM(sum) AS s
       FROM orders_raw
      WHERE to_char(day,'YYYY-MM') = $1 AND status NOT IN ('CANCELLED','CANCELLING','RETURNED')
      GROUP BY sku, term`,
    [month],
  );
  const map = new Map<string, { uplift: number; creditSum: number; totalSum: number }>();
  for (const r of rows) {
    const e = map.get(r.sku) ?? { uplift: 0, creditSum: 0, totalSum: 0 };
    const s = Number(r.s) || 0;
    e.totalSum += s;
    if (r.term) { e.creditSum += s; e.uplift += s * (rates[r.term] ?? 0); }
    map.set(r.sku, e);
  }
  return map;
}

interface SalesRow {
  sku: string; day: string;
  orders_sum: number; orders_qty: number;
  cancels_sum: number; cancels_qty: number;
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
            orders_sum, orders_qty, cancels_sum, cancels_qty, returns_sum, returns_qty, delivery_cost
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
  // рекламные периоды по SKU (привязка к датам отчёта) — для распределения по дням
  const adRows = await query<{ sku: string; ps: string; pe: string; amount: number }>(
    `SELECT sku, to_char(period_start,'YYYY-MM-DD') AS ps, to_char(period_end,'YYYY-MM-DD') AS pe, amount
       FROM ad_spend WHERE period_month = $1`, [month],
  );
  const adPeriods = new Map<string, { ps: string; pe: string; amount: number }[]>();
  for (const r of adRows) {
    const arr = adPeriods.get(r.sku) ?? [];
    arr.push({ ps: r.ps, pe: r.pe, amount: Number(r.amount) || 0 });
    adPeriods.set(r.sku, arr);
  }
  // Остатки с витрины (кабинет продавца) — в публичном API их нет, кладёт fetchStock.
  const stockMap = new Map(
    (await query<{ sku: string; stock: number }>(`SELECT sku, stock FROM sku_stock`))
      .map((r) => [r.sku, Number(r.stock) || 0]),
  );
  const taxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'tax_rate'`);
  const taxRate = taxRows[0] ? Number(taxRows[0].value) : DEF_TAX;
  const planMap = new Map(
    (await query<{ sku: string; plan_sum: number; plan_qty: number; target_drr: number; plan_profit: number }>(
      `SELECT sku, plan_sum, plan_qty, target_drr, plan_profit FROM sales_plan WHERE period_month = $1`, [month],
    )).map((r) => [r.sku, r]),
  );
  const creditMap = await creditBySku(month);

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
    const byDay = new Map(rows.map((r) => [r.day, r]));
    // реклама по дням: сумму каждого периода распределяем по его дням пропорц. выручке дня
    const periods = adPeriods.get(sku) ?? [];
    const adByDay: Record<string, number> = {};
    for (const per of periods) {
      const pDays = days.filter((d) => d >= per.ps && d <= per.pe);
      const pRev = pDays.reduce((s, d) => s + (byDay.get(d)?.orders_sum ?? 0), 0);
      for (const d of pDays) {
        const rev = byDay.get(d)?.orders_sum ?? 0;
        adByDay[d] = (adByDay[d] ?? 0) + (pRev > 0 ? per.amount * (rev / pRev) : per.amount / (pDays.length || 1));
      }
    }
    const monthAd = periods.reduce((s, p) => s + p.amount, 0);
    const costs: SkuCosts = {
      cogs: (cost?.cogs ?? 0) + (cost?.china_delivery ?? 0), // себест с доставкой из Китая
      packaging: cost?.packaging ?? 0,
      commissionRate: catRate ?? DEF_COMMISSION,
      taxRate,
      adSpend: monthAd,
      creditUplift: creditMap.get(sku)?.uplift ?? 0,
    };
    const daily: DailyFact[] = days.map((d) => {
      const r = byDay.get(d);
      return {
        day: d,
        ordersSum: r?.orders_sum ?? 0, ordersQty: r?.orders_qty ?? 0,
        cancelsSum: r?.cancels_sum ?? 0, cancelsQty: r?.cancels_qty ?? 0,
        returnsSum: r?.returns_sum ?? 0, returnsQty: r?.returns_qty ?? 0,
        deliveryCost: r?.delivery_cost ?? 0,
      };
    });
    const input: ProductInput = {
      sku, name: meta?.name ?? sku, article: meta?.category_code ?? '', price: 0, daily, costs, plan: toPlan(sku), adByDay,
    };
    const row = buildProductRow(input, ctx);
    const f = row.factMonth;
    const price = f.buyoutQty > 0 ? Math.round(f.buyoutSum / f.buyoutQty) : 0;
    // Отмены и возвраты разделены: раньше здесь считалось (заказы − выкуп)/заказы
    // и всё это показывалось как «возвраты». Отмен на порядок больше возвратов,
    // и работать с ними надо по-разному — поэтому две отдельные метрики.
    const t = aggregateFacts(daily);
    const cancelPct = div(t.cancelsSum, t.ordersSum);
    const returnPct = div(t.returnsSum, t.ordersSum);
    const buyoutPct = f.ordersQty > 0 ? f.buyoutQty / f.ordersQty : 0;
    // «Хватит N дней» = остаток ÷ средние продажи в день ЗА ПОСЛЕДНИЕ 7 ДНЕЙ.
    // Средняя за весь месяц врёт на тренде: товар, вставший неделю назад, тянул бы
    // высокую среднюю с начала месяца и показывал ложное «кончается», а только
    // раскрутившийся — наоборот, ложный запас. Для закупок важно, что происходит сейчас.
    // Товара нет в sku_stock → он не на витрине: остаток 0.
    // Без продаж срок не определён (делить не на что) → null, а не 0: «0 дней» читается
    // как «кончается сейчас», хотя смысл ровно обратный — лежит и не продаётся.
    const stock = stockMap.get(sku) ?? 0;
    const recent = daily.slice(-STOCK_WINDOW_DAYS); // daily идёт по days, а те отсортированы
    const soldRecent = recent.reduce((s, d) => s + (d.ordersQty - d.cancelsQty - d.returnsQty), 0);
    const perDay = div(soldRecent, recent.length || 1);
    const daysLeft = perDay > 0 ? Math.round(stock / perDay) : null;

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
      stock: { stock, daysLeft, cancelPct, returnPct, buyoutPct, drr: f.drr },
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
  cancelPct: number;
  returnPct: number;
  commission: number;
  creditUplift: number;  // надбавка Kaspi за рассрочку за период, ₸
  creditShare: number;   // доля продаж в рассрочку (по выручке), 0..1
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
  weight: number;         // вес за 1 шт, кг (редактируемое)
  deliveryPerKg: number;  // цена доставки за 1 кг, $ (редактируемое)
  usdRate: number;        // курс $→₸ (глобальный)
  chinaDelivery: number;  // доставка из Китая × выкуп (всего) = вес × дост/кг × курс$ × выкуп
  chinaPerUnit: number;   // доставка из Китая за 1 шт, ₸ (расчётная)
  packagingTotal: number; // упаковка × выкуп (всего)
  packagingPerUnit: number; // упаковка за 1 шт, ₸ (редактируемое)
}

export async function getUnit(month: string): Promise<{ period: string; items: UnitItem[] }> {
  const sales = await query<SalesRow>(
    `SELECT sku, to_char(day,'YYYY-MM-DD') AS day, orders_sum, orders_qty, cancels_sum, cancels_qty, returns_sum, returns_qty, delivery_cost
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
    (await query<{ sku: string; cogs: number; packaging: number; cogs_yuan: number | null; china_delivery: number | null; weight: number | null; delivery_per_kg: number | null }>(
      `SELECT sku, cogs, packaging, cogs_yuan, china_delivery, weight, delivery_per_kg FROM sku_costs`,
    )).map((r) => [r.sku, r]),
  );
  const commMap = new Map(
    (await query<{ category_code: string; rate: number }>(`SELECT category_code, rate FROM category_commission`))
      .map((r) => [r.category_code, r.rate]),
  );
  const adMap = new Map(
    (await query<{ sku: string; amount: number; ad_views: number; ad_clicks: number; ad_orders: number }>(
      `SELECT sku, SUM(amount) AS amount, SUM(ad_views) AS ad_views, SUM(ad_clicks) AS ad_clicks, SUM(ad_orders) AS ad_orders
         FROM ad_spend WHERE period_month = $1 GROUP BY sku`, [month],
    )).map((r) => [r.sku, r]),
  );
  const taxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'tax_rate'`);
  const taxRate = taxRows[0] ? Number(taxRows[0].value) : DEF_TAX;
  const fxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_cny'`);
  const fxRate = fxRows[0] ? Number(fxRows[0].value) : 78;
  const usdRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_usd'`);
  const usdRate = usdRows[0] ? Number(usdRows[0].value) : 0;

  const creditMap = await creditBySku(month);

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
    const credit = creditMap.get(sku);
    const catRate = meta?.category_code ? commMap.get(meta.category_code) : undefined;
    const baseCogs = cost?.cogs ?? 0;            // себест без доставки, ₸/шт
    // доставка из Китая, ₸/шт = вес(кг) × цена-за-кг($) × курс$; если исходников нет — ручное china_delivery
    const w = Number(cost?.weight ?? 0);
    const perKg = Number(cost?.delivery_per_kg ?? 0);
    const chinaPerUnit = w > 0 && perKg > 0 && usdRate > 0
      ? Math.round(w * perKg * usdRate)
      : (cost?.china_delivery ?? 0);
    const costs: SkuCosts = {
      cogs: baseCogs + chinaPerUnit,             // полная себест (с доставкой Китая)
      packaging: cost?.packaging ?? 0,
      commissionRate: catRate ?? DEF_COMMISSION,
      taxRate,
      adSpend: ad?.amount ?? 0,
      creditUplift: credit?.uplift ?? 0,
    };
    const facts: DailyFact[] = rows.map((r) => ({
      day: r.day,
      ordersSum: r.orders_sum, ordersQty: r.orders_qty,
      cancelsSum: r.cancels_sum, cancelsQty: r.cancels_qty,
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
      cancelPct: m.cancelPct,
      returnPct: m.returnPct,
      commission: m.commission,
      creditUplift: m.creditUplift,
      creditShare: credit && credit.totalSum > 0 ? credit.creditSum / credit.totalSum : 0,
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
      weight: w,
      deliveryPerKg: perKg,
      usdRate,
      chinaDelivery: chinaPerUnit * m.buyoutQty,
      chinaPerUnit,
      packagingTotal: (cost?.packaging ?? 0) * m.buyoutQty,
      packagingPerUnit: cost?.packaging ?? 0,
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
    `SELECT sku, to_char(day,'YYYY-MM-DD') AS day, orders_sum, orders_qty, cancels_sum, cancels_qty, returns_sum, returns_qty, delivery_cost
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
    (await query<{ sku: string; amount: number }>(`SELECT sku, SUM(amount) AS amount FROM ad_spend WHERE period_month = $1 GROUP BY sku`, [month]))
      .map((r) => [r.sku, Number(r.amount) || 0]),
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
      cancelsSum: r.cancels_sum, cancelsQty: r.cancels_qty,
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

// ── ANALYTICS: ABC-анализ, резерв возвратов, точка безубыточности ──
export interface AbcItem {
  sku: string; name: string; category: string;
  revenue: number; units: number; profit: number;
  cumShare: number;          // накопленная доля прибыли (0..1)
  group: 'A' | 'B' | 'C' | 'D'; // D — убыточные
}
export interface ReturnRisk {
  sku: string; name: string; returnPct: number; returnsQty: number; lossReserve: number;
}
export interface BreakevenItem {
  sku: string; name: string;
  unitProfitNoAds: number;   // прибыль на штуку до рекламы, ₸
  adSpend: number;
  breakevenUnits: number;    // штук, чтобы окупить рекламу
  actualUnits: number;
  safetyUnits: number;       // запас сверх окупаемости (может быть <0)
  lossMaking: boolean;       // убыточен даже без рекламы
}

export async function getAnalytics(month: string): Promise<{
  month: string;
  summary: { totalProfit: number; lossMakingCount: number; returnReserve: number; aCount: number; skuCount: number };
  abcGroups: { group: string; count: number; profit: number; share: number }[];
  abc: AbcItem[];
  returns: ReturnRisk[];
  breakeven: BreakevenItem[];
}> {
  // переиспользуем полный расчёт юнит-экономики (комиссия, рассрочка, реклама и т.д.)
  const { items } = await getUnit(month);
  const retRows = await query<{ sku: string; rq: number }>(
    `SELECT sku, COALESCE(SUM(returns_qty),0) AS rq FROM sales_daily WHERE to_char(day,'YYYY-MM') = $1 GROUP BY sku`,
    [month],
  );
  const retMap = new Map(retRows.map((r) => [r.sku, Number(r.rq) || 0]));

  // ABC по вкладу в прибыль (убыточные → группа D)
  const sorted = [...items].sort((a, b) => b.profit - a.profit);
  const totalPos = sorted.filter((i) => i.profit > 0).reduce((s, i) => s + i.profit, 0) || 1;
  let cum = 0;
  const abc: AbcItem[] = sorted.map((i) => {
    let group: 'A' | 'B' | 'C' | 'D';
    if (i.profit <= 0) group = 'D';
    else {
      cum += i.profit;
      const sh = cum / totalPos;
      group = sh <= 0.8 ? 'A' : sh <= 0.95 ? 'B' : 'C';
    }
    return { sku: i.sku, name: i.name, category: i.category, revenue: i.revenue, units: i.units, profit: Math.round(i.profit), cumShare: i.profit > 0 ? cum / totalPos : 1, group };
  });
  const abcGroups = (['A', 'B', 'C', 'D'] as const).map((g) => {
    const gi = abc.filter((x) => x.group === g);
    const profit = gi.reduce((s, x) => s + x.profit, 0);
    return { group: g, count: gi.length, profit, share: profit / totalPos };
  }).filter((g) => g.count > 0);

  // Резерв на возвраты: при возврате доставка «туда» не возвращается → потеря ≈ возвраты × доставка/шт
  const returns: ReturnRisk[] = items.map((i) => {
    const rq = retMap.get(i.sku) ?? 0;
    const deliveryPerUnit = i.units > 0 ? i.delivery / i.units : 0;
    return { sku: i.sku, name: i.name, returnPct: i.returnPct, returnsQty: rq, lossReserve: Math.round(rq * deliveryPerUnit) };
  }).filter((r) => r.returnsQty > 0).sort((a, b) => b.lossReserve - a.lossReserve);

  // Точка безубыточности по рекламе
  const breakeven: BreakevenItem[] = items.map((i) => {
    const profitNoAds = i.profit + i.adSpend;          // прибыль до рекламы
    const unitProfitNoAds = i.units > 0 ? profitNoAds / i.units : 0;
    const breakevenUnits = i.adSpend > 0 && unitProfitNoAds > 0 ? Math.ceil(i.adSpend / unitProfitNoAds) : 0;
    return {
      sku: i.sku, name: i.name,
      unitProfitNoAds: Math.round(unitProfitNoAds), adSpend: Math.round(i.adSpend),
      breakevenUnits, actualUnits: i.units, safetyUnits: i.units - breakevenUnits,
      lossMaking: unitProfitNoAds <= 0,
    };
  }).sort((a, b) => a.unitProfitNoAds - b.unitProfitNoAds);

  const summary = {
    totalProfit: Math.round(items.reduce((s, i) => s + i.profit, 0)),
    lossMakingCount: breakeven.filter((b) => b.lossMaking).length,
    returnReserve: returns.reduce((s, r) => s + r.lossReserve, 0),
    aCount: abcGroups.find((g) => g.group === 'A')?.count ?? 0,
    skuCount: items.length,
  };

  return { month, summary, abcGroups, abc, returns, breakeven };
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
