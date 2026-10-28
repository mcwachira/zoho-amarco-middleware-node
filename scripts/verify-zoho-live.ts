import "dotenv/config";
import { randomUUID } from "node:crypto";
import { parseEnvironment } from "../src/config/env.js";
import { ZohoOAuthService } from "../src/application/zoho/zoho-oauth-service.js";
import { mapZohoInvoice } from "../src/application/zoho/zoho-invoice-mapper.js";
import {
  parseZohoFiscalizationWritebackConfiguration,
  type ZohoFiscalizationWritebackConfiguration,
} from "../src/application/zoho/zoho-fiscalization-writeback-config.js";
import { PostgresqlZohoOAuthAttemptRepository } from "../src/infrastructure/database/postgresql-zoho-oauth-attempt-repository.js";
import { createPostgresqlClient } from "../src/infrastructure/database/postgresql-client.js";
import { PostgresqlZohoTokenRepository } from "../src/infrastructure/database/postgresql-zoho-token-repository.js";
import {
  ZohoBooksApiError,
  ZohoBooksAuthorizationError,
  ZohoBooksClient,
  ZohoBooksResponseError,
  ZohoBooksTransportError,
  isValidZohoBooksIdentifier,
} from "../src/integrations/zoho/books-client.js";
import {
  inspectZohoInvoiceCustomFields,
  resolveZohoLiveVerificationDatabaseUrl,
  ZohoLiveVerificationIssue,
} from "../src/integrations/zoho/live-verification.js";
import { parseZohoBooksApiDomain } from "../src/integrations/zoho/api-domain.js";
import { parseZohoAccountsDomain } from "../src/integrations/zoho/accounts-domain.js";
import { runWithCorrelationId } from "../src/observability/request-context.js";

class VerificationError extends Error {
  constructor(
    readonly category: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
  }
}

const permitted = process.env["ZOHO_LIVE_VERIFY"] === "1";
if (!permitted) {
  console.error("Live Zoho verification is disabled. Set ZOHO_LIVE_VERIFY=1 to opt in.");
  process.exitCode = 2;
} else {
  await verify();
}

