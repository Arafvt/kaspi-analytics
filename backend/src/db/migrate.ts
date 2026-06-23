import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, closePool } from './pool.js';

/**
 * Идемпотентная миграция: прогоняет schema.sql.
 * Вызывается на старте сервиса и доступна как `npm run migrate`.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(sql);
}

// Запуск напрямую: tsx src/db/migrate.ts
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate()
    .then(() => console.log('schema applied'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(closePool);
}
