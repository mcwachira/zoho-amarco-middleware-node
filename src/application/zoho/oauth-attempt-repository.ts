/**
 * Data required to persist a new Zoho OAuth authorization attempt.
 *
 * The state is already hashed, and the PKCE verifier is already encrypted
 * before this data reaches the repository.
 */
export interface NewZohoOAuthAttempt {
  stateHash: string;
  encryptedCodeVerifier: string;
  expiresAt: Date;
}

/**
 * Describes how the application persists and consumes OAuth attempts.
 *
 * Implementations must enforce single-use state atomically in the database.
 */
export interface ZohoOAuthAttemptRepository {
  /**
   * Persists a new authorization attempt.
   *
   * The database must enforce uniqueness of stateHash.
   */
  create(attempt: NewZohoOAuthAttempt): Promise<void>;

  /**
   * Claims an unexpired, unused authorization attempt.
   *
   * Returns the encrypted PKCE verifier when the claim succeeds.
   * Returns null if the state does not exist, has expired, or has
   * already been consumed.
   *
   * Implementations must make the claim atomic so concurrent requests
   * cannot consume the same state successfully.
   *
   * `now` is supplied by the caller to make expiry behavior deterministic
   * and straightforward to test.
   */
  consume(stateHash: string, now: Date): Promise<{ encryptedCodeVerifier: string } | null>;

  /**
   * Deletes authorization attempts whose expiry time has passed.
   *
   * Returns the number of records deleted.
   */
  deleteExpired(now: Date): Promise<number>;
}
