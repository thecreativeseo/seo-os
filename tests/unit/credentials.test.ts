import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import {
  CredentialCryptoError,
  createOAuthState,
  decryptCredential,
  encryptCredential,
  verifyOAuthState,
} from "@/server/crypto/credentials";

/**
 * A refresh token is a long-lived key to someone else's Search Console data, so
 * these cover the failure modes that would matter: plaintext leaking, tampering
 * going unnoticed, and a forged callback attaching an attacker's Google account to
 * someone else's website.
 */

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("credential encryption", () => {
  it("round-trips a token", () => {
    const token = "1//0eXaMpLe-refresh-token-value";
    const { ciphertext } = encryptCredential(token);

    expect(decryptCredential(ciphertext)).toBe(token);
  });

  it("never stores the plaintext", () => {
    const token = "1//0eXaMpLe-refresh-token-value";
    const { ciphertext } = encryptCredential(token);

    expect(ciphertext).not.toContain(token);
    expect(ciphertext).not.toContain("refresh");
  });

  it("produces different ciphertext each time", () => {
    // A fresh IV per encryption, so identical tokens cannot be spotted by
    // comparing rows.
    const a = encryptCredential("same-token").ciphertext;
    const b = encryptCredential("same-token").ciphertext;

    expect(a).not.toBe(b);
    expect(decryptCredential(a)).toBe(decryptCredential(b));
  });

  it("records the key version so rotation does not require re-authorisation", () => {
    const { keyVersion, ciphertext } = encryptCredential("token");
    expect(keyVersion).toBe(1);
    expect(ciphertext.startsWith("v1.")).toBe(true);
  });

  it("refuses ciphertext that has been altered", () => {
    const { ciphertext } = encryptCredential("token");
    const parts = ciphertext.split(".");
    // Flip a character in the encrypted body.
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      `${parts[3]!.slice(0, -1)}${parts[3]!.slice(-1) === "A" ? "B" : "A"}`,
    ].join(".");

    // Authenticated encryption: tampering fails loudly rather than decrypting to a
    // plausible wrong value.
    expect(() => decryptCredential(tampered)).toThrow(CredentialCryptoError);
  });

  it("refuses a malformed payload", () => {
    expect(() => decryptCredential("not-a-payload")).toThrow(CredentialCryptoError);
    expect(() => decryptCredential("")).toThrow(CredentialCryptoError);
  });

  it("refuses to decrypt with a different key", () => {
    const { ciphertext } = encryptCredential("token");
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;

    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptCredential(ciphertext)).toThrow(CredentialCryptoError);

    process.env.CREDENTIAL_ENCRYPTION_KEY = original;
  });

  it("fails loudly when the key is missing or the wrong size", () => {
    const original = process.env.CREDENTIAL_ENCRYPTION_KEY;

    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredential("token")).toThrow(/not set/i);

    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");
    expect(() => encryptCredential("token")).toThrow(/32 bytes/i);

    process.env.CREDENTIAL_ENCRYPTION_KEY = original;
  });
});

describe("oauth state", () => {
  const input = {
    websiteId: "11111111-1111-1111-1111-111111111111",
    provider: "GOOGLE_SEARCH_CONSOLE",
    userId: "22222222-2222-2222-2222-222222222222",
  };

  it("round-trips the website and provider it was issued for", () => {
    const state = verifyOAuthState(createOAuthState(input));

    expect(state.websiteId).toBe(input.websiteId);
    expect(state.provider).toBe(input.provider);
    expect(state.userId).toBe(input.userId);
  });

  it("rejects a forged state", () => {
    // Without verification, anyone could send a user to the callback with their own
    // code and attach their Google account to someone else's website.
    const forged = Buffer.from(
      JSON.stringify({ ...input, issuedAt: Date.now(), nonce: "x" }),
      "utf8",
    ).toString("base64url");

    expect(() => verifyOAuthState(`${forged}.not-a-real-signature`)).toThrow(
      CredentialCryptoError,
    );
  });

  it("rejects a state whose payload was edited after signing", () => {
    const original = createOAuthState(input);
    const [, signature] = original.split(".");

    const swapped = Buffer.from(
      JSON.stringify({
        ...input,
        websiteId: "99999999-9999-9999-9999-999999999999",
        issuedAt: Date.now(),
        nonce: "x",
      }),
      "utf8",
    ).toString("base64url");

    expect(() => verifyOAuthState(`${swapped}.${signature}`)).toThrow(CredentialCryptoError);
  });

  it("rejects a malformed state", () => {
    expect(() => verifyOAuthState("nonsense")).toThrow(CredentialCryptoError);
    expect(() => verifyOAuthState("")).toThrow(CredentialCryptoError);
  });

  it("produces a different state each time", () => {
    expect(createOAuthState(input)).not.toBe(createOAuthState(input));
  });
});
