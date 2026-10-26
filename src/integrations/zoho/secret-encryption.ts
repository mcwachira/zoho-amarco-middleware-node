import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Decodes and validates the configured 32-byte encryption key.
 * The environment variable is represented as 64 hexadecimal characters.
 */
function decodeEncryptionKey(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error("Zoho OAuth encryption key must be 64 hexadecimal characters");
  }

  const key = Buffer.from(hexKey, "hex");

  if (key.length !== KEY_BYTES) {
    throw new Error("Zoho OAuth encryption key must be 32 bytes");
  }

  return key;
}

/**
 * Encrypts a non-empty secret using AES-256-GCM.
 *
 * Stored payload format:
 * nonce (12 bytes) + authentication tag (16 bytes) + ciphertext.
 *
 * A fresh random nonce is generated for every encryption.
 */
export function encryptSecret(secret: string, hexKey: string): string {
  if (!secret) {
    throw new Error("Secret must not be empty");
  }

  const key = decodeEncryptionKey(hexKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);

  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);

  const authTag = cipher.getAuthTag();

  return Buffer.concat([nonce, authTag, ciphertext]).toString("base64url");
}

/**
 * Decrypts a stored secret and verifies its authentication tag.
 * Never bypass authentication failures or return unverified plaintext.
 */
export function decryptSecret(encryptedPayload: string, hexKey: string): string {
  const payload = Buffer.from(encryptedPayload, "base64url");
  const minimumLength = NONCE_BYTES + AUTH_TAG_BYTES + 1;

  if (payload.length < minimumLength) {
    throw new Error("Encrypted secret payload is invalid");
  }

  const key = decodeEncryptionKey(hexKey);
  const nonce = payload.subarray(0, NONCE_BYTES);
  const authTag = payload.subarray(NONCE_BYTES, NONCE_BYTES + AUTH_TAG_BYTES);
  const ciphertext = payload.subarray(NONCE_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString("utf8");
}
