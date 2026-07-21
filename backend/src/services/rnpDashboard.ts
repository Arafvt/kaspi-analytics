/**
 * Сборка сводного дашборда РНП (план / прогноз / факт месяца + динамика по дням
 * + строки товаров) на движке rnpCalc. Чистые функции, тестируемые.
 *
 * Структура повторяет 10X (reference/10x/ANALYSIS.md, разделы 3–6),
 * но Kaspi-адаптирована. Источник данных (sync → sales_daily) подключится позже —
 * сюда приходят уже подготовленные подневные факты и справочники.
 */

import {
  aggregateFacts,
  calcSkuMetrics,
  metricsFromDaily,
  forecast,
  monthPart,
  planCompletion,
  div,
  type DailyFact,
  type SkuCosts,
  type SkuMetrics,
} from './rnpCalc.js';

/** Набор из 8 метрик РНП (для периода или дня). profit/margin — «с ДРР». */
export interface MetricSet {
  ordersSum: number;
  ordersQty: number;
  buyoutSum: number;
  buyoutQty: number;
  adSum: number;
  drr: number;
  profit: number;
  margin: number;
}

/** План на месяц по SKU (ручной ввод). */
export interface SkuPlan {
  ordersSum: number;
  ordersQty: number;
  buyoutSum: number;
  buyoutQty: number;
  adSum: number;
  profit: number;
}

export interface MonthContext {
  daysPassed: number;
  daysInMonth: number;
}

export interface ProductInput {
  sku: string;
  name: string;
  article?: string;
  price?: number;
  daily: DailyFact[]; // подневный факт за месяц
  costs: SkuCosts;
  plan: SkuPlan;
  adByDay?: Record<string, number>; // реклама по дням (привязка к периоду); иначе costs.adSpend ÷ по месяцу
}

// ── MetricSet из метрик / плана ───────────────────────────────

export function metricsToSet(m: SkuMetrics): MetricSet {
  return {
    ordersSum: m.ordersSum,
    ordersQty: m.ordersQty,
    buyoutSum: m.buyoutSum,
    buyoutQty: m.buyoutQty,
    adSum: m.adSpend,
    drr: m.drr,
    profit: m.profitWithAdv,
    margin: m.marginWithAdv,
  };
}

export function planToSet(p: SkuPlan): MetricSet {
  return {
    ordersSum: p.ordersSum,
    ordersQty: p.ordersQty,
    buyoutSum: p.buyoutSum,
    buyoutQty: p.buyoutQty,
    adSum: p.adSum,
    drr: div(p.adSum, p.ordersSum),
    profit: p.profit,
    margin: div(p.profit, p.buyoutSum),
  };
}

/**
 * Прогноз месяца: аддитивные поля делим на долю месяца, относительные
 * (ДРР, маржа) пересчитываем из спрогнозированных компонент — они инвариантны
 * к month_part, поэтому совпадают с фактическими (как в 10X).
 */
export function forecastSet(fact: MetricSet, ctx: MonthContext): MetricSet {
  const mp = monthPart(ctx.daysPassed, ctx.daysInMonth);
  const ordersSum = forecast(fact.ordersSum, mp);
  const buyoutSum = forecast(fact.buyoutSum, mp);
  const adSum = forecast(fact.adSum, mp);
  const profit = forecast(fact.profit, mp);
  return {
    ordersSum,
    ordersQty: forecast(fact.ordersQty, mp),
    buyoutSum,
    buyoutQty: forecast(fact.buyoutQty, mp),
    adSum,
    drr: div(adSum, ordersSum),
    profit,
    margin: div(profit, buyoutSum),
  };
}

/** Сумма наборов по SKU с пересчётом относительных метрик. */
export function sumSets(sets: MetricSet[]): MetricSet {
  const acc = { ordersSum: 0, ordersQty: 0, buyoutSum: 0, buyoutQty: 0, adSum: 0, profit: 0 };
  for (const s of sets) {
    acc.ordersSum += s.ordersSum;
    acc.ordersQty += s.ordersQty;
    acc.buyoutSum += s.buyoutSum;
    acc.buyoutQty += s.buyoutQty;
    acc.adSum += s.adSum;
    acc.profit += s.profit;
  }
  return {
    ...acc,
    drr: div(acc.adSum, acc.ordersSum),
    margin: div(acc.profit, acc.buyoutSum),
  };
}

