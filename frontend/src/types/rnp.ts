/** Типы данных РНП (зеркало ответа backend). */

export interface UnitRow {
  sku: string;
  name: string;
  image: string;
  category: string;
  revenue: number;
  units: number;
  cancelPct: number;
  returnPct: number;
  creditShare: number;   // доля продаж в рассрочку, 0..1
  commission: number;
  creditUplift: number;  // надбавка за рассрочку, ₸
  delivery: number;
  tax: number;
  cogsTotal: number;
  adSpend: number;
  marginNoAds: number;
  drr: number;
  marginWAds: number;
  krr: number;
  profit: number;
  roi: number;
  payout: number;
  adViews: number;
  adClicks: number;
  ctr: number;
  conversion: number;
  cogsYuan: number;
  fxRate: number;
  cogsNoDeliv: number;    // себест без доставки (всего)
  weight: number;         // вес за 1 шт, кг
  deliveryPerKg: number;  // цена доставки за 1 кг, $
  usdRate: number;        // курс $→₸ (глобальный)
  chinaDelivery: number;  // доставка из Китая (всего) = вес × дост/кг × курс$ × выкуп
  chinaPerUnit: number;   // доставка из Китая за 1 шт, ₸ (расчётная)
  packagingTotal: number; // упаковка (всего)
  packagingPerUnit: number; // упаковка за 1 шт, ₸
}

export interface PlanRow {
  sku: string;
  name: string;
  image: string;
  category: string;
  planSum: number;
  factSum: number;
  planQty: number;
  factQty: number;
  targetDrr: number;
  planProfit: number;
  planMargin: number;
  marginWAds: number;
  profit: number;
  approved: boolean;
}

export interface DailyPoint {
  day: string; // YYYY-MM-DD
  ordersSum: number;
  ordersQty: number;
}

// ── Аналитика ────────────────────────────────────────────────
export interface AbcItem {
  sku: string;
  name: string;
  category: string;
  revenue: number;
  units: number;
  profit: number;
  cumShare: number;
  group: 'A' | 'B' | 'C' | 'D';
}
export interface ReturnRisk {
  sku: string;
  name: string;
  returnPct: number;
  returnsQty: number;
  lossReserve: number;
}
export interface BreakevenItem {
  sku: string;
  name: string;
  unitProfitNoAds: number;
  adSpend: number;
  breakevenUnits: number;
  actualUnits: number;
  safetyUnits: number;
  lossMaking: boolean;
}
export interface AnalyticsData {
  month: string;
  summary: { totalProfit: number; lossMakingCount: number; returnReserve: number; aCount: number; skuCount: number };
  abcGroups: { group: string; count: number; profit: number; share: number }[];
  abc: AbcItem[];
  returns: ReturnRisk[];
  breakeven: BreakevenItem[];
}
