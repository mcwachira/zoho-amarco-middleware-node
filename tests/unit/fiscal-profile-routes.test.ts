import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import type {
  FiscalCustomerProfile,
  FiscalCustomerProfileData,
  FiscalCustomerProfileRepository,
} from "../../src/application/fiscalization/fiscal-customer-profile-repository.js";
import type {
  FiscalItemProfile,
  FiscalItemProfileData,
  FiscalItemProfileRepository,
} from "../../src/application/fiscalization/fiscal-item-profile-repository.js";
import {
  DuplicateFiscalProfileError,
  FiscalProfileNotFoundError,
  InvalidFiscalProfileError,
} from "../../src/application/fiscalization/fiscal-profile-errors.js";
import { createApp } from "../../src/app.js";

const TEST_TOKEN = "test-fiscal-profile-management-token";

const customerProfile: FiscalCustomerProfile = {
  id: "customer-profile-1",
  zohoCustomerId: "customer-1",
  companyName: "Example Ltd",
  clientPin: "P051234567X",
  headquarters: "Diani",
  address: "Main Road",
  postalCodeAndCity: "80400 Ukunda",
  exemptionNumber: null,
  createdAt: new Date("2026-10-27T00:00:00.000Z"),
  updatedAt: new Date("2026-10-27T00:00:00.000Z"),
};

const customerData: FiscalCustomerProfileData = {
  companyName: "Example Ltd",
  clientPin: "P051234567X",
  headquarters: "Diani",
  address: "Main Road",
  postalCodeAndCity: "80400 Ukunda",
  exemptionNumber: null,
};

const itemProfile: FiscalItemProfile = {
  id: "item-profile-1",
  zohoItemId: "item-1",
  measureUnit: "EA",
  hsCode: "1234.56.78",
  hsName: "Consulting",
  vatClass: "A",
  vatGroupRate: "16.00",
  createdAt: new Date("2026-10-27T00:00:00.000Z"),
  updatedAt: new Date("2026-10-27T00:00:00.000Z"),
};

const itemData: FiscalItemProfileData = {
  measureUnit: "EA",
  hsCode: "1234.56.78",
  hsName: "Consulting",
  vatClass: "A",
  vatGroupRate: "16.00",
};

function createRepositories() {
  const customerRepository = {
    findByZohoCustomerId: vi.fn(async () => customerProfile),
    create: vi.fn(async () => customerProfile),
    update: vi.fn(async () => customerProfile),
  } satisfies FiscalCustomerProfileRepository;

  const itemRepository = {
    findByZohoItemId: vi.fn(async () => itemProfile),
    create: vi.fn(async () => itemProfile),
    update: vi.fn(async () => itemProfile),
  } satisfies FiscalItemProfileRepository;

  return { customerRepository, itemRepository };
}

function createTestApp() {
  const repositories = createRepositories();
  const app = createApp({
    fiscalCustomerProfileRepository: repositories.customerRepository,
    fiscalItemProfileRepository: repositories.itemRepository,
    invoiceApiBearerToken: TEST_TOKEN,
  });

  return { app, ...repositories };
}

function authenticated(
  method: "get" | "post" | "put",
  app: ReturnType<typeof createApp>,
  path: string,
) {
  return request(app)[method](path).set("Authorization", `Bearer ${TEST_TOKEN}`);
}

