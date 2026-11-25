import { config } from '../config.js';
import { COLLECTIONS, getDb } from '../db.js';
import type { MessageDoc } from '../types.js';

const ES_INDEX = 'switchboard_messages';

export interface SearchHit {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  source: 'elasticsearch' | 'mongodb-fallback';
}

export async function indexMessageForSearch(
  doc: {
    id: string;
    workspace: string;
    contact: string;
    direction: 'inbound' | 'outbound';
    text: string;
    occurredAt: Date;
  },
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `${config.elasticsearchUrl}/${ES_INDEX}/_doc/${encodeURIComponent(doc.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace: doc.workspace,
          contact: doc.contact,
          direction: doc.direction,
          text: doc.text,
          occurredAt: doc.occurredAt.toISOString(),
        }),
        signal: AbortSignal.timeout(1500),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function searchWorkspaceMessages(
  workspace: string,
  query: string,
  limit = 25,
  fetchImpl: typeof fetch = fetch
): Promise<SearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { hits: [], source: 'elasticsearch' };
  }
  const safeLimit = Math.max(1, Math.min(100, limit));

  try {
    const res = await fetchImpl(`${config.elasticsearchUrl}/${ES_INDEX}/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: safeLimit,
        query: {
          bool: {
            filter: [{ term: { 'workspace.keyword': workspace } }],
            must: [
              {
                multi_match: {
                  query: trimmed,
                  fields: ['text', 'contact'],
                },
              },
            ],
          },
        },
        sort: [{ occurredAt: { order: 'desc' } }],
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.ok) {
      const body = (await res.json()) as {
        hits?: {
          hits?: Array<{
            _score?: number;
            _source?: {
              workspace?: string;
              contact?: string;
              direction?: 'inbound' | 'outbound';
              text?: string;
              occurredAt?: string;
            };
          }>;
        };
      };

      const hits: SearchHit[] = (body.hits?.hits ?? [])
        .filter((h) => h._source && h._source.workspace === workspace)
        .map((h) => ({
          workspace: h._source!.workspace!,
          contact: h._source!.contact ?? '',
          direction: h._source!.direction ?? 'inbound',
          text: h._source!.text ?? '',
          occurredAt: h._source!.occurredAt ?? new Date(0).toISOString(),
          score: h._score ?? 1,
        }));

      return { hits, source: 'elasticsearch' };
    }
  } catch {
    // Fall through to MongoDB workspace-scoped fallback when ES is offline
  }

  const db = await getDb();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'i');
  const docs = await db
    .collection<MessageDoc>(COLLECTIONS.messages)
    .find({
      workspace,
      $or: [{ text: regex }, { contact: regex }],
    })
    .sort({ occurredAt: -1 })
    .limit(safeLimit)
    .toArray();

  return {
    hits: docs.map((d) => ({
      workspace: d.workspace,
      contact: d.contact,
      direction: d.direction,
      text: d.text,
      occurredAt: d.occurredAt.toISOString(),
      score: 1,
    })),
    source: 'mongodb-fallback',
  };
}
