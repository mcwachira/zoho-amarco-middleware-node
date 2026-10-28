# KRA/eTIMS integration status

**Status: not configured; no KRA/eTIMS submission is performed.**

Separate direct OSCU and local VSCU protocol clients are now present. They are
not registered as operational reporting adapters; see
[KRA protocol clients](kra-protocol-clients.md) for routes, configuration,
error behavior, evidence, and remaining acceptance work. The application still
uses the fail-closed adapters and exposes protocol configuration diagnostics
without contacting KRA or the VSCU service.

Official KRA documents are now present in `docs/`:

- `VSCU_Specification_Document_v2.0.pdf`, revision 2.0 dated 20 April 2023.
- `OSCU_Specification_Document_v2.0.pdf`, revision 2.0 dated 20 April 2023.
- `Microsoft Word - OSCU_VSCU_Step-by-Step_Guide-V-1.1_22.04.2023-v4 - OSCU_VSCU_Step-by-Step_Guide-on-how-to-sign-up.pdf`.

The documents establish useful parts of both integration contracts, but do
not establish enough of the request transport, security, duplicate handling,
or this project's invoice-to-KRA mapping to safely submit records.

## Contract facts established by the supplied KRA documents

The project is an on-premises Windows deployment, so VSCU is the relevant
documented deployment model: the guide describes the VSCU package as deployed
on the taxpayer's side and gives a local service URL whose default port is 8088. The guide and VSCU specification describe separate test and production
configurations, require taxpayer approval, and describe initialization with
taxpayer PIN, branch ID, and device serial number. Initialization returns
taxpayer/branch/device data and device keys. No project configuration,
approved VSCU installation, or local VSCU runtime is currently established.

The VSCU specification documents:

- Sales submission path `/trnsSales/saveSales` (§3.3.6.1), with a JSON request
  contract and required top-level values for taxpayer/branch identity, trader
  and invoice numbers, sales/receipt/status codes, dates, item count, taxable
  amounts/rates/taxes, totals, and item rows.
- A response envelope containing `resultCd`, `resultMsg`, `resultDt`, and
  `data`; the example's `data` contains receipt counter, internal data,
  receipt signature, publication date, SDC ID, and MRC number.
- Result code `000` as “It is succeeded”. Code `994` is described as
  “overlapped Data”; other documented client/server error categories include
  `891`-`899`, `900`-`903`, `910`-`912`, `921`-`922`, and `990`-`999`.
- Enumerations for sales type, receipt type, payment method, and transaction
  progress (§§4.8-4.11), plus tax-type, item-classification, packaging, and
  quantity-unit code tables elsewhere in the specification.
- An ordering rule in §3.1: sales transaction information precedes sales
  invoice information. The document describes VSCU issuing receipt counters,
  receipt date, internal data, and signature data as part of the sales-invoice
  process.

The OSCU specification describes remote production/test API base addresses and
an OSCU integration library/process, but the project has no approved OSCU
service or library integration configured. The KRA step-by-step guide describes
taxpayer enrollment and service approval; it is not an API transport-security
specification.

## Why submission is still blocked

The request does not yet have a safe, fully verified path from this application's
immutable fiscalization record to VSCU:

- The provided VSCU documents identify endpoint paths and JSON shapes but do
  not establish the HTTP method, request content-type/header requirements, or
  local VSCU authentication requirements. They also do not define how the
  returned device keys are to be used by a client.
- The specification is dated 2023. The customer's installed VSCU release,
  configuration, and compatibility with this specification are unknown.
- The current immutable invoice snapshot does not contain all documented KRA
  fields, such as KRA item codes, packaging/quantity-unit codes, authoritative
  KRA tax-type mappings, complete transaction state, and verified payment
  evidence. Existing fiscal profiles do not establish those values.
- The current Tremol receipt result only stores receipt number and issue time.
  The available protocol evidence does not establish that the KRA VSCU sales
  submission should follow that Tremol receipt, nor does the existing record
  contain the VSCU receipt signature/internal data that VSCU itself generates.
- Code `994` indicates overlapping data but the specification does not define
  an idempotency key, duplicate-replay response contract, retention period, or
  lookup/reconciliation operation. A timeout therefore cannot safely be retried
  or interpreted as accepted.
