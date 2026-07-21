import { describe, it, expect } from 'vitest';
import {
  aggregateFacts,
  calcSkuMetrics,
  krr,
  monthPart,
  forecast,
  planCompletion,
  type DailyFact,
  type SkuCosts,
} from './rnpCalc.js';

const day = (p: Partial<DailyFact>): DailyFact => ({
  day: '2026-06-01', ordersSum: 0, ordersQty: 0, cancelsSum: 0, cancelsQty: 0,
  returnsSum: 0, returnsQty: 0, deliveryCost: 0, ...p,
});

describe('aggregateFacts', () => {
  it('суммирует и считает выкуп = заказы − отмены − возвраты', () => {
    const t = aggregateFacts([
      day({ ordersSum: 60_000, ordersQty: 60, cancelsSum: 6_000, cancelsQty: 6, returnsSum: 5_000, returnsQty: 5, deliveryCost: 1_000 }),
      day({ ordersSum: 40_000, ordersQty: 40, cancelsSum: 4_000, cancelsQty: 4, returnsSum: 5_000, returnsQty: 5, deliveryCost: 1_000 }),
    ]);
    expect(t.ordersSum).toBe(100_000);
    expect(t.ordersQty).toBe(100);
    expect(t.cancelsSum).toBe(10_000);
    expect(t.returnsSum).toBe(10_000);
    expect(t.buyoutSum).toBe(80_000); // 100000 − 10000 − 10000
    expect(t.buyoutQty).toBe(80);
    expect(t.delivery).toBe(2_000);
  });

  it('отменённый заказ не попадает в выкуп', () => {
    const t = aggregateFacts([
      day({ ordersSum: 10_000, ordersQty: 10, cancelsSum: 10_000, cancelsQty: 10 }),
    ]);
    expect(t.buyoutSum).toBe(0);
    expect(t.buyoutQty).toBe(0);
  });
});

describe('calcSkuMetrics', () => {
  const costs: SkuCosts = { cogs: 300, packaging: 20, commissionRate: 0.12, taxRate: 0.03, adSpend: 5_000 };
  const totals = aggregateFacts([
    day({ ordersSum: 100_000, ordersQty: 100, returnsSum: 10_000, returnsQty: 10, deliveryCost: 2_000 }),
  ]);
  const m = calcSkuMetrics(totals, costs);

  it('комиссия/налог — с выкупленной выручки, COGS — за выкупленные единицы', () => {
    expect(m.commission).toBe(10_800); // 90000 * 0.12
    expect(m.cogsTotal).toBe(28_800); // (300+20) * 90
    expect(m.tax).toBe(2_700); // 90000 * 0.03
  });

  it('прибыль до и с ДРР', () => {
    expect(m.profitWithoutAdv).toBe(45_700); // 90000 − 10800 − 2000 − 28800 − 2700
    expect(m.profitWithAdv).toBe(40_700); // 45700 − 5000
  });

  it('относительные метрики', () => {
    expect(m.drr).toBeCloseTo(0.05, 6); // 5000 / 100000 (от валовых заказов)
    expect(m.marginWithoutAdv).toBeCloseTo(45_700 / 90_000, 6);
    expect(m.marginWithAdv).toBeCloseTo(40_700 / 90_000, 6);
    expect(m.krr).toBeCloseTo(40_700 / 45_700, 6);
    expect(m.returnPct).toBeCloseTo(0.1, 6);
    expect(m.buyoutPct).toBeCloseTo(0.9, 6);
    expect(m.roi).toBeCloseTo(40_700 / 28_800, 6);
    expect(m.unitProfit).toBeCloseTo(40_700 / 90, 6);
  });

  it('отмены и возвраты разделены и не смешиваются', () => {
    const t = aggregateFacts([
      day({ ordersSum: 100_000, ordersQty: 100, cancelsSum: 20_000, cancelsQty: 20, returnsSum: 5_000, returnsQty: 5 }),
    ]);
    const mm = calcSkuMetrics(t, costs);
    expect(mm.cancelPct).toBeCloseTo(0.2, 6);
    expect(mm.returnPct).toBeCloseTo(0.05, 6);
    expect(mm.lossPct).toBeCloseTo(0.25, 6);
    expect(mm.buyoutPct).toBeCloseTo(0.75, 6);
    // комиссия/налог только с выкупа: отменённый заказ Kaspi не тарифицирует
    expect(mm.commission).toBeCloseTo(75_000 * 0.12, 6);
  });

  it('не делит на ноль при пустом периоде', () => {
    const z = calcSkuMetrics(aggregateFacts([]), costs);
    expect(z.drr).toBe(0);
    expect(z.marginWithAdv).toBe(0);
    expect(z.roi).toBe(0);
    expect(z.unitProfit).toBe(0);
  });
});

describe('krr', () => {
  it('0 при убытке с ДРР', () => {
    expect(krr(-5, 100)).toBe(0);
  });
  it('доля прибыли после рекламы', () => {
    expect(krr(40_700, 45_700)).toBeCloseTo(0.8906, 4);
  });
});

describe('monthPart', () => {
  it('доля прошедшего месяца', () => {
    expect(monthPart(10, 30)).toBeCloseTo(1 / 3, 6);
    expect(monthPart(15, 30)).toBe(0.5);
  });
  it('завершённый месяц → 1', () => {
    expect(monthPart(30, 30)).toBe(1);
    expect(monthPart(31, 30)).toBe(1);
  });
  it('день не наступил → 0', () => {
    expect(monthPart(0, 30)).toBe(0);
  });
});

describe('forecast', () => {
  it('факт / доля месяца', () => {
    expect(forecast(45_700, 1 / 3)).toBeCloseTo(137_100, 4);
  });
  it('mp=0 → 0', () => {
    expect(forecast(1000, 0)).toBe(0);
  });
});

describe('planCompletion (функция p из 10X)', () => {
  it('plan>0', () => {
    expect(planCompletion(50, 100)).toBe(0.5);
    expect(planCompletion(120, 100)).toBe(1.2);
  });
  it('нет плана → null', () => {
    expect(planCompletion(50, 0)).toBeNull();
  });
  it('знаковая логика для отрицательного плана', () => {
    expect(planCompletion(-50, -100)).toBe(1); // fact >= plan
    expect(planCompletion(-150, -100)).toBe(0); // fact < plan
  });
});
