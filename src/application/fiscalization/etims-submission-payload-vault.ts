import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EtimsReportingOperationDetails } from "../../domain/fiscalization/etims-reporting.js";
import { hashEtimsPayload } from "./etims-reporting-service.js";
import type { EtimsReconciliationPayloadResolver } from "./etims-reconciliation-worker.js";
import type {
  EtimsSubmissionPayloadRecord,
  EtimsSubmissionPayloadRepository,
} from "./etims-submission-payload.js";
import { EtimsSubmissionPayloadIntegrityError } from "./etims-submission-payload.js";
import {
  digestKraSalesMappingConfiguration,
  kraSalesMappingConfigurationSchema,
  type KraSalesMappingConfiguration,
} from "../etims/kra-sales-mapping.js";

const VERSION = 1;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAPPED_PAYLOAD_FORMAT = "mapped-submission-with-configuration-v1";

interface MappedPayloadArchive {
  readonly format: typeof MAPPED_PAYLOAD_FORMAT;
  readonly payload: unknown;
  readonly mappingConfiguration: KraSalesMappingConfiguration;
  readonly mappingConfigurationDigest: string;
}

export interface EtimsPayloadProtection {
  currentKeyId(): string;
  encrypt(plaintext: Buffer, associatedData: Buffer): string;
  decrypt(encryptionKeyId: string, ciphertext: string, associatedData: Buffer): Buffer;
}

export interface EtimsPayloadKeyProvider {
  currentKeyId(): string;
  getKey(keyId: string): Buffer | null;
}

const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export class ConfiguredEtimsPayloadKeyProvider implements EtimsPayloadKeyProvider {
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(
    keyring: Readonly<Record<string, string>>,
    private readonly activeId: string,
  ) {
    if (!KEY_ID_PATTERN.test(activeId) || !Object.hasOwn(keyring, activeId)) {
      throw new Error("The active eTIMS payload encryption key ID is unavailable.");
    }
    const entries = Object.entries(keyring);
    if (entries.length === 0 || entries.length > 20) {
      throw new Error("The eTIMS payload keyring must contain between 1 and 20 keys.");
    }
    this.keys = new Map(
      entries.map(([keyId, hexKey]) => {
        if (!KEY_ID_PATTERN.test(keyId) || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
          throw new Error(
            "Each eTIMS payload key must be identified and contain 64 hexadecimal characters.",
          );
        }
        return [keyId, Buffer.from(hexKey, "hex")];
      }),
    );
  }

  currentKeyId(): string {
    return this.activeId;
  }

  getKey(keyId: string): Buffer | null {
    const key = this.keys.get(keyId);
    return key ? Buffer.from(key) : null;
  }
}

export function canonicalEtimsPayload(payload: unknown): string {
  const canonical = canonicalize(payload);
  const json = JSON.stringify(canonical);
  if (json === undefined) throw new Error("eTIMS payload must be JSON serializable.");
  const bytes = Buffer.from(json, "utf8");
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("eTIMS payload exceeds the 256 KiB storage limit.");
  }
  if (hashEtimsPayload(JSON.parse(json) as unknown) !== hashEtimsPayload(payload)) {
    throw new Error("eTIMS payload did not survive canonical JSON encoding.");
  }
  return json;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("eTIMS payload must contain only JSON-compatible values.");
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new Error("eTIMS payload must contain only JSON-compatible values.");
}

export class AesGcmEtimsPayloadProtection implements EtimsPayloadProtection {
  private readonly keyProvider: EtimsPayloadKeyProvider;

  constructor(keyProvider: EtimsPayloadKeyProvider | string) {
    this.keyProvider =
      typeof keyProvider === "string"
        ? new ConfiguredEtimsPayloadKeyProvider({ "legacy-v1": keyProvider }, "legacy-v1")
        : keyProvider;
  }

  currentKeyId(): string {
    return this.keyProvider.currentKeyId();
  }

