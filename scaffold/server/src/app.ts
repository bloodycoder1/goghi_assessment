import express, { type Express } from 'express';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { graderRouter } from './routes/grader.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp(): Express {
  const app = express();

  // Mount raw-body webhook routes before express.json()
  app.use('/webhooks', webhooksRouter);

  app.use(express.json());

  app.get('/healthz', async (_req, res) => {
    try {
      const db = await getDb();
      await db.command({ ping: 1 });
      await getRedis().ping();
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  app.use('/__grader', graderRouter);

  return app;
}
