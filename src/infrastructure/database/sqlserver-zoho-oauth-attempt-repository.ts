import type {
  NewZohoOAuthAttempt,
  ZohoOAuthAttemptRepository,
} from "../../application/zoho/oauth-attempt-repository.js";
import type { PrismaClient } from "../../generated/prisma/sqlserver/client.js";

/**
 * SQL Server implementation of the Zoho OAuth attempt repository.
 *
 * Uses the existing SQL Server Prisma client, so connection lifecycle
 * management remains centralized in the database provider.
 */
export class SqlServerZohoOAuthAttemptRepository implements ZohoOAuthAttemptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Persists a new OAuth attempt.
   *
   * The unique stateHash constraint in the schema prevents duplicate hashes.
   */
  async create(attempt: NewZohoOAuthAttempt): Promise<void> {
    await this.prisma.zohoOAuthAttempt.create({
      data: {
        stateHash: attempt.stateHash,
        encryptedCodeVerifier: attempt.encryptedCodeVerifier,
        expiresAt: attempt.expiresAt,
      },
    });
  }

  /**
   * Claims an unused, unexpired OAuth attempt in a transaction.
   *
   * The conditional update is essential: only one concurrent callback
   * should be able to change consumedAt from null to a timestamp.
   */
  async consume(stateHash: string, now: Date): Promise<{ encryptedCodeVerifier: string } | null> {
    return this.prisma.$transaction(async (transaction) => {
      const claim = await transaction.zohoOAuthAttempt.updateMany({
        where: {
          stateHash,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          consumedAt: now,
        },
      });

      if (claim.count !== 1) {
        return null;
      }

      // Retrieve the encrypted verifier only after the claim succeeds.
      const attempt = await transaction.zohoOAuthAttempt.findUnique({
        where: { stateHash },
        select: {
          encryptedCodeVerifier: true,
        },
      });

      if (!attempt) {
        // Throwing rolls back the transaction and its consumption update.
        throw new Error("Claimed Zoho OAuth attempt could not be retrieved");
      }

      return {
        encryptedCodeVerifier: attempt.encryptedCodeVerifier,
      };
    });
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.prisma.zohoOAuthAttempt.deleteMany({
      where: {
        expiresAt: {
          lte: now,
        },
      },
    });

    return result.count;
  }
}
