# End-to-End Encrypted Private Notes Protocol (`PROTOCOL.md`)

Switchboard supports **end-to-end encrypted (E2EE) private notes** on conversations so support agents in the same workspace can leave internal notes without the Switchboard server ever seeing plaintext.

## 1. Key Custody (Who Holds Which Key)

| Key | Algorithm | Holder | Server Access |
| --- | --- | --- | --- |
| **Agent Identity Keypair** (`pub_agent`, `priv_agent`) | ECDH P-256 | Generated in the agent's browser (WebCrypto). `priv_agent` never leaves the client. | Server stores `pub_agent` (JWK) only. |
| **Workspace Data Key** (`K_ws`, versioned `keyVersion`) | AES-256-GCM | Generated client-side by an existing workspace member and shared via per-recipient ECDH key wrapping. | Server **never** sees `K_ws` in plaintext. |
| **Wrapped Key Envelope** | ECDH P-256 + HKDF-SHA256 + AES-256-GCM | Stored on the server per `(workspace, recipientSub, keyVersion)`. | Server stores opaque `wrappedKey`, `ephemeralPublicKeyJwk`, and `iv`. |

## 2. What the Server Stores

1. **`agent_keys`**
   - `{ sub, publicKeyJwk, updatedAt }`
2. **`workspace_key_envelopes`**
   - `{ workspace, recipientSub, senderSub, keyVersion, wrappedKey, ephemeralPublicKeyJwk, iv, createdAt }`
3. **`private_notes`**
   - `{ noteId, workspace, contact, authorSub, ciphertext, iv, aad, keyVersion, createdAt }`
   - `aad` binds the ciphertext to `${workspace}:${contact}:${keyVersion}` so notes cannot be transplanted across workspaces or contacts.
   - `POST /api/conversations/:contact/notes` explicitly rejects requests containing unencrypted `plaintext` or `text` fields (`400`).

## 3. Three Attacks This Scheme Does NOT Stop

1. **Malicious Server Serving Compromised Client Code or Key Substitution:**
   Because the web app is served by the server and agent public keys are distributed without out-of-band fingerprint verification (TOFU/Safety Numbers) or a signed key-transparency log, a compromised server can serve malicious JS or substitute an attacker's `publicKeyJwk`.
2. **Compromised Agent Endpoint / XSS:**
   Any attacker who achieves JavaScript execution (XSS) or device compromise in an authenticated agent's browser can read `priv_agent`, unwrap `K_ws`, and decrypt every private note in that workspace.
3. **Metadata Leakage & Historical Access After Member Removal:**
   The server still observes `workspace`, `contact`, `authorSub`, `createdAt`, and ciphertext length (traffic/timing analysis). Additionally, a removed workspace member who previously cached `K_ws` can still decrypt historical notes encrypted under that `keyVersion` until `K_ws` is rotated (forward-only for new notes).
