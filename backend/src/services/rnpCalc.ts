/**
 * Движок расчёта РНП для Kaspi — чистые функции, без обращений к БД.
 * Повторяет логику WB 10X (см. reference/10x/ANALYSIS.md), адаптированную под Kaspi:
 *  - nm_id → sku
 *  - сложный perc_mp (комиссия+логистика+хранение+эквайринг) → единый take-rate категории
 *  - expected_buyouts_sum_rub → выкупленная выручка = orders_sum − cancels_sum − returns_sum
 *  - нет spp / локализации (на Kaspi отсутствуют)
 *  - ДРР — ручной ввод (рекламного API нет)
 *
 * Покрыто юнит-тестами: rnpCalc.test.ts
 */

// ── Деление с защитой от нуля ─────────────────────────────────
export const div = (a: number, b: number): number => (b === 0 ? 0 : a / b);

// ── Входные данные ────────────────────────────────────────────

/** Подневный факт по SKU (из sales_daily; источник заполнит sync). */
export interface DailyFact {
  day: string; // 'YYYY-MM-DD'
  ordersSum: number; // ВАЛОВЫЕ заказы, ₸ (включая отменённые)
  ordersQty: number;
  cancelsSum: number; // отменённые заказы, ₸ (CANCELLED + CANCELLING)
  cancelsQty: number;
  returnsSum: number; // возвраты, ₸
  returnsQty: number;
  deliveryCost: number; // доставка (если продавец платит), ₸
}

/** Косты и справочники по SKU. */
export interface SkuCosts {
  cogs: number; // закупка за единицу, ₸
  packaging: number; // упаковка/маркировка за единицу, ₸
  commissionRate: number; // take-rate категории Kaspi, доля (0.12 = 12%)
  taxRate: number; // налог, доля
  adSpend: number; // ДРР за период (ручной ввод), ₸
  creditUplift?: number; // надбавка Kaspi за рассрочку за период (абсолют, ₸); 0 если нет
}

// ── Агрегация факта ───────────────────────────────────────────

export interface FactTotals {
  ordersSum: number;
  ordersQty: number;
  cancelsSum: number;
  cancelsQty: number;
  returnsSum: number;
  returnsQty: number;
  /** выкупленная выручка = orders_sum − cancels_sum − returns_sum (Kaspi-аналог expected_buyouts) */
  buyoutSum: number;
  buyoutQty: number;
  delivery: number;
}

export function aggregateFacts(daily: DailyFact[]): FactTotals {
  const t: FactTotals = {
    ordersSum: 0, ordersQty: 0, cancelsSum: 0, cancelsQty: 0, returnsSum: 0, returnsQty: 0,
    buyoutSum: 0, buyoutQty: 0, delivery: 0,
  };
  for (const d of daily) {
    t.ordersSum += d.ordersSum;
    t.ordersQty += d.ordersQty;
    t.cancelsSum += d.cancelsSum;
    t.cancelsQty += d.cancelsQty;
    t.returnsSum += d.returnsSum;
    t.returnsQty += d.returnsQty;
    t.delivery += d.deliveryCost;
  }
  // отменённый заказ не доехал, возвращённый — доехал и вернулся: денег нет ни там, ни там
  t.buyoutSum = t.ordersSum - t.cancelsSum - t.returnsSum;
  t.buyoutQty = t.ordersQty - t.cancelsQty - t.returnsQty;
  return t;
}

// ── Производные метрики РНП (раздел 2–5 ANALYSIS.md) ───────────

export interface SkuMetrics {
  // факт
  ordersSum: number;
  ordersQty: number;
  cancelsSum: number;
  cancelsQty: number;
  returnsSum: number;
  returnsQty: number;
  buyoutSum: number;
  buyoutQty: number;
  delivery: number;
  // косты
  commission: number;
  creditUplift: number; // надбавка за рассрочку, ₸
  cogsTotal: number;
  tax: number;
  adSpend: number;
  // прибыль
  profitWithoutAdv: number;
  profitWithAdv: number;
  // относительные
  drr: number; // ДРР %
  marginWithoutAdv: number; // маржа до ДРР
  marginWithAdv: number; // маржа с ДРР
  krr: number; // КРРР
  cancelPct: number; // % отмен (от валовых заказов)
  returnPct: number; // % возвратов (от валовых заказов)
  lossPct: number; // % несостоявшихся заказов = отмены + возвраты
  buyoutPct: number; // % выкупа
  roi: number;
  unitProfit: number; // прибыль на штуку
}

