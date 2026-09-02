import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encryption for OAuth refresh tokens (CLAUDE.md "Secrets").
 *
 * A refresh token is a long-lived key to someone else's Search Console and
 * Analytics data. It is the most sensitive thing this application will ever hold,
 * so it is never stored in plaintext and never returned by a service.
 *
 * AES-256-GCM: authenticated encryption, so ciphertext that has been tampered with
 * fails to decrypt rather than yielding a plausible-looking wrong value. Each
 * encryption uses a fresh random IV, so encrypting the same token twice produces
 * different ciphertext and nothing can be inferred by comparing rows.
 *
 * Honest limitation, stated rather than implied: the key lives in an environment
 * variable, not a managed secret manager. That is appropriate for a prototype and
 * is recorded as a finding in the phase report. keyVersion exists so a future
 * rotation does not require re-authorising every connection.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const CURRENT_KEY_VERSION = 1;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

function loadKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;

  if (!raw) {
    throw new CredentialCryptoError(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with:\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }

  const key = Buffer.from(raw, "base64");

  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`,
    );
  }

  return key;
}

export type EncryptedPayload = {
  ciphertext: string;
  keyVersion: number;
};

/**
 * Encrypts a token payload.
 *
 * The stored string is `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version
 * prefix is inside the value as well as in the column, so a payload that is moved
 * or copied still says which key encrypted it.
 */
export function encryptCredential(plaintext: string): EncryptedPayload {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: [
      `v${CURRENT_KEY_VERSION}`,
      iv.toString("base64url"),
      authTag.toString("base64url"),
      encrypted.toString("base64url"),
    ].join("."),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptCredential(payload: string): string {
  const parts = payload.split(".");

  if (parts.length !== 4 || !parts[0]!.startsWith("v")) {
    throw new CredentialCryptoError("Stored credential is malformed.");
  }

  const key = loadKey();
  const iv = Buffer.from(parts[1]!, "base64url");
  const authTag = Buffer.from(parts[2]!, "base64url");
  const ciphertext = Buffer.from(parts[3]!, "base64url");

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, or the ciphertext was altered. Both are the same answer to the
    // caller: this value cannot be trusted.
    throw new CredentialCryptoError("Stored credential could not be decrypted.");
  }
}

/**
 * OAuth `state`, signed so a callback cannot be forged.
 *
 * Without this, anyone could send a user to our callback with their own code and
 * attach an attacker-controlled Google account to the victim's website. The state
 * carries the website and provider it was issued for, and is verified before any
 * token is exchanged.
 */
export type OAuthState = {
  websiteId: string;
  provider: string;
  userId: string;
  issuedAt: number;
  nonce: string;
};

const STATE_TTL_MS = 10 * 60 * 1000;

function signState(encoded: string, key: Buffer): string {
  const cipher = createCipheriv(ALGORITHM, key, Buffer.alloc(IV_BYTES, 0));
  const encrypted = Buffer.concat([cipher.update(encoded, "utf8"), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function createOAuthState(
  input: Omit<OAuthState, "issuedAt" | "nonce">,
): string {
  const key = loadKey();
  const state: OAuthState = {
    ...input,
    issuedAt: Date.now(),
    nonce: randomBytes(12).toString("base64url"),
  };

  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${encoded}.${signState(encoded, key)}`;
}

export function verifyOAuthState(value: string): OAuthState {
  const key = loadKey();
  const [encoded, signature] = value.split(".");

  if (!encoded || !signature) {
    throw new CredentialCryptoError("Invalid OAuth state.");
  }

  const expected = Buffer.from(signState(encoded, key), "base64url");
  const provided = Buffer.from(signature, "base64url");

  // Constant-time comparison: a length check first, because timingSafeEqual throws
  // on mismatched lengths.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new CredentialCryptoError("Invalid OAuth state.");
  }

  const state = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as OAuthState;

  // A stale state is refused: an authorization left half-finished in a browser tab
  // yesterday should not complete today.
  if (Date.now() - state.issuedAt > STATE_TTL_MS) {
    throw new CredentialCryptoError("This authorization link has expired.");
  }

  return state;
}
