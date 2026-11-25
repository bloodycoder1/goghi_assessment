import { COLLECTIONS, getDb } from '../db.js';
import { getRedis } from '../redis.js';
import type { WsEventDoc } from '../types.js';

export function wsChannelForWorkspace(workspace: string): string {
  return `ws:events:${workspace}`;
}

export async function publishWorkspaceEvent(
  workspace: string,
  type: string,
  fields: Record<string, unknown>
): Promise<number> {
  const redis = getRedis();
  const seq = await redis.incr(`ws:seq:${workspace}`);
  const frame: Record<string, unknown> = {
    seq,
    type,
    ...fields,
  };

  const db = await getDb();
  await db.collection<WsEventDoc>(COLLECTIONS.wsEvents).insertOne({
    workspace,
    seq,
    type,
    payload: frame,
    createdAt: new Date(),
  });

  await redis.publish(wsChannelForWorkspace(workspace), JSON.stringify(frame));
  return seq;
}

export async function getMissedWorkspaceEvents(
  workspace: string,
  afterSeq: number
): Promise<Array<Record<string, unknown>>> {
  const db = await getDb();
  const docs = await db
    .collection<WsEventDoc>(COLLECTIONS.wsEvents)
    .find({ workspace, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .toArray();
  return docs.map((d) => d.payload);
}
