import { describe, expect, it } from "vitest";
import { resolveCorrelationId } from "../../src/observability/request-context.js";

describe("request correlation identifiers", () => {
  it.each([undefined, "bad correlation", "x".repeat(129), ["one", "two"]])(
    "generates a cryptographic ID for invalid or duplicate headers: %s",
    (header) => {
      const id = resolveCorrelationId(header);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it("accepts bounded safe ASCII IDs and replaces an empty duplicate header", () => {
    expect(resolveCorrelationId("ops-check:42.test_1")).toBe("ops-check:42.test_1");
    expect(resolveCorrelationId("")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
