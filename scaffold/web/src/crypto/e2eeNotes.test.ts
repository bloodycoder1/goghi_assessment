import { describe, expect, it } from 'vitest';
import {
  decryptNote,
  encryptNote,
  exportPublicKeyJwk,
  generateAgentKeyPair,
  generateWorkspaceKey,
  importPublicKeyJwk,
  unwrapWorkspaceKey,
  wrapWorkspaceKeyForAgent,
} from './e2eeNotes';

describe('Module 8: Client-side E2EE Private Notes Crypto', () => {
  it('wraps workspace key for another agent and encrypts/decrypts notes with AAD', async () => {
    const bobKeys = await generateAgentKeyPair();
    const bobPubJwk = await exportPublicKeyJwk(bobKeys.publicKey);
    const bobPubImported = await importPublicKeyJwk(bobPubJwk);

    const wsKey = await generateWorkspaceKey();
    const envelope = await wrapWorkspaceKeyForAgent(wsKey, bobPubImported);
    const unwrappedByBob = await unwrapWorkspaceKey(envelope, bobKeys.privateKey);

    const aad = 'ws_acme:+14155550101:1';
    const encrypted = await encryptNote('VIP customer, handle carefully', wsKey, aad);
    expect(encrypted.ciphertext).not.toContain('VIP customer');

    const decrypted = await decryptNote(encrypted, unwrappedByBob);
    expect(decrypted).toBe('VIP customer, handle carefully');

    // Tampered AAD must fail decryption
    await expect(
      decryptNote({ ...encrypted, aad: 'ws_globex:+14155550101:1' }, unwrappedByBob)
    ).rejects.toThrow();
  });
});
