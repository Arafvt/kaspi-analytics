import { config } from '../config/env.js';
import { query } from '../db/pool.js';
import { getOrdersPage, getOrderEntries } from '../kaspi/client.js';

/**
 * Синхронизация Kaspi Orders → orders_raw → sales_daily. ТОЛЬКО чтение из Kaspi.
 *
 * Идемпотентность: сырьё в orders_raw (PK order_code+entry_number) через UPSERT,
 * sales_daily ПЕРЕсобирается из orders_raw за затронутые дни → нет двойного счёта.
 *
 * Классификация для агрегата (raw хранится, можно переопределить):
 *  - orders_*  (валовые заказы) = статус ≠ CANCELLED
 *  - returns_* = статус = RETURNED
 *  - выкуп (в движке) = orders − returns
 */

const DAY = 86_400_000;
const ALMATY_OFFSET = 5 * 3_600_000; // +05
const CHUNK_MS = 13 * DAY; // Kaspi отвергает окно фильтра creationDate шире 14 дней — режем по 13 с запасом

/** ms epoch → дата Asia/Almaty 'YYYY-MM-DD'. */
function almatyDay(ms: number): string {
  return new Date(ms + ALMATY_OFFSET).toISOString().slice(0, 10);
}

export interface SyncResult {
  ok: boolean;
  ordersSeen: number;
  entriesUpserted: number;
  days: number;
  error?: string;
}

export interface SyncOpts {
  /** Принудительное окно: тянуть за последние N дней (игнорируя курсор). */
  daysBack?: number;
  /** Принудительное начало окна в ms epoch (приоритетнее daysBack/курсора). */
  fromTs?: number;
}

async function readCursor(): Promise<number> {
  const rows = await query<{ cursor_ts: number | null }>(
    `SELECT cursor_ts FROM sync_meta WHERE kind = 'orders'`,
  );
  if (rows.length && rows[0]!.cursor_ts) return rows[0]!.cursor_ts;
  return Date.now() - config.kaspi.backfillDays * DAY;
}

async function writeMeta(ok: boolean, cursorTs: number, error?: string): Promise<void> {
  await query(
    `INSERT INTO sync_meta (kind, last_run_at, last_ok, last_error, cursor_ts)
     VALUES ('orders', now(), $1, $2, $3)
     ON CONFLICT (kind) DO UPDATE
       SET last_run_at = now(), last_ok = $1, last_error = $2, cursor_ts = $3`,
    [ok, error ?? null, cursorTs],
  );
}

async function upsertSku(sku: string, name: string, categoryCode: string | null): Promise<void> {
  await query(
    `INSERT INTO sku (sku, name, category_code) VALUES ($1, $2, $3)
     ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, category_code = EXCLUDED.category_code`,
    [sku, name, categoryCode],
  );
}

async function upsertOrderEntry(row: {
  code: string; entryNumber: number; sku: string; day: string;
  sum: number; qty: number; delivery: number; status: string; state: string; raw: unknown;
}): Promise<void> {
  await query(
    `INSERT INTO orders_raw
       (order_code, entry_number, sku, day, sum, qty, delivery_cost, status, state, raw, synced_at)
     VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10::jsonb, now())
     ON CONFLICT (order_code, entry_number) DO UPDATE SET
       sku = EXCLUDED.sku, day = EXCLUDED.day, sum = EXCLUDED.sum, qty = EXCLUDED.qty,
       delivery_cost = EXCLUDED.delivery_cost, status = EXCLUDED.status, state = EXCLUDED.state,
       raw = EXCLUDED.raw, synced_at = now()`,
    [row.code, row.entryNumber, row.sku, row.day, row.sum, row.qty, row.delivery,
      row.status, row.state, JSON.stringify(row.raw)],
  );
}

/** Пересобрать sales_daily из orders_raw за указанные дни. */
async function rebuildSalesDaily(days: string[]): Promise<void> {
  if (days.length === 0) return;
  await query(`DELETE FROM sales_daily WHERE day = ANY($1::date[])`, [days]);
  await query(
    `INSERT INTO sales_daily (sku, day, orders_sum, orders_qty, returns_sum, returns_qty, delivery_cost)
     SELECT sku, day,
       COALESCE(SUM(sum)           FILTER (WHERE status <> 'CANCELLED'), 0),
       COALESCE(SUM(qty)           FILTER (WHERE status <> 'CANCELLED'), 0),
       COALESCE(SUM(sum)           FILTER (WHERE status =  'RETURNED'),  0),
       COALESCE(SUM(qty)           FILTER (WHERE status =  'RETURNED'),  0),
       COALESCE(SUM(delivery_cost) FILTER (WHERE status <> 'CANCELLED'), 0)
     FROM orders_raw
     WHERE day = ANY($1::date[])
     GROUP BY sku, day`,
    [days],
  );
}

