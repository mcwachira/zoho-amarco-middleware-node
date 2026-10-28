import { z } from "zod";

function validDateTime(value: string): boolean {
  if (!/^\d{14}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60
  );
}

export const kraTimestampSchema = z
  .string()
  .refine(validDateTime, "Must be a valid yyyyMMddHHmmss timestamp.");
export const kraTinSchema = z.string().min(11).max(11);
export const kraBranchIdSchema = z.string().length(2);
export const kraCommunicationKeySchema = z.string().min(1).max(255);

export const kraIncrementalReferenceRequestSchema = z
  .object({
    tin: kraTinSchema,
    bhfId: kraBranchIdSchema,
    lastReqDt: kraTimestampSchema,
  })
  .strict();
export type KraIncrementalReferenceRequest = z.infer<typeof kraIncrementalReferenceRequestSchema>;

/** VSCU v2.0 reference queries omit cmcKey; OSCU requests include it in the field tables. */
export const kraVscuReferenceRequestSchema = kraIncrementalReferenceRequestSchema;
export type KraVscuReferenceRequest = z.infer<typeof kraVscuReferenceRequestSchema>;

export const kraOscuReferenceRequestSchema = kraIncrementalReferenceRequestSchema
  .extend({ cmcKey: kraCommunicationKeySchema })
  .strict();
export type KraOscuReferenceRequest = z.infer<typeof kraOscuReferenceRequestSchema>;

/** OSCU v2.0 table requires cmcKey, although its example omits it. */
export const kraOscuCodeRequestSchema = kraOscuReferenceRequestSchema;
export type KraOscuCodeRequest = z.infer<typeof kraOscuCodeRequestSchema>;

export const kraOscuItemSearchRequestSchema = kraOscuReferenceRequestSchema;
export type KraOscuItemSearchRequest = z.infer<typeof kraOscuItemSearchRequestSchema>;

const nullableText = (max: number) => z.string().max(max).nullable().optional();
const codeDetailSchema = z
  .object({
    cd: z.string().max(5),
    cdNm: z.string().max(60),
    cdDesc: nullableText(500),
    srtOrd: z.number().int().nonnegative().optional(),
    userDfnCd1: nullableText(20),
    userDfnCd2: nullableText(20),
    userDfnCd3: nullableText(20),
    useYn: z.string().length(1).optional(),
  })
  .strip();

export const kraCodeListDataSchema = z
  .object({
    clsList: z.array(
      z
        .object({
          cdCls: z.string().max(2),
          cdClsNm: z.string().max(60),
          cdClsDesc: nullableText(500),
          userDfnNm1: nullableText(60),
          userDfnNm2: nullableText(60),
          userDfnNm3: nullableText(60),
          useYn: z.string().length(1).optional(),
          dtlList: z.array(codeDetailSchema),
        })
        .strip(),
    ),
  })
  .strip();

export const kraItemClassListDataSchema = z
  .object({
    itemClsList: z.array(
      z
        .object({
          itemClsCd: z.string().min(1).max(10),
          itemClsNm: z.string().max(200),
          itemClsLvl: z.number().int().nonnegative(),
          taxTyCd: nullableText(5),
          mjrTgYn: nullableText(1),
          useYn: z.string().length(1).optional(),
        })
        .strip(),
    ),
  })
  .strip();

export const kraBranchListDataSchema = z
  .object({
    bhfList: z.array(
      z
        .object({
          tin: kraTinSchema,
          bhfId: kraBranchIdSchema,
          bhfNm: z.string().max(60),
          bhfSttsCd: nullableText(5),
          prvncNm: nullableText(100),
          dstrtNm: nullableText(100),
          sctrNm: nullableText(100),
          locDesc: nullableText(100),
          mgrNm: nullableText(60),
          mgrTelNo: nullableText(20),
          mgrEmail: nullableText(100),
          hqYn: nullableText(1),
        })
        .strip(),
    ),
  })
  .strip();

export const kraItemListDataSchema = z
  .object({
    itemList: z.array(
      z
        .object({
          tin: kraTinSchema.optional(),
          itemCd: z.string().max(20),
          itemClsCd: z.string().max(10),
          itemTyCd: z.string().max(5),
          itemNm: z.string().max(200),
          itemStdNm: nullableText(200),
          orgnNatCd: nullableText(5),
          pkgUnitCd: nullableText(5),
          qtyUnitCd: nullableText(5),
          taxTyCd: nullableText(5),
          btchNo: nullableText(10),
          regBhfId: kraBranchIdSchema.optional(),
          bcd: nullableText(20),
          dftPrc: z.number().finite().nonnegative().optional(),
          grpPrcL1: z.number().finite().nonnegative().optional(),
          grpPrcL2: z.number().finite().nonnegative().optional(),
          grpPrcL3: z.number().finite().nonnegative().optional(),
          grpPrcL4: z.number().finite().nonnegative().optional(),
          grpPrcL5: z.number().finite().nonnegative().optional(),
          addInfo: nullableText(7),
          sftyQty: z.number().finite().nonnegative().optional(),
          isrcAplcbYn: nullableText(1),
          rraModYn: nullableText(1),
          KRAModYn: nullableText(1),
          useYn: nullableText(1),
        })
        .strip(),
    ),
  })
  .strip();

export type KraCodeListData = z.infer<typeof kraCodeListDataSchema>;
export type KraItemClassListData = z.infer<typeof kraItemClassListDataSchema>;
export type KraBranchListData = z.infer<typeof kraBranchListDataSchema>;
export type KraItemListData = z.infer<typeof kraItemListDataSchema>;
