import crypto from 'node:crypto';
import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import type { ConversationDoc, MessageDoc, OutboundStatus, WebhookEventDoc } from '../types.js';

export interface SignatureCheckResult {
  ok: boolean;
  reason?: string;
}

const MAX_TIMESTAMP_AGE_SEC = 300; // 5 minutes

export function verifyPigeonSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): SignatureCheckResult {
  if (!signatureHeader) {
    return { ok: false, reason: 'missing signature' };
  }

  let timestampStr: string | undefined;
  let v1Hex: string | undefined;

  for (const part of signatureHeader.split(',')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key === 't') timestampStr = val;
    else if (key === 'v1') v1Hex = val;
  }

  if (!timestampStr || !v1Hex || !/^\d+$/.test(timestampStr) || !/^[0-9a-fA-F]{64}$/.test(v1Hex)) {
    return { ok: false, reason: 'malformed signature' };
  }

  const t = Number(timestampStr);
  if (!Number.isSafeInteger(t) || Math.abs(nowSeconds - t) > MAX_TIMESTAMP_AGE_SEC) {
    return { ok: false, reason: 'timestamp out of window' };
  }

  const signedPayload = `${timestampStr}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(signedPayload)
    .digest();
  const actual = Buffer.from(v1Hex, 'hex');

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

const STATUS_RANK: Record<OutboundStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  failed: 2,
};

export interface PigeonWebhookPayload {
  id?: unknown;
  type?: unknown;
  workspace?: unknown;
  occurred_at?: unknown;
  data?: Record<string, unknown>;
}

export async function handlePigeonEvent(
  payload: PigeonWebhookPayload,
  headerEventId?: string
): Promise<void> {
  const workspace = typeof payload.workspace === 'string' ? payload.workspace : '';
  const type = typeof payload.type === 'string' ? payload.type : '';
  const eventId =
    typeof payload.id === 'string' && payload.id.length > 0
      ? payload.id
      : headerEventId ?? '';

  // Unknown workspace: ignore with 2xx
  if (!workspace || !(workspace in config.pigeon.apiKeys)) {
    return;
  }

  const db = await getDb();

  // Deduplicate by eventId when present
  if (eventId) {
    try {
      await db.collection<WebhookEventDoc>(COLLECTIONS.webhookEvents).insertOne({
        eventId,
        type,
        workspace,
        receivedAt: new Date(),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return;
      }
      throw err;
    }
  }

  const occurredAtRaw = typeof payload.occurred_at === 'string' ? new Date(payload.occurred_at) : new Date();
  const occurredAt = Number.isNaN(occurredAtRaw.getTime()) ? new Date() : occurredAtRaw;
  const now = new Date();
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

  if (type === 'message.inbound') {
    const messageId = typeof data.message_id === 'string' ? data.message_id : '';
    const from = typeof data.from === 'string' ? data.from : '';
    const text = typeof data.text === 'string' ? data.text : '';
    if (!messageId || !from) return;

    await db.collection<ConversationDoc>(COLLECTIONS.conversations).updateOne(
      { workspace, contact: from },
      {
        $setOnInsert: {
          workspace,
          contact: from,
          assignee: null,
          status: 'open',
          createdAt: now,
        },
        $max: { lastActivityAt: occurredAt },
        $set: { updatedAt: now },
      },
      { upsert: true }
    );

    try {
      await db.collection<MessageDoc>(COLLECTIONS.messages).insertOne({
        workspace,
        contact: from,
        direction: 'inbound',
        text,
        pigeonMessageId: messageId,
        occurredAt,
        createdAt: now,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    return;
  }

  if (type === 'message.status') {
    const clientRef = typeof data.client_ref === 'string' ? data.client_ref : '';
    const status = typeof data.status === 'string' ? data.status : '';
    if (!clientRef || (status !== 'sent' && status !== 'delivered' && status !== 'failed')) {
      return;
    }

    const allowedPrevious: OutboundStatus[] =
      STATUS_RANK[status] === 1 ? ['queued'] : ['queued', 'sent'];

    await db.collection<MessageDoc>(COLLECTIONS.messages).updateOne(
      {
        workspace,
        direction: 'outbound',
        clientRef,
        status: { $in: allowedPrevious },
      },
      {
        $set: { status },
      }
    );
    return;
  }

  // Unknown event type: ignore with 2xx
}
