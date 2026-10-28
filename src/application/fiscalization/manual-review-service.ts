import { randomUUID } from "node:crypto";
import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { EtimsReportingService } from "./etims-reporting-service.js";
import type { ManualReviewOutcome, ManualReviewRepository } from "./manual-review-repository.js";

export interface ManualReviewEvidenceVerifier {
  verify(input: {
    readonly operationId: string;
    readonly requestedOutcome: Exclude<ManualReviewOutcome, "still_unknown">;
    readonly evidenceReference: string;
  }): Promise<boolean>;
}

export class ManualReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualReviewConflictError";
  }
}

export class ManualReviewService {
  constructor(
    private readonly fiscalizations: FiscalizationRepository,
    private readonly reviews: ManualReviewRepository,
    private readonly etims?: Pick<EtimsReportingService, "getByFiscalizationRequestId">,
    private readonly evidenceVerifier?: ManualReviewEvidenceVerifier,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async open(input: {
    requestId: string;
    stage: "device" | "etims";
    reason: string;
    operatorSubject: string;
  }) {
    const record = await this.fiscalizations.findById(input.requestId);
    if (!record) return null;
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new ManualReviewConflictError("A review reason of 1-500 characters is required.");

    let operationId: string;
    let observedState: string;
    let relatedAttemptIds: string[];
    if (input.stage === "device") {
      if (record.status !== "OutcomeUnknown") {
        throw new ManualReviewConflictError(
          "Device review requires a persisted uncertain device operation.",
        );
      }
      const attempts = (await this.fiscalizations.findAttemptsByRequestId?.(record.id)) ?? [];
      if (attempts.length === 0)
        throw new ManualReviewConflictError("No persisted device attempt is available for review.");
      operationId = attempts.at(-1)!.id;
      observedState = record.status;
      relatedAttemptIds = attempts.map((attempt) => attempt.id);
    } else {
      const details = await this.etims?.getByFiscalizationRequestId(record.id);
      if (!details)
        throw new ManualReviewConflictError(
          "No persisted eTIMS operation is available for review.",
        );
      if (!["outcome_unknown", "reconciliation_required"].includes(details.operation.status)) {
        throw new ManualReviewConflictError(
          "eTIMS review requires a persisted uncertain or reconciliation-required operation.",
        );
      }
      operationId = details.operation.id;
      observedState = details.operation.status;
      relatedAttemptIds = details.attempts.map((attempt) => attempt.id);
    }

    return this.reviews.openCase({
      id: this.createId(),
      fiscalizationRequestId: record.id,
      operationId,
      relatedAttemptIds,
      observedState,
      reason,
      initiatingOperatorSubject: input.operatorSubject,
      createdAt: this.now(),
    });
  }

  get(caseId: string) {
    return this.reviews.getCase(caseId);
  }

  findExisting(requestId: string, operationId: string) {
    return this.reviews.getByRequestAndOperation(requestId, operationId);
  }

  getByRequestId(requestId: string) {
    return this.reviews.getByRequestId(requestId);
  }
  listUnresolved(limit: number, offset: number) {
    return this.reviews.listUnresolved({ limit, offset });
  }

  async decide(input: {
    caseId: string;
    operatorSubject: string;
    requestedOutcome: ManualReviewOutcome;
    reason: string;
    evidenceReference?: string;
  }) {
    const review = await this.reviews.getCase(input.caseId);
    if (!review) return null;
    if (review.status !== "open")
      throw new ManualReviewConflictError("This review case already has a confirmed resolution.");
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
      throw new ManualReviewConflictError("A decision reason of 1-500 characters is required.");

    let resolution: "operator_attested" | "still_unknown" | "invalid_evidence";
    const reference = input.evidenceReference?.trim() || null;
    if (
      input.requestedOutcome === "still_unknown" ||
      input.requestedOutcome === "escalated" ||
      input.requestedOutcome === "investigation_note"
    ) {
      resolution = "still_unknown";
    } else {
      const validReference = reference !== null && isSafeEvidenceReference(reference);
      const independentlyVerified =
        validReference && this.evidenceVerifier
          ? await this.evidenceVerifier.verify({
              operationId: review.operationId,
              requestedOutcome: input.requestedOutcome,
              evidenceReference: reference,
            })
          : false;
      resolution =
        validReference && (independentlyVerified || !this.evidenceVerifier)
          ? "operator_attested"
          : "invalid_evidence";
    }
    return this.reviews.recordDecision({
      id: this.createId(),
      caseId: review.id,
      operatorSubject: input.operatorSubject,
      requestedOutcome: input.requestedOutcome,
      resolution,
      reason,
      evidenceReference: reference,
      recordedAt: this.now(),
    });
  }
}

function isSafeEvidenceReference(reference: string): boolean {
  if (reference.length > 500 || [...reference].some((character) => character.charCodeAt(0) < 32))
    return false;
  if (/^https:\/\//i.test(reference)) {
    try {
      const url = new URL(reference);
      return !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,199}$/.test(reference);
}