- The examples and listed codes do not establish the customer's applicable tax
  treatment, item classification, rounding, credit/refund handling, or payment
  mapping. Those require taxpayer-specific KRA guidance and verified source
  data.

No eTIMS HTTP client or KRA request mapper is implemented. A provider-neutral
adapter boundary and durable submission-state persistence now exist, but the
production VSCU and OSCU adapters are explicitly non-operational. No network
submission or automatic retry is performed. This is deliberate: implementing a
plausible request or treating a success-shaped response as authoritative would
invent unsupported behavior.

## Implemented adapter and persistence foundation

- `EtimsReportingAdapter` separates the application service from provider
  transport and request serialization. Its status distinguishes configuration,
  verified contract, operational readiness, and reconciliation/resubmission
  capabilities.
- `UnverifiedEtimsAdapter` provides separate, explicit VSCU and OSCU
  descriptors. `ETIMS_ADAPTER` selects one model; there is no fallback. The
  selection does not imply customer enrollment or operational configuration.
- `ETIMS_REPORTING_ENABLED` defaults to `false`. The server also holds the
  verified receipt lifecycle gate closed. Selecting a model and setting the
  enable flag cannot make either production adapter operational.
- The durable operation is unique per fiscalization request and pins its
  adapter/model, configuration identity, correlation ID, and immutable payload
  SHA-256 hash. The original canonical JSON supplied to a verified adapter is
  persisted as versioned AES-256-GCM ciphertext, not plaintext, and is bound to
  the operation, fiscalization request, digest, and exact submission attempt.
  Credentials are not part of that payload-store contract.
- The state machine includes `not_configured`, `blocked`, `pending`,
  `in_progress`, `accepted`, `rejected`, `outcome_unknown`, and
  `reconciliation_required`, plus `reconciling` to claim one provider lookup at
  a time. Confirmed `accepted` and `rejected` are terminal.
  Only an explicit provider-confirmed rejection is `rejected`; exceptions and
  ambiguous results become `outcome_unknown`.
- A transactional compare-and-set claim changes only `pending` to
  `in_progress`, increments the attempt number, and creates the attempt record
  before an adapter is called. Completion updates the operation and attempt in
  one transaction and only while that same attempt remains in progress.
- A compare-and-set claim moves an uncertain operation to `reconciling` before
  any lookup, preventing concurrent workers from polling the same operation.
  A stale reconciliation claim returns to `reconciliation_required`; it never
  resubmits the invoice.
- `startEtimsReconciliationWorker` scans only `outcome_unknown` and
  `reconciliation_required` records whose `reconciliationRequired` flag is set
  and whose adapter is selected, operational, contract-verified, and declares
  reconciliation support. It recovers stale claims first, loads the exact
  immutable submission payload through an injected resolver, and calls only
  `EtimsReportingService.reconcile`. Provider `pending` and ambiguous responses
  remain `reconciliation_required` and create durable reconciliation attempts.
  Retries use exponential delay from 30 seconds up to 30 minutes and stop after
  the configured attempt limit. The worker never calls `submit`.
- Submission claims and encrypted payload persistence are atomic in both
  supported database repositories. Payload resolution verifies the GCM tag,
  UTF-8, payload version, operation/request/attempt association, and digest.
  Missing, corrupt, or incompatible payloads fail closed. Existing operations
  created before this migration have no payload row and remain blocked; never
  reconstruct one from a digest.
- The server registers the existing scheduler with graceful shutdown and
  operator-visible health. It starts only when reconciliation is explicitly
  enabled, reporting is enabled, secret-backed payload protection is
  configured, and the selected adapter is operational and contract-verified.
  The current `UnverifiedEtimsAdapter` advertises no operational reconciliation
  capability, so current server startup does not start polling or make KRA
  requests. `/health/integrations` reports this separately from provider health.
- Payload rows are retained with restrictive foreign keys; no automatic
  redaction or deletion is performed. Key rotation and retention require an
  approved deployment procedure. AES-GCM protection is injectable, but the
  default deployment mechanism is a secret-manager-injected environment key; a
  managed KMS integration is not present.
- A crashed stale `in_progress` operation can be recovered as
  `outcome_unknown`; it is never resent automatically. Reconciliation is
  capability-gated. Only an adapter explicitly declaring safe resubmission
  after a confirmed-not-found result may return the operation to `pending`, and
  that transition does not itself submit again.
