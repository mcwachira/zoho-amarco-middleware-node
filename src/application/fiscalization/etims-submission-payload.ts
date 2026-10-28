export interface EtimsSubmissionPayloadRecord {
  readonly operationId: string;
  readonly fiscalizationRequestId: string;
  readonly payloadVersion: number;
  readonly protectionVersion: number;
  readonly encryptionKeyId: string;
  readonly payloadHash: string;
  readonly submissionAttemptType: "submission";
  readonly submissionAttemptNumber: number;
  readonly encryptedPayload: string;
  readonly createdAt: Date;
}

export interface EtimsSubmissionPayloadRepository {
  findSubmissionPayload(
    operationId: string,
    submissionAttemptNumber: number,
  ): Promise<EtimsSubmissionPayloadRecord | null>;
}

/** Integrity failures are permanent until an operator restores the correct evidence. */
export class EtimsSubmissionPayloadIntegrityError extends Error {
  constructor() {
    super("Stored eTIMS payload could not be verified.");
    this.name = "EtimsSubmissionPayloadIntegrityError";
  }
}

export interface EtimsSubmissionPayloadClaim {
  readonly operationId: string;
  readonly now: Date;
  readonly payload: EtimsSubmissionPayloadRecord;
}