/** % выполнения по основной (денежной) метрике набора. */
export function setCompletion(fact: MetricSet, plan: MetricSet): number | null {
  return planCompletion(fact.ordersSum, plan.ordersSum);
}

// ── Подневные метрики (для колонок-дней) ──────────────────────

/**
 * Метрики одного дня. ДРР месячный (ручной), поэтому распределяем его по дням
 * пропорционально выручке заказов дня. profit с ДРР = profit_без_ДРР − доля_рекламы.
 */
export function dayMetrics(d: DailyFact, costs: SkuCosts, monthOrdersSum: number, dayAd?: number): MetricSet {
  const share = monthOrdersSum > 0 ? d.ordersSum / monthOrdersSum : 0;
  // реклама: если передана подневная (привязка к периоду отчёта) — берём её (вкл. 0 вне периода),
  // иначе fallback — месячная сумма ÷ пропорционально выручке дня.
  const ad = dayAd ?? costs.adSpend * share;
  // надбавку за рассрочку (месячная) распределяем по дням пропорционально выручке
  const dayCredit = (costs.creditUplift ?? 0) * share;
  const base = calcSkuMetrics(aggregateFacts([d]), { ...costs, adSpend: 0, creditUplift: 0 });
  const profitWithAdv = base.profitWithoutAdv - dayCredit - ad;
  return {
    ordersSum: base.ordersSum,
    ordersQty: base.ordersQty,
    buyoutSum: base.buyoutSum,
    buyoutQty: base.buyoutQty,
    adSum: ad,
    drr: div(ad, base.ordersSum),
    profit: profitWithAdv,
    margin: div(profitWithAdv, base.buyoutSum),
  };
}

// ── Строка товара ─────────────────────────────────────────────

export interface ProductRow {
  sku: string;
  name: string;
  article: string;
  price: number;
  marginNoAds: number;
  marginWAds: number;
  planDay: MetricSet;
  planMonth: MetricSet;
  forecastMonth: MetricSet;
  factMonth: MetricSet;
  daily: MetricSet[];
}

export function buildProductRow(p: ProductInput, ctx: MonthContext): ProductRow {
  const totals = aggregateFacts(p.daily);
  const metrics = calcSkuMetrics(totals, p.costs);
  const factMonth = metricsToSet(metrics);
  const planMonth = planToSet(p.plan);
  const forecastMonth = forecastSet(factMonth, ctx);

  // план дня = план месяца / дней в месяце
  const dd = ctx.daysInMonth || 1;
  const planDay: MetricSet = {
    ordersSum: planMonth.ordersSum / dd,
    ordersQty: planMonth.ordersQty / dd,
    buyoutSum: planMonth.buyoutSum / dd,
    buyoutQty: planMonth.buyoutQty / dd,
    adSum: planMonth.adSum / dd,
    drr: planMonth.drr,
    profit: planMonth.profit / dd,
    margin: planMonth.margin,
  };

  const daily = p.daily.map((d) =>
    dayMetrics(d, p.costs, totals.ordersSum, p.adByDay ? (p.adByDay[d.day] ?? 0) : undefined),
  );

  return {
    sku: p.sku,
    name: p.name,
    article: p.article ?? '',
    price: p.price ?? 0,
    marginNoAds: metrics.marginWithoutAdv,
    marginWAds: metrics.marginWithAdv,
    planDay,
    planMonth,
    forecastMonth,
    factMonth,
    daily,
  };
}

// ── Полный дашборд ────────────────────────────────────────────

export interface DashboardDTO {
  month: string;
  days: string[];
  summary: { plan: MetricSet; forecast: MetricSet; fact: MetricSet };
  products: ProductRow[];
}

export function buildDashboard(
  month: string,
  days: string[],
  products: ProductInput[],
  ctx: MonthContext,
): DashboardDTO {
  const rows = products.map((p) => buildProductRow(p, ctx));
  const fact = sumSets(rows.map((r) => r.factMonth));
  const plan = sumSets(rows.map((r) => r.planMonth));
  const forecastBlock = forecastSet(fact, ctx);
  return {
    month,
    days,
    summary: { plan, forecast: forecastBlock, fact },
    products: rows,
  };
}

export { metricsFromDaily };
