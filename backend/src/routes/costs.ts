import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { loadUpliftRates } from '../services/rnpData.js';

/**
 * Ввод справочников: COGS, ставки комиссии, реклама (ДРР), план, настройки.
 */
export async function costsRoutes(app: FastifyInstance): Promise<void> {
  // Надбавка за рассрочку по сроку (3/6/12/24 мес), доля от выручки
  app.get('/api/costs/credit-uplift', async () => ({ rates: await loadUpliftRates() }));
  app.post('/api/costs/credit-uplift', async (req) => {
    const b = req.body as { term?: string; value?: number };
    if (!b?.term) return { ok: false, error: 'term required' };
    const v = Number(b.value);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'bad value' };
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`credit_uplift_${b.term}`, String(v)],
    );
    return { ok: true };
  });

  // Чтение справочников
  app.get('/api/costs/cogs', async () => {
    const items = await query(
      `SELECT c.sku, s.name, s.category_code AS category, c.cogs, c.packaging
         FROM sku_costs c LEFT JOIN sku s ON s.sku = c.sku
        ORDER BY c.sku`,
    );
    return { items };
  });
  app.get('/api/costs/commission', async () => {
    const items = await query(`SELECT category_code AS category, rate FROM category_commission ORDER BY category_code`);
    return { items };
  });

  // Одиночный апдейт: закуп ¥ (cogsYuan) или прямой cogs.
  // Если задан cogsYuan — себест ₸ = cogsYuan × курс (глобальный fx_cny).
  app.post('/api/costs/cogs', async (req) => {
    const b = req.body as { sku?: string; cogs?: number; cogsYuan?: number; packaging?: number };
    if (!b?.sku) return { ok: false, error: 'sku required' };
    const fxRows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_cny'`);
    const fx = fxRows[0] ? Number(fxRows[0].value) : 78;
    const yuan = b.cogsYuan != null ? Number(b.cogsYuan) : null;
    const cogs = yuan != null ? Math.round(yuan * fx) : Number(b.cogs) || 0;
    await query(
      `INSERT INTO sku_costs (sku, cogs, cogs_yuan, packaging, updated_at)
       VALUES ($1,$2,$3, COALESCE((SELECT packaging FROM sku_costs WHERE sku=$1),0), now())
       ON CONFLICT (sku) DO UPDATE SET cogs = EXCLUDED.cogs, cogs_yuan = EXCLUDED.cogs_yuan, updated_at = now()`,
      [b.sku, cogs, yuan],
    );
    return { ok: true, cogs };
  });

  // Глобальный курс ¥→₸: меняем настройку и пересчитываем себест у всех (cogs = cogs_yuan × курс)
  app.post('/api/costs/fx', async (req) => {
    const b = req.body as { rate?: number };
    const rate = Number(b?.rate);
    if (!Number.isFinite(rate) || rate <= 0) return { ok: false, error: 'bad rate' };
    await query(
      `INSERT INTO settings (key, value) VALUES ('fx_cny', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(rate)],
    );
    await query(`UPDATE sku_costs SET cogs = round(cogs_yuan * $1), updated_at = now() WHERE cogs_yuan IS NOT NULL`, [rate]);
    return { ok: true, rate };
  });

  // Доставка из Китая за 1 шт (₸) — ручное значение (fallback, если нет веса/цены за кг)
  app.post('/api/costs/china', async (req) => {
    const b = req.body as { sku?: string; value?: number };
    if (!b?.sku) return { ok: false, error: 'sku required' };
    const v = Number(b.value);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'bad value' };
    await query(
      `INSERT INTO sku_costs (sku, china_delivery, packaging, updated_at)
       VALUES ($1, $2, COALESCE((SELECT packaging FROM sku_costs WHERE sku=$1),0), now())
       ON CONFLICT (sku) DO UPDATE SET china_delivery = EXCLUDED.china_delivery, updated_at = now()`,
      [b.sku, Math.round(v)],
    );
    return { ok: true, value: Math.round(v) };
  });

  // Текущий курс $→₸ (0 = не задан)
  async function usdRate(): Promise<number> {
    const r = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_usd'`);
    return r[0] ? Number(r[0].value) : 0;
  }
  // Пересчёт доставки из Китая = weight × delivery_per_kg × курс$ для одного SKU
  const CHINA_RECALC = `UPDATE sku_costs SET china_delivery = round(weight * delivery_per_kg * $2), updated_at = now()
                          WHERE sku = $1 AND weight IS NOT NULL AND delivery_per_kg IS NOT NULL`;

  // Глобальный курс $→₸: меняем настройку и пересчитываем доставку у всех
  app.post('/api/costs/usd', async (req) => {
    const rate = Number((req.body as { rate?: number })?.rate);
    if (!Number.isFinite(rate) || rate <= 0) return { ok: false, error: 'bad rate' };
    await query(
      `INSERT INTO settings (key, value) VALUES ('fx_usd', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(rate)],
    );
    await query(
      `UPDATE sku_costs SET china_delivery = round(weight * delivery_per_kg * $1), updated_at = now()
        WHERE weight IS NOT NULL AND delivery_per_kg IS NOT NULL`,
      [rate],
    );
    return { ok: true, rate };
  });

  // Вес за 1 шт (кг) — исходник для доставки; после записи пересчитываем доставку
  app.post('/api/costs/weight', async (req) => {
    const b = req.body as { sku?: string; value?: number };
    if (!b?.sku) return { ok: false, error: 'sku required' };
    const v = Number(b.value);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'bad value' };
    await query(
      `INSERT INTO sku_costs (sku, weight, packaging, updated_at)
       VALUES ($1, $2, COALESCE((SELECT packaging FROM sku_costs WHERE sku=$1),0), now())
       ON CONFLICT (sku) DO UPDATE SET weight = EXCLUDED.weight, updated_at = now()`,
      [b.sku, v],
    );
    await query(CHINA_RECALC, [b.sku, await usdRate()]);
    return { ok: true, value: v };
  });

  // Цена доставки за 1 кг ($) — исходник для доставки; после записи пересчитываем доставку
  app.post('/api/costs/perkg', async (req) => {
    const b = req.body as { sku?: string; value?: number };
    if (!b?.sku) return { ok: false, error: 'sku required' };
    const v = Number(b.value);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'bad value' };
    await query(
      `INSERT INTO sku_costs (sku, delivery_per_kg, packaging, updated_at)
       VALUES ($1, $2, COALESCE((SELECT packaging FROM sku_costs WHERE sku=$1),0), now())
       ON CONFLICT (sku) DO UPDATE SET delivery_per_kg = EXCLUDED.delivery_per_kg, updated_at = now()`,
      [b.sku, v],
    );
    await query(CHINA_RECALC, [b.sku, await usdRate()]);
    return { ok: true, value: v };
  });

  // Упаковка/маркировка за 1 шт (₸)
  app.post('/api/costs/packaging', async (req) => {
    const b = req.body as { sku?: string; value?: number };
    if (!b?.sku) return { ok: false, error: 'sku required' };
    const v = Number(b.value);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'bad value' };
    await query(
      `INSERT INTO sku_costs (sku, packaging, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (sku) DO UPDATE SET packaging = EXCLUDED.packaging, updated_at = now()`,
      [b.sku, Math.round(v)],
    );
    return { ok: true, value: Math.round(v) };
  });

  // Массовая загрузка COGS (импорт Excel) — [{sku, cogs?, cogsYuan?}], опц. fx (курс).
  // Если задан cogsYuan — себест ₸ = cogsYuan × курс.
  app.post('/api/costs/cogs-bulk', async (req) => {
    const b = req.body as { items?: { sku: string; cogs?: number; cogsYuan?: number; chinaDelivery?: number }[]; fx?: number };
    const items = b?.items ?? [];
    let fx = Number(b?.fx);
    if (!Number.isFinite(fx) || fx <= 0) {
      const r = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'fx_cny'`);
      fx = r[0] ? Number(r[0].value) : 78;
    } else {
      await query(`INSERT INTO settings (key, value) VALUES ('fx_cny', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(fx)]);
    }
    let updated = 0;
    for (const it of items) {
      if (!it?.sku) continue;
      const yuan = it.cogsYuan != null ? Number(it.cogsYuan) : null;
      const cogs = yuan != null ? Math.round(yuan * fx) : Number(it.cogs) || 0;
      const china = it.chinaDelivery != null ? Math.round(Number(it.chinaDelivery)) : null;
      const res = await query(
        `INSERT INTO sku_costs (sku, cogs, cogs_yuan, china_delivery, packaging, updated_at)
         SELECT $1, $2, $3, $4, COALESCE((SELECT packaging FROM sku_costs WHERE sku = $1), 0), now()
         WHERE EXISTS (SELECT 1 FROM sku WHERE sku = $1)
         ON CONFLICT (sku) DO UPDATE SET cogs = EXCLUDED.cogs, cogs_yuan = EXCLUDED.cogs_yuan,
           china_delivery = COALESCE(EXCLUDED.china_delivery, sku_costs.china_delivery), updated_at = now()
         RETURNING sku`,
        [it.sku, cogs, yuan, china],
      );
      if (res.length) updated++;
    }
    return { ok: true, updated, received: items.length, fx };
  });

  app.post('/api/costs/commission', async (req) => {
    const b = req.body as { category?: string; rate?: number };
    if (!b?.category) return { ok: false };
    await query(
      `INSERT INTO category_commission (category_code, rate, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (category_code) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()`,
      [b.category, b.rate ?? 0],
    );
    return { ok: true };
  });

  app.post('/api/costs/ad-spend', async () => ({ ok: true }));
  app.post('/api/plan', async () => ({ ok: true }));

  app.get('/api/settings', async () => {
    const items = await query(`SELECT key, value FROM settings ORDER BY key`);
    return { items };
  });
  app.post('/api/settings', async (req) => {
    const b = req.body as { key?: string; value?: string };
    if (!b?.key) return { ok: false };
    await query(
      `INSERT INTO settings (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [b.key, b.value ?? ''],
    );
    return { ok: true };
  });
}
