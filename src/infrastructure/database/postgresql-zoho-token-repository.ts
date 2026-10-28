import type {
  SaveZohoTokens,
  StoredZohoTokens,
  ZohoTokenRepository,
} from "../../application/zoho/zoho-token-repository.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";

/**
 * PostgreSQL implementation of Zoho token persistence.
 *
 * Uses the shared Prisma client managed by the database provider.
 * The fixed "primary" ID supports one Zoho connection per installation.
 */
export class PostgresqlZohoTokenRepository implements ZohoTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates or updates the current token set.
   *
   * When encryptedRefreshToken is omitted, the update does not touch the
   * existing refresh token. On initial creation, the field is set to null.
   *
   * Keeping refresh-token preservation inside the database update avoids
   * a separate read-then-write race.
   */
  async save(tokens: SaveZohoTokens): Promise<void> {
    await this.prisma.zohoToken.upsert({
      where: { id: "primary" },
      create: {
        id: "primary",
        encryptedAccessToken: tokens.encryptedAccessToken,
        encryptedRefreshToken: tokens.encryptedRefreshToken ?? null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        apiDomain: tokens.apiDomain,
        scopes: tokens.scopes,
        refreshLeaseToken: null,
        refreshLeaseExpiresAt: null,
      },
      update: {
        encryptedAccessToken: tokens.encryptedAccessToken,
        ...(tokens.encryptedRefreshToken !== undefined
          ? { encryptedRefreshToken: tokens.encryptedRefreshToken }
          : {}),
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        apiDomain: tokens.apiDomain,
        scopes: tokens.scopes,
        refreshLeaseToken: null,
        refreshLeaseExpiresAt: null,
      },
    });
  }

  async tryAcquireRefreshLease(leaseToken: string, now: Date, expiresAt: Date): Promise<boolean> {
    const claimed = await this.prisma.zohoToken.updateMany({
      where: {
        id: "primary",
        OR: [{ refreshLeaseToken: null }, { refreshLeaseExpiresAt: { lte: now } }],
      },
      data: { refreshLeaseToken: leaseToken, refreshLeaseExpiresAt: expiresAt },
    });
    return claimed.count === 1;
  }

  async saveRefreshedTokens(
    leaseToken: string,
    now: Date,
    tokens: SaveZohoTokens,
  ): Promise<boolean> {
    const saved = await this.prisma.zohoToken.updateMany({
      where: {
        id: "primary",
        refreshLeaseToken: leaseToken,
        refreshLeaseExpiresAt: { gt: now },
      },
      data: {
        encryptedAccessToken: tokens.encryptedAccessToken,
        ...(tokens.encryptedRefreshToken !== undefined
          ? { encryptedRefreshToken: tokens.encryptedRefreshToken }
          : {}),
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        apiDomain: tokens.apiDomain,
        scopes: tokens.scopes,
        refreshLeaseToken: null,
        refreshLeaseExpiresAt: null,
      },
    });
    return saved.count === 1;
  }

  async releaseRefreshLease(leaseToken: string): Promise<void> {
    await this.prisma.zohoToken.updateMany({
      where: { id: "primary", refreshLeaseToken: leaseToken },
      data: { refreshLeaseToken: null, refreshLeaseExpiresAt: null },
    });
  }

  /** Returns encrypted tokens, or null when no connection is stored. */
  async get(): Promise<StoredZohoTokens | null> {
    return this.prisma.zohoToken.findUnique({
      where: { id: "primary" },
      select: {
        encryptedAccessToken: true,
        encryptedRefreshToken: true,
        accessTokenExpiresAt: true,
        apiDomain: true,
        scopes: true,
        updatedAt: true,
      },
    });
  }
}
