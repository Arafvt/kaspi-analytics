import pg from 'pg';
import { config } from '../config/env.js';

/**
 * Единый пул соединений asyncpg-стиля (node-postgres).
 * pg по умолчанию парсит NUMERIC как string — приводим к number,
 * чтобы формулы РНП работали с числами.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // BIGINT

export const pool = new pg.Pool({ connectionString: config.db.url });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
