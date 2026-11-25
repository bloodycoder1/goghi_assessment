import crypto from 'node:crypto';
import { COLLECTIONS, getDb } from '../db.js';
import { publishWorkspaceEvent } from './realtime.js';

export interface AgentKeyDoc {
  sub: string;
  publicKeyJwk: Record<string, unknown>;
  updatedAt: Date;
}

export interface WorkspaceKeyEnvelopeDoc {
  workspace: string;
  recipientSub: string;
  senderSub: string;
  keyVersion: number;
  wrappedKey: string;
  ephemeralPublicKeyJwk: Record<string, unknown>;
  iv: string;
  createdAt: Date;
}

export interface PrivateNoteDoc {
  noteId: string;
  workspace: string;
  contact: string;
  authorSub: string;
  ciphertext: string;
  iv: string;
  aad: string;
  keyVersion: number;
  createdAt: Date;
}

export async function registerAgentPublicKey(
  sub: string,
  publicKeyJwk: Record<string, unknown>
): Promise<void> {
  const db = await getDb();
  await db.collection<AgentKeyDoc>(COLLECTIONS.agentKeys).updateOne(
    { sub },
    { $set: { sub, publicKeyJwk, updatedAt: new Date() } },
    { upsert: true }
  );
}

export async function getWorkspaceKeyBundle(workspace: string, sub: string) {
  const db = await getDb();
  const [envelopes, agentKeys] = await Promise.all([
    db
      .collection<WorkspaceKeyEnvelopeDoc>(COLLECTIONS.workspaceKeyEnvelopes)
      .find({ workspace, recipientSub: sub })
      .sort({ keyVersion: -1 })
      .toArray(),
    db.collection<AgentKeyDoc>(COLLECTIONS.agentKeys).find({}).toArray(),
  ]);
  return { envelopes, agentKeys };
}

export async function storeWorkspaceKeyEnvelope(input: {
  workspace: string;
  recipientSub: string;
  senderSub: string;
  keyVersion: number;
  wrappedKey: string;
  ephemeralPublicKeyJwk: Record<string, unknown>;
  iv: string;
}): Promise<void> {
  const db = await getDb();
  await db.collection<WorkspaceKeyEnvelopeDoc>(COLLECTIONS.workspaceKeyEnvelopes).updateOne(
    {
      workspace: input.workspace,
      recipientSub: input.recipientSub,
      keyVersion: input.keyVersion,
    },
    {
      $set: {
        senderSub: input.senderSub,
        wrappedKey: input.wrappedKey,
        ephemeralPublicKeyJwk: input.ephemeralPublicKeyJwk,
        iv: input.iv,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

export async function createEncryptedNote(input: {
  workspace: string;
  contact: string;
  authorSub: string;
  ciphertext: string;
  iv: string;
  aad: string;
  keyVersion: number;
}): Promise<PrivateNoteDoc> {
  const db = await getDb();
  const doc: PrivateNoteDoc = {
    noteId: `note_${crypto.randomUUID()}`,
    workspace: input.workspace,
    contact: input.contact,
    authorSub: input.authorSub,
    ciphertext: input.ciphertext,
    iv: input.iv,
    aad: input.aad,
    keyVersion: input.keyVersion,
    createdAt: new Date(),
  };

  await db.collection<PrivateNoteDoc>(COLLECTIONS.privateNotes).insertOne(doc);

  // Publish only opaque metadata on WebSocket; never plaintext or key material
  await publishWorkspaceEvent(input.workspace, 'note.created', {
    contact: input.contact,
    note_id: doc.noteId,
    author_sub: input.authorSub,
    key_version: input.keyVersion,
    created_at: doc.createdAt.toISOString(),
  });

  return doc;
}

export async function listEncryptedNotes(
  workspace: string,
  contact: string
): Promise<PrivateNoteDoc[]> {
  const db = await getDb();
  return db
    .collection<PrivateNoteDoc>(COLLECTIONS.privateNotes)
    .find({ workspace, contact })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
}
