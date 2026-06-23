/**
 * Конфигурация из переменных окружения.
 * Единая точка чтения .env — нигде больше process.env не дёргаем.
 */

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? Number(v) : fallback;
}

export const config = {
  port: num('PORT', 8080),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  kaspi: {
    token: required('KASPI_API_TOKEN'),
    base: process.env.KASPI_API_BASE ?? 'https://kaspi.kz/shop/api',
    syncInterval: num('KASPI_SYNC_INTERVAL', 1800),
    backfillDays: num('KASPI_BACKFILL_DAYS', 60),
    pageSize: num('KASPI_PAGE_SIZE', 100),
  },

  db: {
    url: required('DATABASE_URL'),
  },

  tzOffset: process.env.TZ_OFFSET ?? '+05',
  taxRateDefault: num('TAX_RATE_DEFAULT', 0.03),
} as const;

export type Config = typeof config;
