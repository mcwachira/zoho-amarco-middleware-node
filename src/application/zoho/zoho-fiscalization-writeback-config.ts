import { z } from "zod";

const fieldId = z.string().regex(/^\d{1,40}$/);

export const zohoFiscalizationWritebackConfigurationSchema = z
  .object({
    statusFieldId: fieldId,
    successStatusValue: z.string().trim().min(1).max(1_000),
    deviceReceiptNumberFieldId: fieldId.optional(),
    etimsReferenceFieldId: fieldId.optional(),
    fiscalizedAtFieldId: fieldId.optional(),
    requestIdFieldId: fieldId.optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    const ids = [
      configuration.statusFieldId,
      configuration.deviceReceiptNumberFieldId,
      configuration.etimsReferenceFieldId,
      configuration.fiscalizedAtFieldId,
      configuration.requestIdFieldId,
    ].filter((value): value is string => value !== undefined);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Zoho invoice custom-field IDs must be unique.",
      });
    }
  });

export type ZohoFiscalizationWritebackConfiguration = z.infer<
  typeof zohoFiscalizationWritebackConfigurationSchema
>;

export function parseZohoFiscalizationWritebackConfiguration(
  serialized: string,
): ZohoFiscalizationWritebackConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON must contain valid JSON.");
  }
  const result = zohoFiscalizationWritebackConfigurationSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON has an invalid field mapping.");
  }
  return result.data;
}
