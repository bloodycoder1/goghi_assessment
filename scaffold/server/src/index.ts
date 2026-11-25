import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, ensureIndexes, getDb } from './db.js';
import { closeRedis, getRedis } from './redis.js';
import { OutboxWorker } from './services/outboxWorker.js';
import { attachWebSocketServer } from './wsServer.js';

const app = createApp();
const server = createServer(app);
const outboxWorker = new OutboxWorker();
const wsManager = attachWebSocketServer(server);

async function start(): Promise<void> {
  await getDb();
  await ensureIndexes();
  await getRedis().ping();

  outboxWorker.start();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);

  const forceExit = setTimeout(() => {
    process.exit(1);
  }, 5000);
  forceExit.unref();

  await outboxWorker.stop();
  await wsManager.close();
  server.closeIdleConnections?.();
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
