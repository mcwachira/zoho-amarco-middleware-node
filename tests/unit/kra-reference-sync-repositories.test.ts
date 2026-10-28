import { describe, expect, it, vi } from "vitest";
import { PostgresqlKraReferenceSyncRepository } from "../../src/infrastructure/database/postgresql-kra-reference-sync-repository.js";
import type {
  KraReferenceSyncRepository,
  KraReferenceSyncScope,
} from "../../src/application/etims/kra-reference-sync-repository.js";

const scope: KraReferenceSyncScope = {
  provider: "oscu",
  adapterIdentity: "oscu-sandbox-v2",
  taxpayerTin: "A123456789Z",
  branchId: "00",
  category: "codes",
};
const attemptedAt = new Date("2026-10-27T08:00:00.000Z");

function harness(implementation: (client: never) => KraReferenceSyncRepository) {
  const state = { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() };
  const client = { kraReferenceSyncState: state };
  const repository = implementation(client as never);
  return { repository, state };
}

describe("PostgreSQL KRA reference sync repository", () => {
  const Repository = (client: never) => new PostgresqlKraReferenceSyncRepository(client);
  it("scopes state by provider, adapter, taxpayer, branch, and category", async () => {
    const { repository, state } = harness(Repository);
    state.findUnique.mockResolvedValue(null);

    await repository.find(scope);

    expect(state.findUnique).toHaveBeenCalledWith({
      where: { provider_adapterIdentity_taxpayerTin_branchId_category: scope },
    });
  });

  it("records an attempt without promoting result timestamps or changing success state", async () => {
    const { repository, state } = harness(Repository);
    state.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(
      repository.recordAttempt(scope, "lease-owner", attemptedAt, {
        status: "provider_acceptance_required",
        attemptedAt,
        errorCategory: "cursor_semantics_unverified",
        correlationId: "corr-123",
      }),
    ).resolves.toBe(true);

    const call = state.updateMany.mock.calls[0]?.[0];
    expect(call?.where).toEqual({
      ...scope,
      leaseToken: "lease-owner",
      leaseExpiresAt: { gt: attemptedAt },
    });
    expect(call?.data).toMatchObject({
      lastAttemptAt: attemptedAt,
      attemptStatus: "provider_acceptance_required",
      lastErrorCategory: "cursor_semantics_unverified",
      correlationId: "corr-123",
    });
    expect(call?.data).not.toHaveProperty("lastSuccessAt");
    expect(call?.data).not.toHaveProperty("providerTimestamp");
    expect(call?.data).not.toHaveProperty("providerCursor");

    await expect(
      repository.recordAttempt(scope, "expired-or-replaced-owner", attemptedAt, {
        status: "malformed_response",
        attemptedAt,
        errorCategory: "stale_lease",
        correlationId: "corr-stale",
      }),
    ).resolves.toBe(false);
  });

  it("claims an uninitialized scope once and uses an atomic expiry check for later claims", async () => {
    const { repository, state } = harness(Repository);
    state.create.mockResolvedValue({});
    await expect(
      repository.tryAcquire(
        scope,
        "lease-a",
        attemptedAt,
        new Date(attemptedAt.getTime() + 60_000),
      ),
    ).resolves.toBe(true);

    state.create.mockRejectedValue({ code: "P2002" });
    state.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      repository.tryAcquire(
        scope,
        "lease-b",
        attemptedAt,
        new Date(attemptedAt.getTime() + 60_000),
      ),
    ).resolves.toBe(false);
    expect(state.updateMany).toHaveBeenCalledWith({
      where: {
        ...scope,
        OR: [
          { leaseToken: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: attemptedAt } },
        ],
      },
      data: {
        leaseToken: "lease-b",
        leaseExpiresAt: new Date(attemptedAt.getTime() + 60_000),
        updatedAt: attemptedAt,
      },
    });
  });

  it("renews and releases only the lease owned by the caller", async () => {
    const { repository, state } = harness(Repository);
    state.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      repository.renew(scope, "lease-a", attemptedAt, new Date(attemptedAt.getTime() + 60_000)),
    ).resolves.toBe(true);
    await repository.release(scope, "lease-a");

    expect(state.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        ...scope,
        leaseToken: "lease-a",
        leaseExpiresAt: { gt: attemptedAt },
      },
      data: { leaseExpiresAt: new Date(attemptedAt.getTime() + 60_000), updatedAt: attemptedAt },
    });
    expect(state.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        ...scope,
        leaseToken: "lease-a",
      },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  });
});
