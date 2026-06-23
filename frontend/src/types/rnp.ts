/** Типы данных РНП (зеркало ответа backend). */

export interface UnitRow {
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
  chinaDelivery: number;  // доставка из Китая (всего)
  chinaPerUnit: number;   // доставка из Китая за 1 шт, ₸
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
