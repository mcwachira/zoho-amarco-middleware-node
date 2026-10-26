import { describe, expect, it } from "vitest";

import {
  decryptCodeVerifier,
  encryptCodeVerifier,
} from "../../src/integrations/zoho/verifier-encryption.js";

// Test-only keys. Never use these as production encryption keys.
const encryptionKey = "a".repeat(64);
const differentEncryptionKey = "b".repeat(64);

const verifier = "test-pkce-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

describe("Zoho PKCE verifier encryption", () => {
  it("encrypts and decrypts a verifier without changing it", () => {
    const encrypted = encryptCodeVerifier(verifier, encryptionKey);

    expect(encrypted).not.toContain(verifier);
    expect(decryptCodeVerifier(encrypted, encryptionKey)).toBe(verifier);
  });

  it("produces different encrypted payloads for the same verifier", () => {
    const first = encryptCodeVerifier(verifier, encryptionKey);
    const second = encryptCodeVerifier(verifier, encryptionKey);

    // A fresh random nonce should make each payload different.
    expect(first).not.toBe(second);

    // Both payloads must still decrypt to the original verifier.
    expect(decryptCodeVerifier(first, encryptionKey)).toBe(verifier);
    expect(decryptCodeVerifier(second, encryptionKey)).toBe(verifier);
  });

  it("rejects an empty verifier", () => {
    expect(() => encryptCodeVerifier("", encryptionKey)).toThrow("PKCE verifier must not be empty");
  });

  it("rejects a malformed encryption key", () => {
    expect(() => encryptCodeVerifier(verifier, "invalid-key")).toThrow(
      "Zoho OAuth encryption key must be 64 hexadecimal characters",
    );
  });

  it("rejects a payload encrypted with a different key", () => {
    const encrypted = encryptCodeVerifier(verifier, encryptionKey);

    expect(() => decryptCodeVerifier(encrypted, differentEncryptionKey)).toThrow();
  });

  it("detects tampering with the encrypted payload", () => {
    const encrypted = encryptCodeVerifier(verifier, encryptionKey);
    const bytes = Buffer.from(encrypted, "base64url");

    // Flip one bit in the ciphertext to simulate data corruption.
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;

    const tampered = bytes.toString("base64url");

    expect(() => decryptCodeVerifier(tampered, encryptionKey)).toThrow();
  });

  it("rejects a payload that is too short", () => {
    expect(() => decryptCodeVerifier("AQID", encryptionKey)).toThrow(
      "Encrypted PKCE verifier payload is invalid",
    );
  });
});
