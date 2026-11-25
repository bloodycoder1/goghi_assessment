const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export async function generateAgentKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

export async function exportPublicKeyJwk(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key);
}

export async function importPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

export async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

async function deriveSharedAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(16),
      info: encoder.encode('switchboard-e2ee-ws-key-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapWorkspaceKeyForAgent(
  workspaceKey: CryptoKey,
  recipientPublicKey: CryptoKey
): Promise<{
  wrappedKey: string;
  ephemeralPublicKeyJwk: JsonWebKey;
  iv: string;
}> {
  const ephemeral = await generateAgentKeyPair();
  const wrappingKey = await deriveSharedAesKey(ephemeral.privateKey, recipientPublicKey);
  const rawWsKey = new Uint8Array(await crypto.subtle.exportKey('raw', workspaceKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawWsKey)
  );
  return {
    wrappedKey: toBase64(encrypted),
    ephemeralPublicKeyJwk: await exportPublicKeyJwk(ephemeral.publicKey),
    iv: toBase64(iv),
  };
}

export async function unwrapWorkspaceKey(
  envelope: {
    wrappedKey: string;
    ephemeralPublicKeyJwk: JsonWebKey;
    iv: string;
  },
  recipientPrivateKey: CryptoKey
): Promise<CryptoKey> {
  const ephPub = await importPublicKeyJwk(envelope.ephemeralPublicKeyJwk);
  const wrappingKey = await deriveSharedAesKey(recipientPrivateKey, ephPub);
  const rawWsKey = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(envelope.iv) as BufferSource },
    wrappingKey,
    fromBase64(envelope.wrappedKey) as BufferSource
  );
  return crypto.subtle.importKey(
    'raw',
    rawWsKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function encryptNote(
  plaintext: string,
  workspaceKey: CryptoKey,
  aad: string
): Promise<{ ciphertext: string; iv: string; aad: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encoder.encode(aad),
      },
      workspaceKey,
      encoder.encode(plaintext)
    )
  );
  return {
    ciphertext: toBase64(encrypted),
    iv: toBase64(iv),
    aad,
  };
}

export async function decryptNote(
  note: { ciphertext: string; iv: string; aad: string },
  workspaceKey: CryptoKey
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(note.iv) as BufferSource,
      additionalData: encoder.encode(note.aad),
    },
    workspaceKey,
    fromBase64(note.ciphertext) as BufferSource
  );
  return decoder.decode(decrypted);
}
