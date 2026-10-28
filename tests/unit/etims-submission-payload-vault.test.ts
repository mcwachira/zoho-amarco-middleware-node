import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import type { EtimsReportingOperationDetails } from "../../src/domain/fiscalization/etims-reporting.js";
import type {
  EtimsSubmissionPayloadRecord,
  EtimsSubmissionPayloadRepository,
} from "../../src/application/fiscalization/etims-submission-payload.js";
import { hashEtimsPayload } from "../../src/application/fiscalization/etims-reporting-service.js";
import { digestKraSalesMappingConfiguration } from "../../src/application/etims/kra-sales-mapping.js";
import { syntheticConfiguration } from "./kra-sales-mapping-fixture.js";
import {
  AesGcmEtimsPayloadProtection,
  ConfiguredEtimsPayloadKeyProvider,
  EtimsSubmissionPayloadVault,
  canonicalEtimsPayload,
} from "../../src/application/fiscalization/etims-submission-payload-vault.js";

const key = "e".repeat(64);
const payload = { invoice: { id: "synthetic-1", lines: [{ sku: "SAFE", amount: 123.45 }] } };
const protection = (keys: Readonly<Record<string, string>>, active = "legacy-v1") =>
  new AesGcmEtimsPayloadProtection(new ConfiguredEtimsPayloadKeyProvider(keys, active));

function details(payloadHash = hashEtimsPayload(payload)): EtimsReportingOperationDetails {
  const now = new Date("2026-10-27T07:00:00.000Z");
  return {
    operation: {
      id: "operation-1",
      fiscalizationRequestId: "request-1",
      zohoInvoiceId: "invoice-1",
      adapterType: "vscu",
      adapterConfigurationId: null,
      correlationId: "correlation-1",
      status: "outcome_unknown",
      payloadHash,
      attemptNumber: 1,
      reconciliationAttemptNumber: 0,
      providerReference: null,
      providerMetadataJson: null,
      errorCategory: null,
      errorMessage: null,
      reconciliationRequired: true,
      createdAt: now,
      updatedAt: now,
    },
    attempts: [],
  };
}

function pendingDetails(): EtimsReportingOperationDetails {
  const value = details();
  return {
    ...value,
    operation: {
      ...value.operation,
      status: "pending",
      attemptNumber: 0,
      reconciliationRequired: false,
    },
  };
}

function mappedDetails(
  configuration: ReturnType<typeof syntheticConfiguration>,
): EtimsReportingOperationDetails {
  const value = pendingDetails();
  return {
    ...value,
    operation: {
      ...value.operation,
      adapterConfigurationId: `synthetic-adapter|mapping-sha256:${digestKraSalesMappingConfiguration(configuration)}`,
    },
  };
}

function submittedDetails(value: EtimsReportingOperationDetails): EtimsReportingOperationDetails {
  return {
    ...value,
    operation: { ...value.operation, status: "outcome_unknown", attemptNumber: 1 },
  };
}

class PayloadRepository implements EtimsSubmissionPayloadRepository {
  record: EtimsSubmissionPayloadRecord | null = null;
  async findSubmissionPayload(): Promise<EtimsSubmissionPayloadRecord | null> {
    return this.record;
  }
}

