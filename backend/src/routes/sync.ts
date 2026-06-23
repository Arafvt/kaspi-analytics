import type { FastifyInstance } from 'fastify';
import { runOrdersSync } from '../services/sync.js';
import { query } from '../db/pool.js';

/** Ручной триггер синка и его статус. */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sync/orders', async () => {
    return runOrdersSync();
  });

  app.get('/api/sync/status', async () => {
    const rows = await query(
      `SELECT kind, last_run_at, last_ok, last_error, cursor_ts
       FROM sync_meta WHERE kind = 'orders'`,
    );
    return rows[0] ?? { kind: 'orders', last_run_at: null, last_ok: null };
  });
}
