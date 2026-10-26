import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePkcePair } from "../../src/integrations/zoho/pkce.js";

describe("Zoho PKCE helper", () => {
  it("generates a verifier with the required length", () => {
    const { verifier } = generatePkcePair();

    // PKCE verifiers must contain between 43 and 128 characters.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("generates a URL-safe verifier", () => {
    const { verifier } = generatePkcePair();

    // Base64URL uses letters, numbers, hyphens and underscores.
    // Padding characters (=) are not present in the encoded verifier.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the correct S256 challenge from the verifier", () => {
    const { verifier, challenge } = generatePkcePair();

    // Independently calculate the expected challenge.
    // This verifies the actual cryptographic relationship between the values.
    const expectedChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");

    expect(challenge).toBe(expectedChallenge);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toHaveLength(43);
  });

  it("generates a different verifier for separate calls", () => {
    const first = generatePkcePair();
    const second = generatePkcePair();

    // Independent cryptographically random values should not be reused.
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });
});
