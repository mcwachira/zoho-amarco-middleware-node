import { decryptSecret, encryptSecret } from "./secret-encryption.js";

/**
 * Encrypts a PKCE verifier.
 *
 * Kept as a dedicated function so existing OAuth code and tests
 * remain independent of the generic secret-encryption implementation.
 */
export function encryptCodeVerifier(verifier: string, hexKey: string): string {
  if (!verifier) {
    throw new Error("PKCE verifier must not be empty");
  }

  return encryptSecret(verifier, hexKey);
}

/**
 * Decrypts a previously encrypted PKCE verifier.
 */

/**
 * Decrypts a previously encrypted PKCE verifier.
 *
 * Translates the generic encryption helper's short-payload error
 * into the existing PKCE-specific error expected by our callers and tests.
 */
export function decryptCodeVerifier(encryptedPayload: string, hexKey: string): string {
  try {
    return decryptSecret(encryptedPayload, hexKey);
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "Encrypted secret payload is invalid") {
      throw new Error("Encrypted PKCE verifier payload is invalid", { cause: error });
    }

    throw error;
  }
}
