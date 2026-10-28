import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createApplicationLogger } from "../../src/observability/logger.js";
import { runWithCorrelationId } from "../../src/observability/request-context.js";

describe("structured log redaction", () => {
  it("redacts credentials and sensitive business/provider objects and adds request correlation", () => {
    let output = "";
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createApplicationLogger({ level: "info", destination });
    runWithCorrelationId("request-trace:17", () =>
      logger.info(
        {
          authorization: "bearer-sensitive",
          accessToken: "access-sensitive",
          DATABASE_URL: "postgresql://sensitive-user:sensitive-password@db.example.invalid/app",
          OPERATOR_API_BEARER_TOKEN: "operator-sensitive",
          ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON: "keyring-sensitive",
          headers: { authorization: "header-sensitive" },
          invoice: { total: "invoice-sensitive" },
          context: { customerName: "customer-sensitive", providerResponse: "provider-sensitive" },
        },
        "synthetic diagnostic",
      ),
    );
    for (const secret of [
      "bearer-sensitive",
      "access-sensitive",
      "sensitive-password",
      "operator-sensitive",
      "keyring-sensitive",
      "header-sensitive",
      "invoice-sensitive",
      "customer-sensitive",
      "provider-sensitive",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("request-trace:17");
    expect(output).toContain("[REDACTED]");
  });
});
