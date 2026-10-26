import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/postgresql/client.js";
import { PostgresqlZohoTokenRepository } from "../../src/infrastructure/database/postgresql-zoho-token-repository.js";
import type { SaveZohoTokens } from "../../src/application/zoho/zoho-token-repository.js";

const now = new Date("2026-10-25T06:00:00.000Z");

const tokens = {
  encryptedAccessToken: "encrypted-access-token",
  encryptedRefreshToken: "encrypted-refresh-token",
  accessTokenExpiresAt: new Date("2026-10-25T07:00:00.000Z"),
  apiDomain: "https://www.zohoapis.com",
  scopes: "ZohoBooks.invoices.READ",
};

function createHarness() {
  const prismaMock = {
    zohoToken: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  const prisma = prismaMock as unknown as PrismaClient;
  const repository = new PostgresqlZohoTokenRepository(prisma);

  return { prismaMock, repository };
}

describe("PostgresqlZohoTokenRepository", () => {
  let prismaMock: ReturnType<typeof createHarness>["prismaMock"];
  let repository: PostgresqlZohoTokenRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ prismaMock, repository } = createHarness());
  });

  it("creates the primary token record with the supplied values", async () => {
    prismaMock.zohoToken.upsert.mockResolvedValue({
      id: "primary",
      ...tokens,
      createdAt: now,
      updatedAt: now,
    });

    await repository.save(tokens);

    expect(prismaMock.zohoToken.upsert).toHaveBeenCalledWith({
      where: { id: "primary" },
      create: {
        id: "primary",
        ...tokens,
      },
      update: {
        ...tokens,
      },
    });
  });

  it("preserves the existing refresh token when no replacement is supplied", async () => {
    const tokensWithoutRefreshToken: SaveZohoTokens = {
      encryptedAccessToken: tokens.encryptedAccessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      apiDomain: tokens.apiDomain,
      scopes: tokens.scopes,
    };

    await repository.save(tokensWithoutRefreshToken);

    expect(prismaMock.zohoToken.upsert).toHaveBeenCalledWith({
      where: { id: "primary" },
      create: {
        id: "primary",
        ...tokensWithoutRefreshToken,
        encryptedRefreshToken: null,
      },
      update: {
        ...tokensWithoutRefreshToken,
      },
    });

    const call = prismaMock.zohoToken.upsert.mock.calls[0]?.[0];

    expect(call?.update).not.toHaveProperty("encryptedRefreshToken");
  });

  it("reads the primary token record using an explicit field selection", async () => {
    const storedTokens = {
      encryptedAccessToken: tokens.encryptedAccessToken,
      encryptedRefreshToken: tokens.encryptedRefreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      apiDomain: tokens.apiDomain,
      scopes: tokens.scopes,
      updatedAt: now,
    };

    prismaMock.zohoToken.findUnique.mockResolvedValue(storedTokens);

    await expect(repository.get()).resolves.toEqual(storedTokens);

    expect(prismaMock.zohoToken.findUnique).toHaveBeenCalledWith({
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
  });

  it("returns null when no token record exists", async () => {
    prismaMock.zohoToken.findUnique.mockResolvedValue(null);

    await expect(repository.get()).resolves.toBeNull();
  });

  it("propagates database errors when saving tokens", async () => {
    const databaseError = new Error("Database write failed");
    prismaMock.zohoToken.upsert.mockRejectedValue(databaseError);

    await expect(repository.save(tokens)).rejects.toBe(databaseError);
  });

  it("propagates database errors when reading tokens", async () => {
    const databaseError = new Error("Database read failed");
    prismaMock.zohoToken.findUnique.mockRejectedValue(databaseError);

    await expect(repository.get()).rejects.toBe(databaseError);
  });
});