  encrypt(plaintext: Buffer, associatedData: Buffer): string {
    const key = this.keyProvider.getKey(this.currentKeyId());
    if (!key || key.byteLength !== 32) {
      throw new Error("The active eTIMS payload encryption key is unavailable.");
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  decrypt(encryptionKeyId: string, encrypted: string, associatedData: Buffer): Buffer {
    if (!/^[A-Za-z0-9_-]+$/.test(encrypted)) {
      throw new Error("Stored eTIMS encrypted payload is malformed.");
    }
    const data = Buffer.from(encrypted, "base64url");
    if (data.length < NONCE_BYTES + TAG_BYTES + 1) {
      throw new Error("Stored eTIMS encrypted payload is malformed.");
    }
    if (data.toString("base64url") !== encrypted) {
      throw new Error("Stored eTIMS encrypted payload encoding is invalid.");
    }
    const key = this.keyProvider.getKey(encryptionKeyId);
    if (!key || key.byteLength !== 32) {
      throw new Error("The eTIMS payload encryption key version is unavailable.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, NONCE_BYTES));
    decipher.setAAD(associatedData);
    decipher.setAuthTag(data.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(data.subarray(NONCE_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}

function aad(
  record: Pick<
    EtimsSubmissionPayloadRecord,
    | "operationId"
    | "fiscalizationRequestId"
    | "payloadVersion"
    | "payloadHash"
    | "submissionAttemptNumber"
    | "protectionVersion"
    | "encryptionKeyId"
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      record.operationId,
      record.fiscalizationRequestId,
      record.payloadVersion,
      record.payloadHash,
      "submission",
      record.submissionAttemptNumber,
      record.protectionVersion,
      record.encryptionKeyId,
    ]),
    "utf8",
  );
}

function legacyAad(
  record: Pick<
    EtimsSubmissionPayloadRecord,
    | "operationId"
    | "fiscalizationRequestId"
    | "payloadVersion"
    | "payloadHash"
    | "submissionAttemptNumber"
  >,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      record.operationId,
      record.fiscalizationRequestId,
      record.payloadVersion,
      record.payloadHash,
      "submission",
      record.submissionAttemptNumber,
    ]),
    "utf8",
  );
}

const LEGACY_PROTECTION_VERSION = 1;
const CURRENT_PROTECTION_VERSION = 2;

export class EtimsSubmissionPayloadVault implements EtimsReconciliationPayloadResolver {
  constructor(
    private readonly repository: EtimsSubmissionPayloadRepository,
    private readonly protection: EtimsPayloadProtection,
  ) {}

  prepare(
    details: EtimsReportingOperationDetails,
    payload: unknown,
    createdAt: Date,
    mappingConfiguration?: unknown,
  ): EtimsSubmissionPayloadRecord {
    const operation = details.operation;
    const serializedPayload = canonicalEtimsPayload(payload);
    const payloadHash = hashEtimsPayload(JSON.parse(serializedPayload) as unknown);
    if (payloadHash !== operation.payloadHash) {
      throw new Error("Prepared eTIMS payload does not match the immutable payload hash.");
    }
    let content: unknown = payload;
    if (mappingConfiguration !== undefined) {
      const configuration = kraSalesMappingConfigurationSchema.parse(mappingConfiguration);
      const digest = digestKraSalesMappingConfiguration(configuration);
      if (!operation.adapterConfigurationId?.endsWith(`|mapping-sha256:${digest}`)) {
        throw new Error("Archived mapping configuration does not match the operation digest.");
      }
      content = {
        format: MAPPED_PAYLOAD_FORMAT,
        payload,
        mappingConfiguration: configuration,
        mappingConfigurationDigest: digest,
      } satisfies MappedPayloadArchive;
    }
    const serialized = canonicalEtimsPayload(content);
    const base = {
      operationId: operation.id,
      fiscalizationRequestId: operation.fiscalizationRequestId,
      payloadVersion: VERSION,
      protectionVersion: CURRENT_PROTECTION_VERSION,
      encryptionKeyId: this.protection.currentKeyId(),
      payloadHash,
      submissionAttemptType: "submission" as const,
      submissionAttemptNumber: operation.attemptNumber + 1,
      createdAt,
    };
    const encryptedPayload = this.protection.encrypt(Buffer.from(serialized, "utf8"), aad(base));
    return { ...base, encryptedPayload };
  }

  async load(
    details: EtimsReportingOperationDetails,
    signal: AbortSignal,
  ): Promise<
    { readonly available: true; readonly payload: unknown } | { readonly available: false }
  > {
    const content = await this.loadContent(details, signal);
    if (!content.available) return content;
    return { available: true, payload: this.unwrapPayload(content.content) };
  }

  async loadHistoricalMappingConfiguration(
    details: EtimsReportingOperationDetails,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<
    | {
        readonly available: true;
        readonly configuration: KraSalesMappingConfiguration;
        readonly digest: string;
      }
    | { readonly available: false }
  > {
    const loaded = await this.loadContent(details, signal);
    if (!loaded.available) return loaded;
    const archive = this.asArchive(loaded.content);
    if (!archive) return { available: false };
    const actualDigest = digestKraSalesMappingConfiguration(archive.mappingConfiguration);
    const operation = details.operation;
    if (
      actualDigest !== archive.mappingConfigurationDigest ||
      !operation.adapterConfigurationId?.endsWith(`|mapping-sha256:${actualDigest}`)
    ) {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    return {
      available: true,
      configuration: archive.mappingConfiguration,
      digest: actualDigest,
    };
  }

  private async loadContent(
    details: EtimsReportingOperationDetails,
    signal: AbortSignal,
  ): Promise<
    { readonly available: true; readonly content: unknown } | { readonly available: false }
  > {
    if (signal.aborted) return { available: false };
    const operation = details.operation;
    const record = await this.repository.findSubmissionPayload(
      operation.id,
      operation.attemptNumber,
    );
    if (!record) return { available: false };
    if (
      record.operationId !== operation.id ||
      record.fiscalizationRequestId !== operation.fiscalizationRequestId ||
      record.payloadVersion !== VERSION ||
      (record.protectionVersion !== LEGACY_PROTECTION_VERSION &&
        record.protectionVersion !== CURRENT_PROTECTION_VERSION) ||
      !KEY_ID_PATTERN.test(record.encryptionKeyId) ||
      record.payloadHash !== operation.payloadHash ||
      record.submissionAttemptType !== "submission" ||
      record.submissionAttemptNumber !== operation.attemptNumber
    ) {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    let decrypted: Buffer;
    try {
      decrypted = this.protection.decrypt(
        record.encryptionKeyId,
        record.encryptedPayload,
        record.protectionVersion === LEGACY_PROTECTION_VERSION ? legacyAad(record) : aad(record),
      );
    } catch {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    const plaintext = Buffer.from(decrypted);
    if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(json) as unknown;
    } catch {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    const integrityValid = (() => {
      try {
        if (canonicalEtimsPayload(payload) !== json) return false;
        const request = this.unwrapPayload(payload);
        return hashEtimsPayload(request) === record.payloadHash;
      } catch {
        return false;
      }
    })();
    if (!integrityValid) {
      throw new EtimsSubmissionPayloadIntegrityError();
    }
    return { available: true, content: payload };
  }

  private asArchive(value: unknown): MappedPayloadArchive | null {
    if (
      typeof value !== "object" ||
      value === null ||
      !("format" in value) ||
      value.format !== MAPPED_PAYLOAD_FORMAT ||
      !("mappingConfiguration" in value) ||
      !("mappingConfigurationDigest" in value) ||
      typeof value.mappingConfigurationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.mappingConfigurationDigest) ||
      !("payload" in value)
    ) {
      return null;
    }
    const parsed = kraSalesMappingConfigurationSchema.safeParse(value.mappingConfiguration);
    if (!parsed.success) throw new EtimsSubmissionPayloadIntegrityError();
    return {
      format: MAPPED_PAYLOAD_FORMAT,
      payload: value.payload,
      mappingConfiguration: parsed.data,
      mappingConfigurationDigest: value.mappingConfigurationDigest,
    };
  }

  private unwrapPayload(content: unknown): unknown {
    const archive = this.asArchive(content);
    return archive ? archive.payload : content;
  }
}
