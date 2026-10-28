# Fiscal mapping and configuration

## Existing source path

`mapZohoInvoice` validates Zoho invoice identity, currency, an invoice date when
present, positive quantities, non-negative prices/tax amounts/discounts, source
decimal values, and exact subtotal-plus-tax-to-total consistency. It retains
line order, Zoho item IDs, tax IDs and labels, invoice and line discount
evidence, and the source discount-before-tax flag when Zoho supplies them. It
does not calculate tax, apply discounts, or infer a tax classification; the
saved discount fields are audit inputs for a separately approved calculation
source. `PrepareFiscalizationRequestService` resolves explicit
customer and item profiles and freezes those values, the invoice, and available
payment evidence into a digest-protected immutable snapshot.

Customer profiles describe the invoice customer; they do not prove the
middleware taxpayer's identity or KRA enrollment. Existing item fields
(`measureUnit`, `hsCode`, `hsName`, `vatClass`, `vatGroupRate`) support the
current receipt-planning boundary. They are not KRA codes. The direct OSCU and
VSCU request schemas validate complete wire shapes but are not invoice mappers.

## Versioned local mapping configuration

`kraSalesMappingConfigurationSchema` in
`src/application/etims/kra-sales-mapping.ts` is strict, supports only
`schemaVersion: 1`, and rejects unknown fields and unsupported versions.
Mapping keys are stable source IDs; display names, descriptions, SKUs, and
percentages are never used as lookup keys.

