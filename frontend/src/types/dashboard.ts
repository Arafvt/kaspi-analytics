/** Типы сводного дашборда (план/прогноз/факт + динамика по дням + товары). */

export interface MonthBlock {
  ordersSum: number;
  ordersQty: number;
  buyoutSum: number;
  buyoutQty: number;
  adSum: number;
  drr: number;
  profit: number;
  margin: number;
}

export interface MonthSummary {
  plan: MonthBlock;
  forecast: MonthBlock;
  fact: MonthBlock;
}

export type MetricFormat = 'money' | 'qty' | 'pct';

export interface DailyMetric {
  key: string;
  label: string;
  format: MetricFormat;
  /** true — больше=лучше (зелёный при ≥ план); false — меньше=лучше (ДРР). */
  higherIsBetter: boolean;
  /** ПЛАН ДНЯ */
  planDay: number;
  /** значения по дням (длина = days.length) */
  values: number[];
}

/** Полный набор метрик за период/день (8 показателей). */
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

/** Остатки / конверсия (левый блок). */
export interface ProductStock {
  stock: number;        // остаток на витрине, шт
  daysLeft: number | null; // на сколько дней хватит; null — продаж нет, срок не определён
  cancelPct: number;    // % отмен (отменённые заказы / валовые заказы)
  returnPct: number;    // % возвратов (выкупили и вернули)
  buyoutPct: number;    // % выкупа (1 − отмены − возвраты)
  drr: number;          // целевой ДРР
}

/** Строка товара в дашборде (как ряд в 10X). */
export interface ProductRowData {
  sku: string;
  article: string;
  name: string;
  price: number;
  seller: string;
  image?: string;       // фото товара (og:image), может отсутствовать
  // Показатели (левый блок)
  ordersQty: number;
  revenue: number;
  marginNoAds: number;
  marginWAds: number;
  stock: ProductStock;
  // Периоды
  planDay: MetricSet;
  planMonth: MetricSet;
  forecastMonth: MetricSet;
  factMonth: MetricSet;
  // График 30 дней (выручка)
  spark: number[];
  // Динамика по видимым дням
  daily: MetricSet[];
}

export interface DashboardData {
  month: string;
  days: string[];
  summary: MonthSummary;
  daily: DailyMetric[];
  products: ProductRowData[];
}
