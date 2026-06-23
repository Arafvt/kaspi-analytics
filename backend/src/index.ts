import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/env.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { startSyncLoop } from './services/sync.js';
import { rnpRoutes } from './routes/rnp.js';
import { costsRoutes } from './routes/costs.js';
import { syncRoutes } from './routes/sync.js';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: config.logLevel } });
  await app.register(cors, { origin: true });

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(rnpRoutes);
  await app.register(costsRoutes);
  await app.register(syncRoutes);

  // Идемпотентная миграция при старте
  await migrate();

  // Фоновый синк заказов (можно выключить: SYNC_LOOP=off)
  const loop = process.env.SYNC_LOOP === 'off' ? null : startSyncLoop();

  const shutdown = async (): Promise<void> => {
    if (loop) clearInterval(loop);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
