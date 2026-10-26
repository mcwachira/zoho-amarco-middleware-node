import type { ZohoOAuthAttemptRepository } from "../../application/zoho/oauth-attempt-repository.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import type { NewZohoOAuthAttempt } from "../../application/zoho/oauth-attempt-repository.js";

/**
 * PostgreSQL implementation of the Zoho OAuth attempt repository.
 *
 * The repository receives the existing Prisma client rather than creating
 * its own connection. This keeps database lifecycle management centralized.
 */
export class PostgresqlZohoOAuthAttemptRepository implements ZohoOAuthAttemptRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Stores a new OAuth attempt.
   *
   * The unique stateHash constraint in the Prisma schema prevents duplicate
   * hashes from being stored.
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
   * Atomically consumes an OAuth attempt.
   *
   * The conditional update is the security boundary: only an attempt whose
   * state hash matches, whose expiry is in the future, and whose consumedAt
   * is still null can be claimed.
   *
   * Concurrent callbacks cannot both change the same row from unused to
   * consumed successfully.
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

      // Read the verifier only after this transaction successfully claims
      // the attempt. The transaction keeps the claim and read together.
      const attempt = await transaction.zohoOAuthAttempt.findUnique({
        where: { stateHash },
        select: {
          encryptedCodeVerifier: true,
        },
      });

      if (!attempt) {
        // This should be impossible if the database transaction is healthy.
        // Throwing rolls back the claim instead of silently losing the attempt.
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
