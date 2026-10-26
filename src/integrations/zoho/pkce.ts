import { createHash, randomBytes } from "node:crypto";

/**
 * The verifier is kept by our application for the later token exchange.
 * The challenge is sent to Zoho during authorization.
 */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generates a PKCE verifier and its corresponding S256 challenge.
 *
 * This function performs no network requests and does not store either value.
 * The caller is responsible for securely retaining the verifier until the
 * OAuth callback and token exchange have completed.
 */
export function generatePkcePair(): PkcePair {
  // Generate 32 cryptographically random bytes.
  // Base64URL encoding produces a 43-character verifier without padding.
  const verifier = randomBytes(32).toString("base64url");

  // Hash the verifier with SHA-256, then encode the digest using Base64URL.
  // Zoho receives this challenge; the original verifier remains private.
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

  return {
    verifier,
    challenge,
  };
}