async function verify(): Promise<void> {
  let client: ReturnType<typeof createPostgresqlClient> | undefined;
  const correlationId = randomUUID();
  try {
    let env: ReturnType<typeof parseEnvironment>;
    try {
      env = parseEnvironment(process.env);
    } catch {
      throw new VerificationError(
        "configuration",
        "Application configuration is invalid; review Zoho and database settings.",
      );
    }
    let databaseUrl: string;
    try {
      databaseUrl = resolveZohoLiveVerificationDatabaseUrl(
        process.env["ZOHO_LIVE_VERIFY_DATABASE_URL"],
        env.DATABASE_URL,
      );
    } catch (error) {
      if (error instanceof ZohoLiveVerificationIssue) {
        throw new VerificationError(error.category, error.message);
      }
      throw error;
    }
    if (env.NODE_ENV === "production") {
      throw new VerificationError(
        "configuration",
        "Live read-only verification cannot run with NODE_ENV=production.",
      );
    }
    if (
      !env.ZOHO_CLIENT_ID ||
      !env.ZOHO_CLIENT_SECRET ||
      !env.ZOHO_OAUTH_ENCRYPTION_KEY ||
      !env.ZOHO_ORGANIZATION_ID
    ) {
      throw new VerificationError(
        "configuration",
        "Zoho client credentials, encryption key, and organization ID are required.",
      );
    }
    const invoiceId = required("ZOHO_LIVE_TEST_INVOICE_ID");
    if (!isValidZohoBooksIdentifier(invoiceId)) {
      throw new VerificationError(
        "configuration",
        "ZOHO_LIVE_TEST_INVOICE_ID is malformed for Zoho Books.",
      );
    }
    let writeback: ZohoFiscalizationWritebackConfiguration | undefined;
    try {
      writeback = env.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON
        ? parseZohoFiscalizationWritebackConfiguration(env.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON)
        : undefined;
    } catch {
      throw new VerificationError(
        "configuration",
        "ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON is invalid.",
      );
    }
    const mappedFieldIds = writeback
      ? [
          writeback.statusFieldId,
          writeback.deviceReceiptNumberFieldId,
          writeback.etimsReferenceFieldId,
          writeback.fiscalizedAtFieldId,
          writeback.requestIdFieldId,
        ].filter((value): value is string => value !== undefined)
      : [];
    if (!parseZohoAccountsDomain(env.ZOHO_ACCOUNTS_URL))
      throw new VerificationError(
        "configuration",
        "ZOHO_ACCOUNTS_URL must be a supported Zoho Accounts origin.",
      );

    client = createPostgresqlClient(databaseUrl, {
      connectionTimeoutMs: 5_000,
      statementTimeoutMs: 10_000,
    });
    const tokenRepository = new PostgresqlZohoTokenRepository(client);
    const stored = await tokenRepository.get();
    if (!stored?.encryptedRefreshToken)
      throw new VerificationError(
        "configuration",
        "No connected Zoho token with a refresh token exists in the isolated verification database.",
      );
    const attemptRepository = new PostgresqlZohoOAuthAttemptRepository(client);
    const oauth = new ZohoOAuthService({
      repository: attemptRepository,
      tokenRepository,
      clientId: env.ZOHO_CLIENT_ID,
      clientSecret: env.ZOHO_CLIENT_SECRET,
      redirectUri: env.ZOHO_REDIRECT_URI,
      accountsUrl: env.ZOHO_ACCOUNTS_URL,
      encryptionKey: env.ZOHO_OAUTH_ENCRYPTION_KEY,
      scopes: ["ZohoBooks.invoices.READ"],
    });
    const auth = await oauth.getAccessToken();
    const apiUrl = parseZohoBooksApiDomain(auth.apiDomain);
    if (!apiUrl)
      throw new VerificationError(
        "configuration",
        "Stored Zoho API data center is not in the trusted allowlist.",
      );
    if (!sameDataCenter(env.ZOHO_ACCOUNTS_URL, auth.apiDomain))
      throw new VerificationError(
        "configuration",
        "Configured Accounts and token API data centers do not match.",
      );
    const granted = new Set(auth.scopes.split(/[\s,]+/).filter(Boolean));
    const requiredScopes = ["ZohoBooks.invoices.READ"];
    if (requiredScopes.some((scope) => !granted.has(scope)))
      throw new VerificationError(
        "authorization",
        "The stored OAuth grant lacks a required invoice scope.",
      );

    const books = new ZohoBooksClient({
      tokenProvider: oauth,
      organizationId: env.ZOHO_ORGANIZATION_ID,
      maxRetries: 1,
    });
    await runWithCorrelationId(correlationId, async () => {
      console.log(
        JSON.stringify({
          operation: "oauth_configuration_and_scope",
          result: "passed",
          correlationId,
          dataCenter: apiUrl.hostname,
        }),
      );
      const invoice = await books.getInvoice(invoiceId, AbortSignal.timeout(12_000));
      if (invoice.invoiceId !== invoiceId)
        throw new VerificationError(
          "validation",
          "Returned invoice did not match the designated test invoice.",
        );
      const customFields = inspectZohoInvoiceCustomFields(invoice.source, mappedFieldIds);
      const mapping = mapZohoInvoice(invoice);
      console.log(
        JSON.stringify({
          operation: "get_designated_invoice_and_map",
          result: mapping.success ? "passed" : "failed",
          correlationId,
          customFieldCount: customFields.count,
          customFieldShape: customFields.shape,
          mapperAccepted: mapping.success,
          configuredCustomFields: customFields.configuredFields,
        }),
      );
      if (!mapping.success) process.exitCode = 1;
    });
  } catch (error) {
    const status = error instanceof ZohoBooksApiError ? error.status : undefined;
    console.error(
      JSON.stringify({
        operation: "live_tenant_verification",
        result: "failed",
        correlationId,
        ...(status ? { httpStatus: status } : {}),
        category: classify(error),
        ...(error instanceof VerificationError ? { detail: error.safeMessage } : {}),
      }),
    );
    process.exitCode = 1;
  } finally {
    try {
      await client?.$disconnect();
    } catch {
      // Avoid emitting adapter errors that may contain connection details.
      process.exitCode = 1;
    }
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new VerificationError("configuration", `${name} is required.`);
  return value;
}

function sameDataCenter(accounts: string, api: string): boolean {
  const a = new URL(accounts).hostname;
  const b = new URL(api).hostname;
  const region = a.replace("accounts.zoho", "");
  return b.endsWith(`zohoapis${region}`);
}

function classify(error: unknown): string {
  if (error instanceof VerificationError) return error.category;
  if (error instanceof ZohoLiveVerificationIssue) return error.category;
  if (error instanceof ZohoBooksAuthorizationError) return "authorization";
  if (error instanceof ZohoBooksResponseError) return "malformed_response";
  if (error instanceof ZohoBooksTransportError) return error.category;
  if (error instanceof ZohoBooksApiError) {
    if (error.status === 401) return "authentication";
    if (error.status === 403) return "authorization";
    if (error.status === 404) {
      return error.apiCode === 1002 ? "invoice_not_found" : "not_found_ambiguous";
    }
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "provider_error";
    return "validation_or_request_error";
  }
  return "configuration_or_unexpected";
}