describe("fiscal profile management routes", () => {
  it.each([
    ["post", "/integrations/zoho/fiscal-customer-profiles"],
    ["get", "/integrations/zoho/fiscal-customer-profiles/customer-1"],
    ["put", "/integrations/zoho/fiscal-customer-profiles/customer-1"],
    ["post", "/integrations/zoho/fiscal-item-profiles"],
    ["get", "/integrations/zoho/fiscal-item-profiles/item-1"],
    ["put", "/integrations/zoho/fiscal-item-profiles/item-1"],
  ] as const)("requires bearer authentication for %s %s", async (method, path) => {
    const { app, customerRepository, itemRepository } = createTestApp();

    const response = await request(app)[method](path);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(customerRepository.create).not.toHaveBeenCalled();
    expect(customerRepository.findByZohoCustomerId).not.toHaveBeenCalled();
    expect(customerRepository.update).not.toHaveBeenCalled();
    expect(itemRepository.create).not.toHaveBeenCalled();
    expect(itemRepository.findByZohoItemId).not.toHaveBeenCalled();
    expect(itemRepository.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token before calling a profile repository", async () => {
    const { app, customerRepository } = createTestApp();

    const response = await request(app)
      .get("/integrations/zoho/fiscal-customer-profiles/customer-1")
      .set("Authorization", "Bearer invalid-profile-token");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(customerRepository.findByZohoCustomerId).not.toHaveBeenCalled();
  });

  it("creates and retrieves a customer profile with the established response shape", async () => {
    const { app, customerRepository } = createTestApp();

    const createResponse = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-customer-profiles",
    ).send({ zohoCustomerId: "customer-1", ...customerData });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.profile).toMatchObject({
      id: "customer-profile-1",
      zohoCustomerId: "customer-1",
      ...customerData,
    });
    expect(createResponse.headers["location"]).toBe(
      "/integrations/zoho/fiscal-customer-profiles/customer-1",
    );
    expect(customerRepository.create).toHaveBeenCalledWith({
      zohoCustomerId: "customer-1",
      ...customerData,
    });

    const getResponse = await authenticated(
      "get",
      app,
      "/integrations/zoho/fiscal-customer-profiles/customer-1",
    );

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.profile).toMatchObject({
      zohoCustomerId: "customer-1",
      companyName: "Example Ltd",
    });
    expect(customerRepository.findByZohoCustomerId).toHaveBeenCalledWith("customer-1");
  });

  it("creates and retrieves an item profile", async () => {
    const { app, itemRepository } = createTestApp();

    const createResponse = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-item-profiles",
    ).send({ zohoItemId: "item-1", ...itemData });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.profile).toMatchObject({
      id: "item-profile-1",
      zohoItemId: "item-1",
      ...itemData,
    });
    expect(createResponse.headers["location"]).toBe(
      "/integrations/zoho/fiscal-item-profiles/item-1",
    );

    const getResponse = await authenticated(
      "get",
      app,
      "/integrations/zoho/fiscal-item-profiles/item-1",
    );

    expect(getResponse.status).toBe(200);
    expect(getResponse.body.profile).toMatchObject({
      zohoItemId: "item-1",
      vatGroupRate: "16.00",
    });
    expect(itemRepository.findByZohoItemId).toHaveBeenCalledWith("item-1");
  });

  it("updates mutable fields without accepting immutable or internal identity fields", async () => {
    const { app, customerRepository, itemRepository } = createTestApp();

    const customerResponse = await authenticated(
      "put",
      app,
      "/integrations/zoho/fiscal-customer-profiles/customer-1",
    ).send({ ...customerData, companyName: "Updated Ltd" });
    expect(customerResponse.status).toBe(200);
    expect(customerRepository.update).toHaveBeenCalledWith("customer-1", {
      ...customerData,
      companyName: "Updated Ltd",
    });

    const itemResponse = await authenticated(
      "put",
      app,
      "/integrations/zoho/fiscal-item-profiles/item-1",
    ).send({ ...itemData, hsName: "Updated service" });
    expect(itemResponse.status).toBe(200);
    expect(itemRepository.update).toHaveBeenCalledWith("item-1", {
      ...itemData,
      hsName: "Updated service",
    });

    const attemptedIdentityChange = await authenticated(
      "put",
      app,
      "/integrations/zoho/fiscal-customer-profiles/customer-1",
    ).send({ ...customerData, zohoCustomerId: "another-customer" });
    expect(attemptedIdentityChange.status).toBe(400);
    expect(attemptedIdentityChange.body.error.code).toBe("INVALID_PROFILE_REQUEST");

    const attemptedInternalFieldChange = await authenticated(
      "put",
      app,
      "/integrations/zoho/fiscal-item-profiles/item-1",
    ).send({ ...itemData, id: "attacker-controlled-id", updatedAt: "2026-01-01" });
    expect(attemptedInternalFieldChange.status).toBe(400);
    expect(itemRepository.update).toHaveBeenCalledOnce();
  });

  it("rejects malformed or incomplete customer and item request bodies", async () => {
    const { app, customerRepository, itemRepository } = createTestApp();

    const customerResponse = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-customer-profiles",
    ).send({ zohoCustomerId: "customer-1", companyName: 3 });
    expect(customerResponse.status).toBe(400);
    expect(customerResponse.body.error.code).toBe("INVALID_PROFILE_REQUEST");

    const itemResponse = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-item-profiles",
    ).send({ zohoItemId: "item-1", vatGroupRate: "sixteen" });
    expect(itemResponse.status).toBe(400);
    expect(itemResponse.body.error.code).toBe("INVALID_PROFILE_REQUEST");

    const clientSuppliedInternalId = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-customer-profiles",
    ).send({ zohoCustomerId: "customer-1", ...customerData, id: "client-selected-id" });
    expect(clientSuppliedInternalId.status).toBe(400);

    expect(customerRepository.create).not.toHaveBeenCalled();
    expect(itemRepository.create).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON without exposing parser details", async () => {
    const { app } = createTestApp();

    const response = await authenticated("post", app, "/integrations/zoho/fiscal-item-profiles")
      .set("Content-Type", "application/json")
      .send('{"zohoItemId":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
    expect(JSON.stringify(response.body)).not.toContain("Unexpected end");
  });

  it("maps duplicate, not-found, and domain validation errors to safe responses", async () => {
    const { app, customerRepository, itemRepository } = createTestApp();
    customerRepository.create.mockRejectedValue(new DuplicateFiscalProfileError("customer"));
    itemRepository.update.mockRejectedValue(new FiscalProfileNotFoundError("item"));

    const duplicateResponse = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-customer-profiles",
    ).send({ zohoCustomerId: "customer-1", ...customerData });
    expect(duplicateResponse.status).toBe(409);
    expect(duplicateResponse.body.error.code).toBe("FISCAL_PROFILE_ALREADY_EXISTS");

    const missingResponse = await authenticated(
      "put",
      app,
      "/integrations/zoho/fiscal-item-profiles/missing-item",
    ).send(itemData);
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.body.error.code).toBe("FISCAL_PROFILE_NOT_FOUND");

    customerRepository.create.mockRejectedValue(
      new InvalidFiscalProfileError("companyName", "companyName must not be empty."),
    );
    const invalidProfileResponse = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-customer-profiles",
    ).send({ zohoCustomerId: "customer-1", ...customerData });
    expect(invalidProfileResponse.status).toBe(400);
    expect(invalidProfileResponse.body.error).toMatchObject({
      code: "INVALID_FISCAL_PROFILE",
      field: "companyName",
    });
  });

  it("returns a generic 500 response for repository failures", async () => {
    const { app, itemRepository } = createTestApp();
    itemRepository.create.mockRejectedValue(
      new Error("SQL Server connection password and query details"),
    );

    const response = await authenticated(
      "post",
      app,
      "/integrations/zoho/fiscal-item-profiles",
    ).send({ zohoItemId: "item-1", ...itemData });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("password");
    expect(JSON.stringify(response.body)).not.toContain("SQL Server");
  });

  it("keeps all profile routes unavailable rather than bypassing authentication when repositories are absent", async () => {
    const app = createApp({ invoiceApiBearerToken: TEST_TOKEN });

    const response = await authenticated(
      "get",
      app,
      "/integrations/zoho/fiscal-customer-profiles/customer-1",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FISCAL_PROFILE_REPOSITORY_UNAVAILABLE");
  });
});
