import { api } from './client';
import type { UnitRow, PlanRow, DailyPoint } from '../types/rnp';
import type { DashboardData } from '../types/dashboard';

/** Вызовы РНП-API бэкенда (в dev проксируются на :8080 — см. vite.config). */
export const rnpApi = {
  unit: (period: string) =>
    api.get<{ period: string; items: UnitRow[] }>(`/api/rnp/unit?period=${period}`),

  dashboard: (month: string) =>
    api.get<DashboardData>(`/api/rnp/dashboard?month=${month}`),

  plan: (month: string) =>
    api.get<{ month: string; items: PlanRow[] }>(`/api/rnp/plan/${month}`),

  savePlan: (b: { sku: string; month: string; planSum?: number; planQty?: number; targetDrr?: number; planProfit?: number; approved?: boolean }) =>
    api.post<{ ok: boolean }>(`/api/rnp/plan`, b),

  daily: (sku: string, month: string) =>
    api.get<{ sku: string; days: DailyPoint[] }>(`/api/rnp/daily/${sku}?month=${month}`),

  syncStatus: () => api.get<unknown>(`/api/sync/status`),
  triggerSync: () => api.post<unknown>(`/api/sync/orders`, {}),
};

export interface CogsRow {
  sku: string;
  name: string;
  category: string;
  cogs: number;
  packaging: number;
}
export interface CommissionRow {
  category: string;
  rate: number;
}

/** Справочники: COGS по SKU и ставки комиссии. */
export const costsApi = {
  cogs: () => api.get<{ items: CogsRow[] }>(`/api/costs/cogs`),
  commission: () => api.get<{ items: CommissionRow[] }>(`/api/costs/commission`),
  importCogs: (items: { sku: string; cogs?: number; cogsYuan?: number; chinaDelivery?: number }[], fx?: number) =>
    api.post<{ ok: boolean; updated: number; received: number; fx: number }>(`/api/costs/cogs-bulk`, { items, fx }),
  setCogs: (sku: string, cogsYuan: number) =>
    api.post<{ ok: boolean; cogs: number }>(`/api/costs/cogs`, { sku, cogsYuan }),
  setFx: (rate: number) =>
    api.post<{ ok: boolean; rate: number }>(`/api/costs/fx`, { rate }),
  setChina: (sku: string, value: number) =>
    api.post<{ ok: boolean; value: number }>(`/api/costs/china`, { sku, value }),
};