| Configuration section | Required mapping or policy                                                                     | Local validation                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`            | Explicit `oscu` or `vscu`                                                                      | No fallback. OSCU requires an explicit `cmcKey`; VSCU requires an explicitly allocated `rptNo`.                                                                                              |
| `taxpayer`            | TIN, branch ID, registrant/modifier identifiers and names                                      | Existing request-schema shape and length checks. Does not prove registration or enrollment. Secret values are excluded from error messages.                                                  |
| `itemMappings[]`      | Exact Zoho item ID to explicit KRA item class, item code/name, package unit, and quantity unit | Required fields and sizes validated; duplicate source IDs rejected. No code is derived from a name or SKU. Official code validity remains unresolved.                                        |
| `taxMappings[]`       | Exact Zoho tax ID to explicit KRA tax type, bucket A–E, and rate                               | Duplicate source IDs rejected. Tax name/percentage matching is prohibited. Multiple mappings in one bucket must use a consistent rate.                                                       |
| `paymentMappings[]`   | Stable source payment-method ID to KRA payment code                                            | Duplicate IDs rejected. Every snapshot payment must be bound to one method ID in calculation evidence. Missing method IDs, missing mappings, or multiple distinct mapped codes are rejected. |
| `document`            | Receipt/status codes, explicit buyer-PIN inclusion, and whether payment evidence is required   | Required settings have no defaults. Contract schema validates shape, not official acceptance.                                                                                                |
| `sequencePolicy`      | Policy ID/version and `externalAllocationRequired: true`                                       | Engine does not allocate counters. Context must carry explicit counters, trader invoice number, and allocation reference.                                                                    |
| `datePolicy`          | Policy ID/version, timezone label, and `valuesArePreformatted: true`                           | Caller supplies formatted dates. Existing OSCU/VSCU request schemas validate calendar values. The engine does not convert timezones.                                                         |

The engine also requires `KraSalesCalculationEvidence`: snapshot ID, matching
policy version, one ordered amount record per source line, explicit A–E tax
buckets, header totals, and payment-to-method-ID evidence. Monetary strings
are converted with the existing `kraDecimalToNumber` helper, which enforces
non-negative amounts, at most two decimal places, and the safe cent range. The
engine uses integer cents to validate that bucket amounts equal their lines,
bucket aggregates match header amounts, and header tax/total agree with the
immutable Zoho invoice. Quantity and unit price must match the source line at
supported precision. It does not calculate any tax, discounts, inclusive or
exclusive treatment, exemptions, or rounding. Calculation evidence must come
from a separately approved calculation source.

`KraSalesMappingContext` requires preformatted `cfmDt`, `salesDt`, and
`rcptPbctDt`, plus `invcNo`, `orgInvcNo`, trader invoice number, and allocation
reference; VSCU additionally requires `rptNo`. The mapper assigns `itemSeq`
from the stable snapshot line order starting at 1 and rejects more than 999
lines. VSCU uses the existing request schema's documented normal-sales value
`salesTyCd: "N"`; other transaction/document types are not mapped.

The result includes provider request data and mapping provenance: configuration
ID/digest, policy version, snapshot ID, and allocation reference. The digest is
SHA-256 over the strictly schema-validated configuration, with object keys
recursively sorted and array order preserved. It is an integrity identifier,
not a signature or evidence of KRA approval.

Application orchestration persists the digest alongside the adapter identity
in the existing `adapterConfigurationId` field. For mapped submissions, the
validated configuration is also placed in the existing encrypted submission
payload record, together with the exact request. That record is written in the
same repository transaction as the pending-to-in-progress claim, before the
adapter call. The vault verifies the archived configuration against both its
computed digest and the operation digest when historical configuration is
loaded. Existing authenticated encryption protects configuration values such
as OSCU communication keys. The existing 256 KiB payload limit applies to the
combined request and archive; an archive or encryption failure blocks the
operation before the adapter call.

No database migration is needed: the existing encrypted, operation- and
attempt-bound payload record is reused. The request loader unwraps the archive
so adapter and recovery interfaces continue to receive only the request.
Existing payload records remain readable. Operations created before this
archive format, including digest-only operations, cannot reconstruct their
full mapping configuration; their digest and exact encrypted wire request do
not contain unused mappings or all policy metadata. A different active
configuration cannot overwrite an existing operation archive, and orchestration
rejects a different digest for an existing operation. Mapping changes never
rewrite an immutable invoice snapshot.

## Application boundary and readiness

`FiscalizationOrchestrationService.submitMappedEtimsStage` loads the persisted
snapshot and calls the mapper before registering or submitting an eTIMS
operation. Mapping failures return `mapping_failed` with a stage and safe field
issues. OSCU/VSCU sales-write methods reject payloads that were not created by
the mapping engine. The concrete `KraEtimsReportingAdapter` checks its own
readiness and refuses writes while configuration, provider contract, or
operational gates are closed.

Structural mapping success is labeled
`structurally_valid_external_acceptance_unverified`. It does not establish
KRA enrollment, accepted codes, provider compatibility, or permission to
submit. Production gates remain closed.

## Synthetic examples and setup

This existing profile-shaped sample is synthetic and is not KRA-ready. It
contains no usable KRA code or production taxpayer detail:

```json
{
  "customer": {
    "zohoCustomerId": "synthetic-zoho-customer",
    "companyName": "Synthetic Customer Ltd",
    "clientPin": "SYNTHETIC-PIN",
    "headquarters": "Synthetic HQ",
    "address": "Synthetic address",
    "postalCodeAndCity": "00000 Synthetic City",
    "exemptionNumber": null
  },
  "item": {
    "zohoItemId": "synthetic-zoho-item",
    "measureUnit": "EA",
    "hsCode": "SYNTHETIC",
    "hsName": "Synthetic item",
    "vatClass": "?",
    "vatGroupRate": "0"
  }
}
```

Mapping tests use synthetic taxpayer/item/tax codes and counters solely to
exercise the request schema. No fabricated production mapping file is
provided. Operators manage current customer and item profiles through the
authenticated profile routes. Version 1 KRA configuration is supplied
programmatically to the mapping boundary; it is not silently loaded from
environment defaults.

## External confirmation still required

The taxpayer/KRA must confirm taxpayer and branch registration, item and tax
code applicability, payment method identifiers/codes, tax calculation and
rounding source, discounts and inclusive/exclusive treatment, date meaning and
timezone, allocation policy/counter scope, and OSCU/VSCU acceptance for the
taxpayer's installed version. Current payment snapshots retain payment labels;
stable source method IDs require accepted supplemental evidence. Local tests
cover deterministic mapping, encrypted archive and retrieval, digest
verification, restart reconstruction, legacy compatibility, and blocking an
oversized archive before the mocked adapter call. They use synthetic values
and do not prove Zoho tenant behavior, KRA code validity, sandbox acceptance,
enrollment, or production readiness.
