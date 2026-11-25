import crypto from 'node:crypto';
import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import { getRedis } from '../redis.js';
import type { BillingStatus, BillingWorkspaceDoc, WebhookEventDoc } from '../types.js';
import { UnknownWorkspaceError } from './outbound.js';
import { publishWorkspaceEvent } from './realtime.js';

const SEAT_PRICE_ID = 'price_seat_monthly';
const WEBHOOK_TOLERANCE_SEC = 300;

export function canWorkspaceSend(status: BillingStatus): boolean {
  // Never-subscribed ('none'), active, and past_due (grace window during retries) can send.
  return status === 'none' || status === 'active' || status === 'past_due';
}

export async function getWorkspaceBilling(workspace: string): Promise<{
  status: BillingStatus;
  seats: number;
  can_send: boolean;
  nextActionUrl: string | null;
  cancelAtPeriodEnd: boolean;
}> {
  const db = await getDb();
  const doc = await db
    .collection<BillingWorkspaceDoc>(COLLECTIONS.billingWorkspaces)
    .findOne({ workspace });

  const status: BillingStatus = doc?.status ?? 'none';
  const seats = doc?.seats ?? 0;
  return {
    status,
    seats,
    can_send: canWorkspaceSend(status),
    nextActionUrl: doc?.nextActionUrl ?? null,
    cancelAtPeriodEnd: Boolean(doc?.cancelAtPeriodEnd),
  };
}

export async function isWorkspaceSendAllowed(workspace: string): Promise<boolean> {
  const billing = await getWorkspaceBilling(workspace);
  return billing.can_send;
}