/** Полный проход синка. Окно [from, сейчас]: $ge=from, листаем все страницы. */
export async function runOrdersSync(opts: SyncOpts = {}): Promise<SyncResult> {
  const now = Date.now();
  const from = opts.fromTs ?? (opts.daysBack != null ? now - opts.daysBack * DAY : await readCursor());
  const affectedDays = new Set<string>();
  let ordersSeen = 0;
  let entriesUpserted = 0;
  let maxCreation = from;

  console.log(`[sync] старт: окно с ${new Date(from + 5 * 3_600_000).toISOString().slice(0, 16)} (Almaty)`);

  try {
    // Kaspi отдаёт максимум 14 дней за запрос — режем [from, now] на окна ≤13 дней
    for (let chunkStart = from; chunkStart < now; chunkStart += CHUNK_MS) {
      const chunkEnd = Math.min(chunkStart + CHUNK_MS - 1, now);
      console.log(`[sync] окно ${almatyDay(chunkStart)} … ${almatyDay(chunkEnd)}`);

      let page = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await getOrdersPage({ dateFrom: chunkStart, dateTo: chunkEnd, pageNumber: page });
        const orders = res.data ?? [];
        if (orders.length === 0) break;

        for (const order of orders) {
          const a = order.attributes;
          // страницы Kaspi «протекают» назад — отсекаем заказы раньше окна
          if (a.creationDate < chunkStart) continue;
          ordersSeen++;
          maxCreation = Math.max(maxCreation, a.creationDate);
          const day = almatyDay(a.creationDate);

          if (a.status === 'CANCELLED') {
            const prev = await query<{ d: string }>(
              `SELECT DISTINCT to_char(day,'YYYY-MM-DD') AS d FROM orders_raw WHERE order_code = $1`,
              [a.code],
            );
            for (const r of prev) affectedDays.add(r.d);
            await query(`DELETE FROM orders_raw WHERE order_code = $1`, [a.code]);
            continue;
          }

          const ent = await getOrderEntries(order.id);
          for (const entry of ent.data ?? []) {
            const ea = entry.attributes;
            const sku = ea.offer?.code;
            if (!sku) continue;
            await upsertSku(sku, ea.offer?.name ?? '', ea.category?.code ?? null);
            await upsertOrderEntry({
              code: a.code,
              entryNumber: ea.entryNumber,
              sku,
              day,
              sum: ea.totalPrice ?? 0,
              qty: ea.quantity ?? 0,
              // доставка продавца — на заказ; вешаем на первую позицию, чтобы не задвоить
              delivery: ea.entryNumber === 0 ? (a.deliveryCostForSeller ?? 0) : 0,
              status: a.status,
              state: a.state,
              raw: a,
            });
            entriesUpserted++;
          }
          affectedDays.add(day);
        }

        const pageCount = res.meta?.pageCount ?? 1;
        page++;
        if (page % 5 === 0 || page >= pageCount) {
          console.log(`[sync] страница ${page}/${pageCount}, заказов ${ordersSeen}, позиций ${entriesUpserted}`);
        }
        if (page >= pageCount) break;
      }
    }

    await rebuildSalesDaily([...affectedDays]);
    await writeMeta(true, maxCreation);
    console.log(`[sync] ГОТОВО: заказов ${ordersSeen}, позиций ${entriesUpserted}, дней ${affectedDays.size}`);
    return { ok: true, ordersSeen, entriesUpserted, days: affectedDays.size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // даже при сбое пересобираем агрегат по уже скачанным дням — данные не теряем
    try { await rebuildSalesDaily([...affectedDays]); } catch { /* ignore */ }
    await writeMeta(false, maxCreation, msg);
    return { ok: false, ordersSeen, entriesUpserted, days: affectedDays.size, error: msg };
  }
}

/** Фоновый loop (для сервера). Первый прогон сразу, затем по интервалу. */
export function startSyncLoop(): NodeJS.Timeout {
  void runOrdersSync();
  return setInterval(() => void runOrdersSync(), config.kaspi.syncInterval * 1000);
}
