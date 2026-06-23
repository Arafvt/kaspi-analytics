import type { FastifyInstance } from 'fastify';
import { getDashboard, getUnit, getPlan, savePlan } from '../services/rnpData.js';

/**
 * Эндпоинты РНП-аналитики (только чтение).
 * Frontend ТОЛЬКО форматирует — все числа считаются здесь (движок rnpDashboard).
 */
export async function rnpRoutes(app: FastifyInstance): Promise<void> {
  // Сводный дашборд (план/прогноз/факт + динамика + товары) из sales_daily
  app.get('/api/rnp/dashboard', async (req) => {
    const { month } = req.query as { month?: string };
    return getDashboard(month ?? new Date().toISOString().slice(0, 7));
  });

  // Юнит-экономика всех SKU за период — с полной разбивкой расходов
  app.get('/api/rnp/unit', async (req) => {
    const { period } = req.query as { period?: string };
    return getUnit(period ?? new Date().toISOString().slice(0, 7));
  });

  // План/факт по месяцу (ПЛАН-таблица)
  app.get('/api/rnp/plan/:month', async (req) => {
    const { month } = req.params as { month: string };
    return getPlan(month);
  });

  // Сохранить план по SKU за месяц
  app.post('/api/rnp/plan', async (req) => {
    const b = req.body as { sku?: string; month?: string; planSum?: number; planQty?: number; targetDrr?: number; planProfit?: number; approved?: boolean };
    if (!b?.sku || !b?.month) return { ok: false, error: 'sku and month required' };
    return savePlan({ sku: b.sku, month: b.month, planSum: b.planSum, planQty: b.planQty, targetDrr: b.targetDrr, planProfit: b.planProfit, approved: b.approved });
  });

  // Дневная динамика SKU
  app.get('/api/rnp/daily/:sku', async (req) => {
    const { sku } = req.params as { sku: string };
    const { month } = req.query as { month?: string };
    return { sku, month: month ?? null, days: [] }; // TODO
  });

  // Список SKU
  app.get('/api/rnp/sku', async () => {
    return { items: [] }; // TODO
  });
}
