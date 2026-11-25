import express, { type Express } from 'express';
import { config } from './config.js';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { graderRouter } from './routes/grader.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp(): Express {
  const app = express();

  // CORS for React frontend with session cookie
  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin && origin === config.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

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

  app.use('/auth', authRouter);
  app.use('/api', apiRouter);
  app.use('/__grader', graderRouter);

  return app;
}