/** КРРР — какая доля прибыли «до ДРР» остаётся после рекламы. */
export function krr(profitWithAdv: number, profitWithoutAdv: number): number {
  if (profitWithAdv < 0) return 0;
  return div(profitWithAdv, profitWithoutAdv);
}

/**
 * Полный набор метрик SKU за период.
 * Базы (Kaspi-адаптация):
 *  - комиссия и налог берутся с ВЫКУПЛЕННОЙ выручки (отмены и возвраты не облагаются);
 *  - себестоимость — за фактически проданные (выкупленные) единицы;
 *  - ДРР% = реклама / ВАЛОВЫЕ заказы — та же база, что у «Доли рекламных расходов»
 *    в кабинете Kaspi, иначе наш ДРР расходится с кабинетом.
 */
export function calcSkuMetrics(f: FactTotals, c: SkuCosts): SkuMetrics {
  const commission = f.buyoutSum * c.commissionRate;
  const creditUplift = c.creditUplift ?? 0; // надбавка Kaspi за рассрочку (абсолют ₸)
  const cogsTotal = (c.cogs + c.packaging) * f.buyoutQty;
  const tax = f.buyoutSum * c.taxRate;
  const delivery = f.delivery;

  const profitWithoutAdv = f.buyoutSum - commission - creditUplift - delivery - cogsTotal - tax;
  const profitWithAdv = profitWithoutAdv - c.adSpend;

  return {
    ordersSum: f.ordersSum,
    ordersQty: f.ordersQty,
    cancelsSum: f.cancelsSum,
    cancelsQty: f.cancelsQty,
    returnsSum: f.returnsSum,
    returnsQty: f.returnsQty,
    buyoutSum: f.buyoutSum,
    buyoutQty: f.buyoutQty,
    delivery,
    commission,
    creditUplift,
    cogsTotal,
    tax,
    adSpend: c.adSpend,
    profitWithoutAdv,
    profitWithAdv,
    drr: div(c.adSpend, f.ordersSum),
    marginWithoutAdv: div(profitWithoutAdv, f.buyoutSum),
    marginWithAdv: div(profitWithAdv, f.buyoutSum),
    krr: krr(profitWithAdv, profitWithoutAdv),
    cancelPct: div(f.cancelsSum, f.ordersSum),
    returnPct: div(f.returnsSum, f.ordersSum),
    lossPct: div(f.cancelsSum + f.returnsSum, f.ordersSum),
    buyoutPct: div(f.buyoutQty, f.ordersQty),
    roi: div(profitWithAdv, cogsTotal),
    unitProfit: div(profitWithAdv, f.buyoutQty),
  };
}

/** Удобная обёртка: метрики прямо из подневного факта. */
export function metricsFromDaily(daily: DailyFact[], c: SkuCosts): SkuMetrics {
  return calcSkuMetrics(aggregateFacts(daily), c);
}

// ── Прогноз месяца и выполнение плана (раздел 3–4 ANALYSIS.md) ─

/**
 * Доля прошедшего месяца = прошло_дней / дней_в_месяце.
 * Если месяц завершён (прошло ≥ всего) → 1 (прогноз = факт).
 */
export function monthPart(daysPassed: number, daysInMonth: number): number {
  if (daysInMonth <= 0) return 1;
  if (daysPassed >= daysInMonth) return 1;
  if (daysPassed <= 0) return 0;
  return daysPassed / daysInMonth;
}

/**
 * Прогноз аддитивной метрики = факт / доля_месяца (линейная экстраполяция).
 * Для mp=0 (день не наступил) возвращаем 0.
 */
export function forecast(fact: number, mp: number): number {
  if (mp <= 0) return 0;
  return fact / mp;
}

/**
 * % выполнения плана (функция p из 10X). null = плана нет.
 *  plan>0 & fact>0 → fact/plan
 *  plan<0 & fact>=plan → 1 ; plan<0 & fact<plan → 0 ; иначе 0
 */
export function planCompletion(fact: number, plan: number): number | null {
  if (plan === 0 || Number.isNaN(plan)) return null;
  if (plan > 0 && fact > 0) return fact / plan;
  if (plan < 0 && fact >= plan) return 1;
  if (plan < 0 && fact < plan) return 0;
  return 0;
}
