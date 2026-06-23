/**
 * Локальный запуск бэка для разработки:
 *   npx tsx src/scripts/devServer.ts
 * Грузит .env из корня, БД → localhost:5433, фоновый синк выключен
 * (данные тянем отдельно через runSync). Затем стартует обычный сервер.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, '../../../.env'), 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  if (!(line.slice(0, i).trim() in process.env)) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
process.env.DATABASE_URL = 'postgres://kaspi_user:kaspi_pass@localhost:5433/kaspi_rnp';
process.env.SYNC_LOOP = 'off';

await import('../index.js');
