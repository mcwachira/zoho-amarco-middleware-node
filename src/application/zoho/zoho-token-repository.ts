/**
 * Token data prepared for secure persistence.
 *
 * Token values must already be encrypted before reaching this repository.
 */
export interface SaveZohoTokens {
  /** AES-256-GCM encrypted Zoho access token. */
  encryptedAccessToken: string;

  /**
   * Encrypted refresh token, when Zoho supplies a new one.
   *
   * Omit this during a token refresh if Zoho does not return a replacement.
   * The repository implementation must preserve the previously stored
   * refresh token in that case.
   */
  encryptedRefreshToken?: string;

  /** Time when the access token expires. */
  accessTokenExpiresAt: Date;

  /** Zoho API domain returned by the token endpoint. */
  apiDomain: string;

  /** OAuth scopes granted to this connection. */
  scopes: string;
}

/**
 * Persisted token information returned to the application.
 *
 * Token values remain encrypted until the application explicitly decrypts
 * them for an authorized operation.
 */
export interface StoredZohoTokens {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: Date;
  apiDomain: string;
  scopes: string;
  updatedAt: Date;
}

export interface ZohoTokenRepository {
  /**
   * Saves the current token set.
   *
   * If encryptedRefreshToken is omitted, an existing refresh token
   * must be preserved rather than overwritten with an empty value.
   */
  save(tokens: SaveZohoTokens): Promise<void>;

  /** Atomically claims the singleton token row until the supplied expiry. */
  tryAcquireRefreshLease(leaseToken: string, now: Date, expiresAt: Date): Promise<boolean>;

  /** Persists refreshed credentials only while this caller still owns the lease. */
  saveRefreshedTokens(leaseToken: string, now: Date, tokens: SaveZohoTokens): Promise<boolean>;

  /** Releases a lease only when the caller still owns it. */
  releaseRefreshLease(leaseToken: string): Promise<void>;

  /** Returns the stored token set, or null if no connection exists. */
  get(): Promise<StoredZohoTokens | null>;
}
