import type { FiscalizationStatus } from "./status.js";

/**
 * Defines which status changes are allowed.
 *
 * Pending -> InProgress:
 *   A worker claims the fiscalization for processing.
 *
 * InProgress -> Succeeded:
 *   The device operation is confirmed successful.
 *
 * InProgress -> Failed:
 *   We know the fiscal operation failed.
 *
 * InProgress -> OutcomeUnknown:
 *   We cannot determine whether the device completed the operation.
 *
 * All other transitions are prohibited.
 *
 * `Record` ensures that every FiscalizationStatus has an entry.
 * `readonly` prevents us from modifying the allowed lists accidentally.
 */
const allowedTransitions: Record<FiscalizationStatus, readonly FiscalizationStatus[]> = {
  Pending: ["InProgress"],
  InProgress: ["Succeeded", "Failed", "OutcomeUnknown"],
  Succeeded: [],
  Failed: [],
  OutcomeUnknown: [],
};

/**
 * Checks whether a status change is allowed by our business rules.
 *
 * This function only checks the rule. It does not update a database
 * record or perform any fiscal device operation.
 *
 * @param from - The current status.
 * @param to - The status we want to move to.
 * @returns true if the transition is allowed; otherwise false.
 */
export function canTransition(from: FiscalizationStatus, to: FiscalizationStatus): boolean {
  // Get the allowed destination statuses for the current status,
  // then check whether the requested destination is in that list.
  return allowedTransitions[from].includes(to);
}