async function withWorkspaceBillingLock<T>(
  workspace: string,
  fn: () => Promise<T>
): Promise<T> {
  const redis = getRedis();
  const lockKey = `billing:lock:${workspace}`;
  const lockVal = crypto.randomUUID();
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const acquired = await redis.set(lockKey, lockVal, 'PX', 15_000, 'NX');
    if (acquired === 'OK') {
      try {
        return await fn();
      } finally {
        const cur = await redis.get(lockKey);
        if (cur === lockVal) {
          await redis.del(lockKey);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Billing lock timeout');
}

async function payboxRequest(
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const fetchFn = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.paybox.secretKey}`,
  };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const res = await fetchFn(`${config.paybox.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // ignore non-json
  }
  return { ok: res.ok, status: res.status, data };
}

function normalizeBillingStatus(raw: unknown): BillingStatus {
  if (
    raw === 'incomplete' ||
    raw === 'active' ||
    raw === 'past_due' ||
    raw === 'canceled'
  ) {
    return raw;
  }
  return 'incomplete';
}

function extractNextActionUrl(sub: Record<string, unknown>): string | null {
  const latestInvoice = sub.latest_invoice as Record<string, unknown> | undefined;
  const payment = latestInvoice?.payment as Record<string, unknown> | undefined;
  const nextAction = payment?.next_action as Record<string, unknown> | undefined;
  return typeof nextAction?.url === 'string' ? nextAction.url : null;
}

export async function subscribeWorkspace(
  input: { workspace: string; seats: number; token: string },
  fetchImpl: typeof fetch = fetch
): Promise<{
  ok: boolean;
  statusCode: number;
  billing: Awaited<ReturnType<typeof getWorkspaceBilling>>;
}> {
  if (!config.pigeon.apiKeys[input.workspace]) {
    throw new UnknownWorkspaceError(`Unknown workspace: ${input.workspace}`);
  }
  const seats = Math.max(1, Math.floor(input.seats));

  return withWorkspaceBillingLock(input.workspace, async () => {
    const db = await getDb();
    const col = db.collection<BillingWorkspaceDoc>(COLLECTIONS.billingWorkspaces);
    const existing = await col.findOne({ workspace: input.workspace });

    let customerId = existing?.customerId;
    if (!customerId) {
      const custRes = await payboxRequest('/v1/customers', {
        method: 'POST',
        body: {
          name: input.workspace,
          email: `${input.workspace}@switchboard.test`,
          metadata: { workspace: input.workspace },
        },
        idempotencyKey: `cust_${input.workspace}`,
        fetchImpl,
      });
      if (!custRes.ok || typeof custRes.data.id !== 'string') {
        const billing = await getWorkspaceBilling(input.workspace);
        return { ok: false, statusCode: 402, billing };
      }
      customerId = custRes.data.id;
    }

    const pmRes = await payboxRequest(`/v1/customers/${customerId}/payment_method`, {
      method: 'POST',
      body: { token: input.token },
      idempotencyKey: `pm_${input.workspace}_${input.token}`,
      fetchImpl,
    });
    if (!pmRes.ok) {
      await col.updateOne(
        { workspace: input.workspace },
        { $set: { customerId, updatedAt: new Date() }, $setOnInsert: { status: 'none', seats: 0 } },
        { upsert: true }
      );
      const billing = await getWorkspaceBilling(input.workspace);
      return { ok: false, statusCode: 402, billing };
    }

    let subData: Record<string, unknown> | null = null;

    if (existing?.subscriptionId && existing.status === 'active') {
      if (existing.seats !== seats) {
        const upd = await payboxRequest(`/v1/subscriptions/${existing.subscriptionId}`, {
          method: 'POST',
          body: { quantity: seats },
          idempotencyKey: `sub_upd_${input.workspace}_${seats}_${input.token}`,
          fetchImpl,
        });
        if (!upd.ok) {
          const billing = await getWorkspaceBilling(input.workspace);
          return { ok: false, statusCode: 402, billing };
        }
        subData = upd.data;
      } else {
        const getRes = await payboxRequest(`/v1/subscriptions/${existing.subscriptionId}`, {
          fetchImpl,
        });
        subData = getRes.ok ? getRes.data : null;
      }
    }

    if (!subData) {
      const subRes = await payboxRequest('/v1/subscriptions', {
        method: 'POST',
        body: {
          customer: customerId,
          price: SEAT_PRICE_ID,
          quantity: seats,
        },
        idempotencyKey: `sub_create_${input.workspace}_${input.token}`,
        fetchImpl,
      });
      if (!subRes.ok || typeof subRes.data.id !== 'string') {
        const billing = await getWorkspaceBilling(input.workspace);
        return { ok: false, statusCode: 402, billing };
      }
      subData = subRes.data;
    }

    const status = normalizeBillingStatus(subData.status);
    const subscriptionId = typeof subData.id === 'string' ? subData.id : existing?.subscriptionId;
    const finalSeats = typeof subData.quantity === 'number' ? subData.quantity : seats;
    const nextActionUrl = extractNextActionUrl(subData);

    await col.updateOne(
      { workspace: input.workspace },
      {
        $set: {
          customerId,
          subscriptionId,
          status,
          seats: finalSeats,
          nextActionUrl,
          cancelAtPeriodEnd: Boolean(subData.cancel_at_period_end),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    const billing = await getWorkspaceBilling(input.workspace);
    return {
      ok: status === 'active',
      statusCode: status === 'active' ? 200 : 402,
      billing,
    };
  });
}

export async function updateWorkspaceSeats(
  input: { workspace: string; seats: number },
  fetchImpl: typeof fetch = fetch
): Promise<{
  ok: boolean;
  statusCode: number;
  billing: Awaited<ReturnType<typeof getWorkspaceBilling>>;
}> {
  if (!config.pigeon.apiKeys[input.workspace]) {
    throw new UnknownWorkspaceError(`Unknown workspace: ${input.workspace}`);
  }
  const seats = Math.max(1, Math.floor(input.seats));

  return withWorkspaceBillingLock(input.workspace, async () => {
    const db = await getDb();
    const col = db.collection<BillingWorkspaceDoc>(COLLECTIONS.billingWorkspaces);
    const existing = await col.findOne({ workspace: input.workspace });
    if (!existing?.subscriptionId) {
      const billing = await getWorkspaceBilling(input.workspace);
      return { ok: false, statusCode: 402, billing };
    }

    const upd = await payboxRequest(`/v1/subscriptions/${existing.subscriptionId}`, {
      method: 'POST',
      body: { quantity: seats },
      idempotencyKey: `seats_${input.workspace}_${seats}_${Date.now()}`,
      fetchImpl,
    });

    if (!upd.ok) {
      const billing = await getWorkspaceBilling(input.workspace);
      return { ok: false, statusCode: 402, billing };
    }

    const status = normalizeBillingStatus(upd.data.status);
    const finalSeats = typeof upd.data.quantity === 'number' ? upd.data.quantity : seats;

    await col.updateOne(
      { workspace: input.workspace },
      {
        $set: {
          status,
          seats: finalSeats,
          nextActionUrl: extractNextActionUrl(upd.data),
          cancelAtPeriodEnd: Boolean(upd.data.cancel_at_period_end),
          updatedAt: new Date(),
        },
      }
    );

    const billing = await getWorkspaceBilling(input.workspace);
    return { ok: true, statusCode: 200, billing };
  });
}

export function verifyPayboxSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return idx === -1 ? ['', ''] : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    })
  );

  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', config.paybox.webhookSecret)
    .update(`${t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function handlePayboxWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!verifyPayboxSignature(rawBody, signatureHeader)) {
    return { status: 401, body: { error: 'Invalid Paybox signature' } };
  }

  let event: {
    id?: unknown;
    type?: unknown;
    data?: { object?: Record<string, unknown> };
  };
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } };
  }

  const eventId = typeof event.id === 'string' ? event.id : '';
  const type = typeof event.type === 'string' ? event.type : '';
  const obj = event.data?.object;
  if (!eventId || !type || !obj) {
    return { status: 400, body: { error: 'Malformed webhook event' } };
  }

  const db = await getDb();
  try {
    await db.collection<WebhookEventDoc>(COLLECTIONS.webhookEvents).insertOne({
      eventId: `paybox:${eventId}`,
      type,
      workspace: 'paybox',
      receivedAt: new Date(),
    });
  } catch {
    // Duplicate event already processed
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const subscriptionId = type.startsWith('customer.subscription.')
    ? (obj.id as string | undefined)
    : (obj.subscription as string | undefined);

  if (!subscriptionId) {
    return { status: 200, body: { ok: true } };
  }

  // Always read live subscription state from Paybox so out-of-order events don't regress state.
  const subRes = await payboxRequest(`/v1/subscriptions/${subscriptionId}`, { fetchImpl });
  if (!subRes.ok) {
    return { status: 200, body: { ok: true } };
  }

  const liveSub = subRes.data;
  const col = db.collection<BillingWorkspaceDoc>(COLLECTIONS.billingWorkspaces);

  let workspace =
    (liveSub.metadata as Record<string, unknown> | undefined)?.workspace as string | undefined;
  if (!workspace) {
    const found = await col.findOne({ subscriptionId });
    workspace = found?.workspace;
  }
  if (!workspace) {
    return { status: 200, body: { ok: true } };
  }

  const status = normalizeBillingStatus(liveSub.status);
  const seats = typeof liveSub.quantity === 'number' ? liveSub.quantity : 0;
  const nextActionUrl = extractNextActionUrl(liveSub);

  await col.updateOne(
    { workspace },
    {
      $set: {
        subscriptionId,
        customerId: typeof liveSub.customer === 'string' ? liveSub.customer : undefined,
        status,
        seats,
        nextActionUrl,
        cancelAtPeriodEnd: Boolean(liveSub.cancel_at_period_end),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  await publishWorkspaceEvent(workspace, 'billing.updated', {
    status,
    seats,
    can_send: canWorkspaceSend(status),
  });

  return { status: 200, body: { ok: true } };
}
