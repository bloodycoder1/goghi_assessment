import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, ensureIndexes, getDb } from './db.js';
import { closeRedis, getRedis } from './redis.js';
import { OutboxWorker } from './services/outboxWorker.js';

const app = createApp();
const server = createServer(app);
const outboxWorker = new OutboxWorker();

async function start(): Promise<void> {
  await getDb();
  await ensureIndexes();
  await getRedis().ping();

  outboxWorker.start();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  await outboxWorker.stop();
  server.close(async () => {
    await Promise.allSettled([closeDb(), closeRedis()]);
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

start().catch((err) => {
  console.error('failed to start server:', err);
  process.exit(1);
});
