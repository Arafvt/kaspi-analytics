/**
 * Разовый запуск синка с хоста (для бэкфилла / проверки).
 *   npx tsx src/scripts/runSync.ts 2026-06-01   ← тянуть с даты
 *   npx tsx src/scripts/runSync.ts 7            ← тянуть за N дней
 * Грузит .env из корня проекта и подменяет DATABASE_URL на localhost:5433.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '../../../.env'); // scripts → src → backend → root

for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  const k = line.slice(0, i).trim();
  const v = line.slice(i + 1).trim();
  if (!(k in process.env)) process.env[k] = v;
}
// запуск с хоста → Postgres на localhost:5433
process.env.DATABASE_URL = 'postgres://kaspi_user:kaspi_pass@localhost:5433/kaspi_rnp';

const arg = process.argv[2] ?? '7';
// дата YYYY-MM-DD → начало дня Asia/Almaty (UTC+5); иначе число = дней назад
let opts: { fromTs?: number; daysBack?: number };
let label: string;
if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
  const [y, m, d] = arg.split('-').map(Number) as [number, number, number];
  const fromTs = Date.UTC(y, m - 1, d) - 5 * 3_600_000;
  opts = { fromTs };
  label = `с ${arg}`;
} else {
  opts = { daysBack: Number(arg) };
  label = `за ${arg} дн`;
}
console.log(`[runSync] старт, окно ${label}`);

// динамический импорт — после установки process.env (config читается при импорте)
const { runOrdersSync } = await import('../services/sync.js');
const { closePool } = await import('../db/pool.js');

const started = Date.now();
const res = await runOrdersSync(opts);
console.log(`[runSync] готово за ${((Date.now() - started) / 1000).toFixed(0)}с:`, JSON.stringify(res));
await closePool();
