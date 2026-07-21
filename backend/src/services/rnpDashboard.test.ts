import { describe, it, expect } from 'vitest';
import {
  metricsToSet,
  planToSet,
  forecastSet,
  sumSets,
  dayMetrics,
  buildProductRow,
  buildDashboard,
  type SkuPlan,
  type ProductInput,
} from './rnpDashboard.js';
import { calcSkuMetrics, aggregateFacts, type DailyFact, type SkuCosts } from './rnpCalc.js';

const day = (p: Partial<DailyFact>): DailyFact => ({
  day: '2026-06-01', ordersSum: 0, ordersQty: 0, cancelsSum: 0, cancelsQty: 0,
  returnsSum: 0, returnsQty: 0, deliveryCost: 0, ...p,
});

const costs: SkuCosts = { cogs: 300, packaging: 0, commissionRate: 0.1, taxRate: 0, adSpend: 3_000 };

describe('forecastSet', () => {
  it('аддитивные ×(1/mp), относительные инвариантны', () => {
    const fact = metricsToSet(
      calcSkuMetrics(aggregateFacts([day({ ordersSum: 30_000, ordersQty: 30 })]), costs),
    );
    const f = forecastSet(fact, { daysPassed: 10, daysInMonth: 30 }); // mp = 1/3
    expect(f.ordersSum).toBeCloseTo(90_000, 4);
    expect(f.ordersQty).toBeCloseTo(90, 4);
    expect(f.drr).toBeCloseTo(fact.drr, 6); // не меняется
    expect(f.margin).toBeCloseTo(fact.margin, 6);
  });
});

describe('sumSets', () => {
  it('суммирует и пересчитывает относительные', () => {
    const a = { ordersSum: 100, ordersQty: 1, buyoutSum: 80, buyoutQty: 1, adSum: 10, drr: 0.1, profit: 20, margin: 0.25 };
    const b = { ordersSum: 300, ordersQty: 3, buyoutSum: 240, buyoutQty: 3, adSum: 30, drr: 0.1, profit: 60, margin: 0.25 };
    const s = sumSets([a, b]);
    expect(s.ordersSum).toBe(400);
    expect(s.adSum).toBe(40);
    expect(s.drr).toBeCloseTo(40 / 400, 6);
    expect(s.margin).toBeCloseTo(80 / 320, 6);
  });
});

describe('dayMetrics', () => {
  it('распределяет месячный ДРР по дням пропорц. выручке', () => {
    const d = day({ ordersSum: 10_000, ordersQty: 10 });
    const m = dayMetrics(d, costs, 20_000); // день = половина месячной выручки
    expect(m.adSum).toBeCloseTo(1_500, 6); // 3000 * 10000/20000
    // base без рекламы: buyout 10000, commission 1000, cogs 3000 → profit_без 6000
    expect(m.profit).toBeCloseTo(4_500, 6); // 6000 − 1500
    expect(m.drr).toBeCloseTo(0.15, 6);
    expect(m.margin).toBeCloseTo(0.45, 6);
  });
});

describe('buildProductRow / buildDashboard', () => {
  const plan: SkuPlan = {
    ordersSum: 90_000, ordersQty: 90, buyoutSum: 81_000, buyoutQty: 81, adSum: 9_000, profit: 18_000,
  };
  const product: ProductInput = {
    sku: 'SKU1', name: 'Тест', article: 'A/1', price: 1_000,
    daily: [
      day({ ordersSum: 10_000, ordersQty: 10 }),
      day({ ordersSum: 20_000, ordersQty: 20, returnsSum: 2_000, returnsQty: 2 }),
    ],
    costs,
    plan,
  };
  const ctx = { daysPassed: 10, daysInMonth: 30 };

  it('строка товара: факт, прогноз, план, дни', () => {
    const row = buildProductRow(product, ctx);
    // факт: orders 30000, buyout 28000 (30000−2000)
    expect(row.factMonth.ordersSum).toBe(30_000);
    expect(row.factMonth.buyoutSum).toBe(28_000);
    // прогноз ×3 (mp=1/3)
    expect(row.forecastMonth.ordersSum).toBeCloseTo(90_000, 4);
    // план день = план месяца / 30
    expect(row.planDay.ordersSum).toBeCloseTo(90_000 / 30, 6);
    // дни
    expect(row.daily).toHaveLength(2);
    expect(row.daily[0]!.ordersSum).toBe(10_000);
  });

  it('дашборд: суммарные блоки', () => {
    const dto = buildDashboard('2026-06', ['06.01', '06.02'], [product, product], ctx);
    expect(dto.products).toHaveLength(2);
    expect(dto.summary.fact.ordersSum).toBe(60_000); // два товара по 30000
    expect(dto.summary.plan.ordersSum).toBe(180_000);
    expect(dto.summary.forecast.ordersSum).toBeCloseTo(180_000, 2);
  });
});