- The authenticated fiscalization status route exposes eTIMS status separately
  from Tremol status, including adapter, attempt count, and reconciliation
  requirement. Neither direction of success is inferred from the other.
- PostgreSQL have separate operation/attempt tables, unique
  indexes, and conditional state transitions. The migrations are additive and
  do not alter existing fiscalization records.

These are application-level foundations, not a functioning KRA integration.
The server has a gated scheduler lifecycle and encrypted payload persistence,
but no operational adapter or verified KRA reconciliation contract. The
authenticated endpoint and scheduler therefore do not perform live KRA queries.

## Application status boundary

The authenticated fiscalization-request status route reports a durable eTIMS
operation state, when one exists, separately from the Tremol fiscalization
status; otherwise it reports configured readiness. With the current default
settings, eTIMS is `not_configured`. A Tremol success is not KRA acceptance,
and a future VSCU/OSCU success must not be treated as proof that Tremol issued
a receipt.

The default status and static blocker list are defined in
`src/domain/fiscalization/etims-reporting-status.ts`; runtime blockers are
reported by the service. No network call is made by the status endpoint. Tests
use synthetic records and injected adapters only; they do not contact
KRA/eTIMS, live Zoho, or a physical device. Schema validation does not apply
the migrations or verify concurrency against live PostgreSQL
instances.

## Validation executed

The latest local regression run completed with `pnpm test`: 58 test files
passed, 5 were skipped; 707 tests passed and 20 were skipped. The skipped files
are the opt-in PostgreSQL fiscalization, OAuth attempt/token, fresh migration,
and PostgreSQL integration suite. The environment had no explicit test-database
configuration and PostgreSQL on port 5438 did not respond; no migrations or
database runtime assertions were run.

`pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm format:check`,
`pnpm build`, `pnpm db:validate`, `pnpm openapi:lint`, and `git diff --check`
passed. `pnpm audit:deps` still fails on the high-severity
dependency audit findings described in the dependency security guide. No separate
OpenAPI conformance script is configured; Redocly lint validated the OpenAPI
document. No live Zoho, KRA/eTIMS, or Tremol integration was exercised.

## Required evidence before implementing submission

Obtain customer/KRA evidence that resolves:

1. The applicable current KRA integration version and the customer's
   explicitly approved model (VSCU or OSCU), installed runtime and environment.
   The models must not be used as automatic alternatives.
2. The supported HTTP verb, content type, required headers, and authentication
   and security requirements for initialization and sales submission.
3. Exact initialization and submission schemas for the installed version,
   including validation and the meaning of returned receipt identifiers and
   signatures.
4. Taxpayer approval/enrollment and test/production activation, plus secure
   provisioning and rotation for taxpayer PIN, branch, device serial, and any
   returned device keys.
5. The required lifecycle and exact legal relationship, if any, between
   Tremol-issued receipt information and VSCU/OSCU submission; identify which
   system is authoritative for legal issuance and what data must be retained.
6. Written mapping/business rules for invoice fields, tax treatment, item
   classification, units, trusted payment evidence, credit/refund, dates, and
   rounding.
7. Required transaction sequencing, including whether/how a sales transaction
   must precede the sales-invoice record for this taxpayer and model.
8. Idempotency, duplicate detection (including code `994`), retryable results,
   rate limits, and an authoritative reconciliation/lookup process after
   timeout or process interruption.
9. Sanitized accepted, rejected, duplicate, malformed, and ambiguous-response
   examples for the installed version.

Until then, do not submit invoices, automatically retry uncertain requests, or
infer payment evidence, tax treatment, fiscal success, or KRA acceptance.

## Typed reference client status

The standalone OSCU and VSCU clients now validate initialization and the
documented incremental read request fields, and validate code, classification,
branch, and item list data before returning accepted results. These checks are
local protocol-boundary validation only. There is no durable reference-data
sync table or worker; the KRA cursor-advance and full-snapshot-versus-delta
semantics need confirmation before data can be made active. The health report
separates valid local configuration from untested transport, local contract
test coverage, sandbox verification, and provider approval. The latter two
remain false, as do reconciliation verification and live permission.
