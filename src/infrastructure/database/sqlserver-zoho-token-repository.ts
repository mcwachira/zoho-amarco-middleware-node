import type {
  SaveZohoTokens,
  StoredZohoTokens,
  ZohoTokenRepository,
} from "../../application/zoho/zoho-token-repository.js";
import type { PrismaClient } from "../../generated/prisma/sqlserver/client.js";

/**
 * SQL Server implementation of Zoho token persistence.
 *
 * Uses the shared Prisma client managed by the database provider.
 * The fixed "primary" ID supports one Zoho connection per installation.
 */
export class SqlServerZohoTokenRepository implements ZohoTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates or updates the current token set.
   *
   * When encryptedRefreshToken is omitted, the update leaves the existing
   * refresh token unchanged. On initial creation, the value is null.
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
      },
      update: {
        encryptedAccessToken: tokens.encryptedAccessToken,
        ...(tokens.encryptedRefreshToken !== undefined
          ? { encryptedRefreshToken: tokens.encryptedRefreshToken }
          : {}),
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        apiDomain: tokens.apiDomain,
        scopes: tokens.scopes,
      },
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
