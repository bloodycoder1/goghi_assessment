import express, { Router, type Request, type Response } from 'express';
import { handlePayboxWebhook } from '../services/billing.js';
import {
  handlePigeonEvent,
  verifyPigeonSignature,
  type PigeonWebhookPayload,
} from '../services/pigeonWebhook.js';

export const webhooksRouter = Router();

webhooksRouter.post(
  '/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');

    const sigCheck = verifyPigeonSignature(rawBody, req.header('x-pigeon-signature'));
    if (!sigCheck.ok) {
      res.status(401).json({ error: sigCheck.reason ?? 'Invalid signature' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      res.status(400).json({ error: 'Body must be a JSON object' });
      return;
    }

    try {
      await handlePigeonEvent(
        parsed as PigeonWebhookPayload,
        req.header('x-pigeon-event-id')
      );
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('pigeon webhook error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);

webhooksRouter.post(
  '/paybox',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');

    try {
      const result = await handlePayboxWebhook(rawBody, req.header('x-paybox-signature'));
      res.status(result.status).json(result.body);
    } catch (err) {
      console.error('paybox webhook error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  }
);
