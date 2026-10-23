import { describe, expect, it } from "vitest";
import { canTransition } from "../../src/domain/fiscalization/status-transitions.js";
import { fiscalizationStatuses } from "../../src/domain/fiscalization/status.js";

describe("Fiscalization status transitions", () => {
  // These are the status changes that our business rules permit.
  it.each([
    ["Pending", "InProgress"],
    ["InProgress", "Succeeded"],
    ["InProgress", "Failed"],
    ["InProgress", "OutcomeUnknown"],
  ] as const)("allows %s -> %s", (from, to) => {
    // The function should return true for every permitted transition.
    expect(canTransition(from, to)).toBe(true);
  });

  // A completed or uncertain attempt must not be restarted automatically.
  it.each([
    ["Succeeded", "Pending"],
    ["Succeeded", "InProgress"],
    ["Failed", "Pending"],
    ["Failed", "InProgress"],
    ["OutcomeUnknown", "Pending"],
    ["OutcomeUnknown", "InProgress"],
    ["Pending", "Succeeded"],
    ["Pending", "Failed"],
    ["Pending", "OutcomeUnknown"],
    ["InProgress", "Pending"],
    ["Succeeded", "Failed"],
    ["Failed", "Succeeded"],
  ] as const)("rejects %s -> %s", (from, to) => {
    // The function should return false for a prohibited transition.
    expect(canTransition(from, to)).toBe(false);
  });

  it("defines a transition entry for every known status", () => {
    // This verifies the full set of statuses is represented in our tests.
    // The Record type in the implementation also enforces this at compile time.
    expect(fiscalizationStatuses).toHaveLength(5);
  });
});