describe("EtimsSubmissionPayloadVault", () => {
  it("round-trips an immutable encrypted payload after constructing a new vault", async () => {
    const repository = new PayloadRepository();
    const original = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    repository.record = original.prepare(pendingDetails(), payload, new Date());

    expect(repository.record.encryptedPayload).not.toContain("synthetic-1");
    const restarted = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    await expect(restarted.load(details(), new AbortController().signal)).resolves.toEqual({
      available: true,
      payload,
    });
  });

  it("archives the exact validated mapping configuration and verifies it after restart", async () => {
    const repository = new PayloadRepository();
    const initialConfiguration = syntheticConfiguration("vscu");
    const detailsForMapping = mappedDetails(initialConfiguration);
    const original = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    repository.record = original.prepare(
      detailsForMapping,
      payload,
      new Date(),
      initialConfiguration,
    );
    expect(repository.record.encryptedPayload).not.toContain("synthetic-zoho-item");

    const changedActiveConfiguration = {
      ...initialConfiguration,
      configurationId: "synthetic-config-next",
    };
    const persisted = submittedDetails(detailsForMapping);
    const restarted = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    await expect(restarted.load(persisted, new AbortController().signal)).resolves.toEqual({
      available: true,
      payload,
    });
    const restored = await restarted.loadHistoricalMappingConfiguration(persisted);
    expect(restored).toEqual({
      available: true,
      configuration: initialConfiguration,
      digest: digestKraSalesMappingConfiguration(initialConfiguration),
    });
    expect(digestKraSalesMappingConfiguration(changedActiveConfiguration)).not.toBe(
      restored.available ? restored.digest : "",
    );
    const record = repository.record;
    if (!record) throw new Error("expected archived payload record");
    repository.record = {
      ...record,
      encryptedPayload: `${record.encryptedPayload.slice(0, -1)}${record.encryptedPayload.endsWith("A") ? "B" : "A"}`,
    };
    await expect(restarted.loadHistoricalMappingConfiguration(persisted)).rejects.toThrow(
      "could not be verified",
    );
  });

  it("rejects a mapping archive whose operation digest no longer matches", async () => {
    const repository = new PayloadRepository();
    const configuration = syntheticConfiguration("vscu");
    const originalDetails = mappedDetails(configuration);
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    repository.record = vault.prepare(originalDetails, payload, new Date(), configuration);
    const changedDetails = {
      ...originalDetails,
      operation: {
        ...originalDetails.operation,
        adapterConfigurationId: `synthetic-adapter|mapping-sha256:${"f".repeat(64)}`,
      },
    };
    await expect(
      vault.loadHistoricalMappingConfiguration(submittedDetails(changedDetails)),
    ).rejects.toThrow("could not be verified");
  });

  it("reports that legacy payload records do not contain historical mapping configuration", async () => {
    const repository = new PayloadRepository();
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    repository.record = vault.prepare(pendingDetails(), payload, new Date());
    const digestOnlyOperation = submittedDetails({
      ...details(),
      operation: {
        ...details().operation,
        adapterConfigurationId: `synthetic-adapter|mapping-sha256:${"a".repeat(64)}`,
      },
    });
    await expect(vault.loadHistoricalMappingConfiguration(digestOnlyOperation)).resolves.toEqual({
      available: false,
    });
  });

  it("fails closed for missing, corrupted, mismatched, or unsupported payload records", async () => {
    const repository = new PayloadRepository();
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    await expect(vault.load(details(), new AbortController().signal)).resolves.toEqual({
      available: false,
    });

    repository.record = vault.prepare(pendingDetails(), payload, new Date());
    repository.record = {
      ...repository.record,
      encryptedPayload: `${repository.record.encryptedPayload[0] === "A" ? "B" : "A"}${repository.record.encryptedPayload.slice(1)}`,
    };
    await expect(vault.load(details(), new AbortController().signal)).rejects.toThrow();

    repository.record = vault.prepare(pendingDetails(), payload, new Date());
    await expect(vault.load(details("f".repeat(64)), new AbortController().signal)).rejects.toThrow(
      "could not be verified",
    );

    repository.record = { ...repository.record, payloadVersion: 2 };
    await expect(vault.load(details(), new AbortController().signal)).rejects.toThrow(
      "could not be verified",
    );

    repository.record = vault.prepare(pendingDetails(), payload, new Date());
    repository.record = { ...repository.record, encryptedPayload: "AQ" };
    await expect(vault.load(details(), new AbortController().signal)).rejects.toThrow(
      "could not be verified",
    );
  });

  it("rejects changed content, invalid keys, and oversized payloads before persistence", () => {
    const repository = new PayloadRepository();
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    expect(() => vault.prepare(pendingDetails(), { changed: true }, new Date())).toThrow(
      "immutable payload hash",
    );
    expect(() => protection({ "legacy-v1": "not-a-key" })).toThrow("64 hexadecimal characters");
    expect(() =>
      vault.prepare(pendingDetails(), { data: "x".repeat(270 * 1024) }, new Date()),
    ).toThrow("256 KiB");
  });

  it("supports key rotation while retaining old keys for authenticated decryption", async () => {
    const repository = new PayloadRepository();
    const oldVault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    repository.record = oldVault.prepare(pendingDetails(), payload, new Date());
    expect(repository.record.encryptionKeyId).toBe("legacy-v1");

    const rotatedVault = new EtimsSubmissionPayloadVault(
      repository,
      protection({ "legacy-v1": key, "rotation-2": "f".repeat(64) }, "rotation-2"),
    );
    await expect(rotatedVault.load(details(), new AbortController().signal)).resolves.toEqual({
      available: true,
      payload,
    });
    repository.record = rotatedVault.prepare(pendingDetails(), payload, new Date());
    expect(repository.record.encryptionKeyId).toBe("rotation-2");
    await expect(rotatedVault.load(details(), new AbortController().signal)).resolves.toEqual({
      available: true,
      payload,
    });
  });

  it("continues to decrypt stored protection-version 1 records with their original AAD", async () => {
    const repository = new PayloadRepository();
    const value = pendingDetails();
    const json = canonicalEtimsPayload(payload);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          value.operation.id,
          value.operation.fiscalizationRequestId,
          1,
          value.operation.payloadHash,
          "submission",
          1,
        ]),
      ),
    );
    const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    repository.record = {
      operationId: value.operation.id,
      fiscalizationRequestId: value.operation.fiscalizationRequestId,
      payloadVersion: 1,
      protectionVersion: 1,
      encryptionKeyId: "legacy-v1",
      payloadHash: value.operation.payloadHash,
      submissionAttemptType: "submission",
      submissionAttemptNumber: 1,
      encryptedPayload: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
        "base64url",
      ),
      createdAt: new Date(),
    };
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    await expect(vault.load(details(), new AbortController().signal)).resolves.toEqual({
      available: true,
      payload,
    });
  });

  it("authenticates record identifiers and protection metadata as additional data", async () => {
    const repository = new PayloadRepository();
    const vault = new EtimsSubmissionPayloadVault(
      repository,
      protection({ "legacy-v1": key, "other-key": key }),
    );
    repository.record = vault.prepare(pendingDetails(), payload, new Date());
    repository.record = { ...repository.record, encryptionKeyId: "other-key" };
    await expect(vault.load(details(), new AbortController().signal)).rejects.toThrow();

    repository.record = vault.prepare(pendingDetails(), payload, new Date());
    repository.record = { ...repository.record, operationId: "other-operation" };
    await expect(vault.load(details(), new AbortController().signal)).rejects.toThrow(
      "could not be verified",
    );
  });

  it("rejects authenticated plaintext containing invalid UTF-8", async () => {
    const repository = new PayloadRepository();
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    const prepared = vault.prepare(pendingDetails(), payload, new Date());
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          prepared.operationId,
          prepared.fiscalizationRequestId,
          prepared.payloadVersion,
          prepared.payloadHash,
          "submission",
          prepared.submissionAttemptNumber,
          prepared.protectionVersion,
          prepared.encryptionKeyId,
        ]),
      ),
    );
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x80]);
    const ciphertext = Buffer.concat([cipher.update(invalidUtf8), cipher.final()]);
    repository.record = {
      ...prepared,
      encryptedPayload: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString(
        "base64url",
      ),
    };
    await expect(vault.load(details(), new AbortController().signal)).rejects.toThrow(
      "could not be verified",
    );
  });

  it("uses unique cryptographic nonces for independently prepared payloads", () => {
    const repository = new PayloadRepository();
    const vault = new EtimsSubmissionPayloadVault(repository, protection({ "legacy-v1": key }));
    const ciphertexts = new Set<string>();
    for (let index = 0; index < 512; index += 1) {
      const record = vault.prepare(pendingDetails(), payload, new Date());
      const nonce = record.encryptedPayload.slice(0, 16);
      expect(ciphertexts.has(nonce)).toBe(false);
      ciphertexts.add(nonce);
    }
  });
});
