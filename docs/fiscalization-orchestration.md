# Fiscalization orchestration

The application exposes separate device and eTIMS stages through
`FiscalizationOrchestrationService`. `executeMapped` validates and maps the
persisted immutable snapshot before either external stage, then follows the
explicit policy order and stops when the first stage does not meet its
continuation rule. The production server supplies no sequence policy because
the order has not been verified. The environment-gated local simulation has a
separate explicitly marked sequence policy and cannot be enabled in production.

The stages remain independently observable:

- `prepareInvoice` retrieves invoice and payment evidence, validates fiscal
  profiles, builds the immutable snapshot, and registers a Pending request.
- `processDeviceStage` delegates to `FiscalizationService`. Device readiness is
  checked before the atomic claim; a failed preflight leaves the request Pending.
- `submitEtimsStage` registers one immutable eTIMS operation for the request and
  delegates submission to `EtimsReportingService`. An existing operation is
  reused, and its state machine blocks resubmission while the result is
  uncertain or terminal.
- `reconcileEtimsStage` delegates to the provider reconciliation capability.
  It records reconciliation attempts separately from submission attempts.
- `getStatus` returns the device request and attempt history separately from
  the eTIMS operation and its attempt history.

Device state transitions are `Pending -> InProgress -> Succeeded | Failed |
OutcomeUnknown`. Each device request can be claimed once; no automatic retry
transition exists. eTIMS submission and reconciliation have separate attempt
counters and attempt types under the same stable operation ID. A confirmed
provider `accepted` result remains an eTIMS result and does not create or imply
a fiscal receipt.

After a device request is claimed, the stored snapshot is parsed and checked
again against the pre-claim snapshot before the device boundary is invoked. If
that claimed value is malformed, fails its integrity check, or differs from
the validated snapshot, the service now persists `Failed` with
`INVALID_CLAIMED_SNAPSHOT` and completes the attempt as failed. This is a
definitive pre-send failure: the device has not been called. If persisting
that result fails, the service reports a persistence error and leaves recovery
to the existing stale-claim process. The regression test corrupts the claimed
snapshot in a synthetic repository and asserts durable failure plus zero
simulator calls; it does not establish database-engine behavior.

Database transactions cover only state claims, attempt creation, outcome
updates, and stale recovery. Device or provider calls occur after a claim
transaction commits. Stale in-progress work becomes uncertain; recovery never
replays a device operation or eTIMS submission.

The additive migration `20261027170000_add_fiscalization_attempts` adds device
attempt history and eTIMS reconciliation attempt history to PostgreSQL. The later `20261027180000_add_etims_relational_constraints`
migration adds request-to-operation and operation-to-attempt foreign keys. It
checks for orphan rows and fails before applying constraints if any are found;
operators must review existing rows rather than delete them. PostgreSQL uses
`ON DELETE RESTRICT`.

## KRA reporting adapter wiring

The production server now constructs the direct protocol clients behind
`KraEtimsReportingAdapter` when their own configuration is present:

- `ETIMS_ADAPTER=oscu` selects only OSCU for an operation, with
  `ETIMS_OSCU_ENVIRONMENT=sandbox|production` selecting its pinned KRA origin.
- `ETIMS_ADAPTER=vscu` selects only VSCU, with `ETIMS_VSCU_BASE_URL` pointing to
  the separately installed local service.
- `ETIMS_PROVIDER_TIMEOUT_MS` bounds each client request. There is no fallback
  from one provider to the other.

These settings identify and construct a client; they do not activate it. The
server's concrete adapters report `contractVerified=false` and
`operational=false`, regardless of `ETIMS_REPORTING_ENABLED`. The reporting
service persists the operation as blocked and does not call the client. The
combined workflow and Tremol issuance gates are independent and remain closed.
The test suite uses a test-only readiness wrapper with mocked `fetch` to prove
that the selected adapter routes through the actual reporting service, payload
vault, durable claim, and outcome repository. That wrapper is not part of the
runtime assembly and its synthetic responses do not prove KRA compatibility.

Once contract activation is separately approved, the adapter validates the
supplied KRA sales request before the durable claim. A well-formed KRA
rejection maps to `rejected` with its result code retained; provider text is not
copied into the error response. A valid documented success maps its generated
receipt number into `providerReference` and stores bounded safe metadata. A
transport error, HTTP error, or malformed response after the request may have
reached KRA maps to `outcome_unknown`; the service does not resubmit terminal
or uncertain operations. Errors proven to occur before transmission are
recorded as blocked. An optional abort signal can flow through the application
service: cancellation before the durable claim leaves the operation pending;
cancellation after transmission may have begun is uncertain. The provider has
no verified reconciliation lookup in
this implementation, so uncertain operations require manual review. No
submission, duplicate, or reconciliation behavior is provider-verified.

The reporting service still receives a complete explicit KRA wire payload;
this adapter does not map Zoho snapshots or profiles into tax, item, payment,
receipt, or taxpayer fields. That mapping gap, official request/response
example discrepancies, enrollment, sandbox acceptance, legal lifecycle, and
provider reconciliation support remain prerequisites before the server can
report accepted operational readiness.

Production issuance remains unavailable: simulation configuration is rejected
in production, no production device is injected, the Tremol adapter defaults
`receiptIssuanceEnabled` to false, the KRA adapter is contract-unverified and
non-operational, and the combined production sequence policy remains absent.
These tests do not establish physical device or KRA behavior.

## Local simulated vertical workflow

The workflow uses the normal request, mapping, orchestration, payload-vault,
repository, and status paths, with deterministic local implementations at both
fiscal boundaries. The ETIMS simulator writes no provider reference and marks
its response `simulated=true`; the device uses a `SIM-` receipt number. Neither
is fiscal evidence. Simulation mode is rejected when `NODE_ENV=production`.

### Local services and configuration

Required: Node.js 24 or newer, pnpm 12.14 as declared in `package.json`,
Docker Compose with the repository's PostgreSQL service, and `jq` for the
copyable response-parsing commands below. Starting the server with the real
Zoho intake route also requires a Zoho OAuth client and an existing invoice in
the configured organization. The automated HTTP test injects a Zoho Books test
double and makes no Zoho, KRA, or device calls.

1. Copy `.env.example` to `.env`. Keep `DATABASE_PROVIDER=postgresql` and
   configure `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and a matching
   `DATABASE_URL` for the local database on `localhost:5438`.
2. Configure distinct `INVOICE_API_BEARER_TOKEN` and
   `OPERATOR_API_BEARER_TOKEN` values. The former can create and read requests;
   the latter can execute stages and manage profiles.
3. Set `NODE_ENV=development`, `FISCALIZATION_SIMULATION_ENABLED=true`,
   `ETIMS_REPORTING_ENABLED=false`, and `ETIMS_RECONCILIATION_ENABLED=false`.
   Set `ETIMS_PAYLOAD_ENCRYPTION_KEY` to a locally generated 64-character
   hexadecimal key (`openssl rand -hex 32`). Do not use a production secret.
4. For HTTP intake, configure the Zoho credentials, organization ID, OAuth
   encryption key, and redirect URI from `.env.example`. Obtain a Zoho
   authorization through the existing `/integrations/zoho/authorize` and
   callback flow. No KRA credential or Tremol service is required in
   simulation mode.
5. Start and migrate the dedicated development database, then start the API:

   ```sh
   docker compose up -d postgres
   pnpm exec prisma migrate deploy --schema prisma/postgresql/schema.prisma
   pnpm dev
   ```

   Migrations are not applied automatically by the application. The Compose
   service uses the configured `POSTGRES_DB`; do not point these commands at a
   production or populated migration-test database.

6. Before intake, create profiles for the invoice's exact Zoho customer and
   item IDs using the existing `/integrations/zoho/fiscal-customer-profiles`
   and `/integrations/zoho/fiscal-item-profiles` routes with the operator
   token. Their request fields are documented in the README profile examples.
   These profile values and the later KRA-shaped mapping sample must be treated
   as synthetic for simulation; they do not establish tax correctness.

   The route bodies are strict; replace these placeholders with the profile
   values you intend to exercise:

   ```sh
   BASE=http://127.0.0.1:3000
   OPERATOR_TOKEN='<OPERATOR_API_BEARER_TOKEN>'

   curl -sS -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H 'Content-Type: application/json' \
     --data '{"zohoCustomerId":"<ZOHO_CUSTOMER_ID>","companyName":"Local simulation customer","clientPin":"<CUSTOMER_PIN_OR_TEST_VALUE>","headquarters":"Nairobi","address":"Local test address","postalCodeAndCity":"00100 Nairobi","exemptionNumber":null}' \
     "$BASE/integrations/zoho/fiscal-customer-profiles"

   curl -sS -X POST -H "Authorization: Bearer $OPERATOR_TOKEN" \
     -H 'Content-Type: application/json' \
     --data '{"zohoItemId":"<ZOHO_ITEM_ID>","measureUnit":"EA","hsCode":"<LOCAL_TEST_VALUE>","hsName":"Local test item","vatClass":"A","vatGroupRate":"16"}' \
     "$BASE/integrations/zoho/fiscal-item-profiles"
   ```

### HTTP sequence

The supported intake contract takes a Zoho invoice ID in the path and fetches
that invoice through the configured Zoho Books client. It does not accept an
arbitrary invoice JSON body. Use the service token for intake and status, and
the operator token for execution:

```sh
BASE=http://127.0.0.1:3000
SERVICE_TOKEN='<INVOICE_API_BEARER_TOKEN>'
OPERATOR_TOKEN='<OPERATOR_API_BEARER_TOKEN>'
INVOICE_ID='<EXISTING_ZOHO_INVOICE_ID>'

curl -sS -X POST \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$BASE/integrations/zoho/invoices/$INVOICE_ID/fiscalization-requests"
```

New intake returns `201` with `alreadyExisted: false` and contains `request.id`,
`request.status` (`Pending`), and `request.snapshotId`. The non-sensitive
SHA-256 snapshot ID is required to bind calculation evidence to the exact
persisted invoice. Repeating intake returns `200` with `alreadyExisted: true`
and the existing request identifier/status; it does not refetch Zoho or create
another request, replace its snapshot, create an eTIMS operation, or execute
fiscalization. A concurrent create is arbitrated by the database uniqueness
constraint; the caller then reads and returns the winner's request.

The execute route requires the strict top-level JSON fields
`configuration`, `context`, and `calculationEvidence`. This minimal synthetic
example is shaped from the current local schema and its test fixture: one KES
invoice line with 100 taxable amount, 16 tax, and 116 total, one item and one
tax mapping, no payment evidence. Replace all synthetic IDs with the matching
invoice snapshot IDs, and use an appropriate calculation evidence source. Do
not reuse the illustrative taxpayer, item, tax, sequence, or date values as
real KRA values.

```sh
SNAPSHOT_ID='<request.snapshotId from intake>'
REQUEST_ID='<request.id from intake>'
cat > execute-request.json <<JSON
{
  "configuration": {
    "schemaVersion": 1,
    "configurationId": "local-simulation-v1",
    "policyVersion": "local-simulation-policy-v1",
    "provider": "vscu",
    "taxpayer": {
      "tin": "SYNTHETIC01",
      "bhfId": "ZZ",
      "regrId": "local-test",
      "regrNm": "Local simulation",
      "modrId": "local-test",
      "modrNm": "Local simulation"
    },
    "document": {
      "rcptTyCd": "SYN",
      "salesSttsCd": "SYN",
      "prchrAcptcYn": "N",
      "mapCustomerPin": false,
      "paymentRequired": false
    },
    "sequencePolicy": {
      "policyId": "local-test-allocator",
      "version": "v1",
      "externalAllocationRequired": true
    },
    "datePolicy": {
      "policyId": "local-preformatted-dates",
      "version": "v1",
      "timeZone": "Etc/UTC",
      "valuesArePreformatted": true
    },
    "itemMappings": [
      {
        "sourceItemId": "<ZOHO_ITEM_ID>",
        "itemClsCd": "SYNCLS",
        "itemCd": "SYNITEM",
        "itemNm": "Synthetic item",
        "pkgUnitCd": "SYN",
        "qtyUnitCd": "SYN",
        "bcd": null,
        "isrccCd": null,
        "isrccNm": null,
        "isrcRt": null
      }
    ],
    "taxMappings": [
      { "sourceTaxId": "<ZOHO_TAX_ID>", "taxTyCd": "SYN", "bucket": "A", "rate": "16" }
    ],
    "paymentMappings": []
  },
  "context": {
    "traderInvoiceNumber": "LOCAL-SIM-1",
    "cfmDt": "20261027123456",
    "salesDt": "20261027",
    "rcptPbctDt": "20261027123456",
    "invcNo": 1,
    "orgInvcNo": 0,
    "rptNo": 1,
    "allocationReference": "LOCAL-ONLY-1"
  },
  "calculationEvidence": {
    "snapshotId": "$SNAPSHOT_ID",
    "policyVersion": "local-simulation-policy-v1",
    "lines": [
      {
        "sourceLineId": "<ZOHO_INVOICE_LINE_ID>",
        "pkg": "1",
        "qty": "1",
        "prc": "100",
        "splyAmt": "100",
        "dcRt": "0",
        "dcAmt": "0",
        "taxblAmt": "100",
        "totTaxAmt": "16",
        "totAmt": "116"
      }
    ],
    "payments": [],
    "buckets": {
      "A": { "taxblAmt": "100", "taxRt": "16", "taxAmt": "16" },
      "B": { "taxblAmt": "0", "taxRt": "0", "taxAmt": "0" },
      "C": { "taxblAmt": "0", "taxRt": "0", "taxAmt": "0" },
      "D": { "taxblAmt": "0", "taxRt": "0", "taxAmt": "0" },
      "E": { "taxblAmt": "0", "taxRt": "0", "taxAmt": "0" }
    },
    "totTaxblAmt": "100",
    "totTaxAmt": "16",
    "totAmt": "116"
  }
}
JSON

curl -sS -X POST \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @execute-request.json \
  "$BASE/integrations/zoho/fiscalization-requests/$REQUEST_ID/execute"

curl -sS \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  "$BASE/integrations/zoho/fiscalization-requests/$REQUEST_ID" | jq
```

On the default success scenario, execution returns `200`,
`state: "completed"`, `simulated: true`, a succeeded device stage, and an
accepted simulated eTIMS stage. Status retrieval reports
`processingOutcome.state: "simulated_success"`, `deviceSimulated: true`, a
`SIM-` receipt number, `integrations.etims: "accepted"`, and
`integrations.etimsSimulated: true`. The encrypted eTIMS submission payload
and both stage histories are retained through the configured repositories.

### Deterministic scenarios and errors

Select these values in `.env` before starting the app; scenarios are fixed at
process startup, not randomized per request:

| Setting                                   | Values                                                                     | Expected durable behavior                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FISCALIZATION_SIMULATED_DEVICE_SCENARIO` | `success`, `failure`, `timeout`, `uncertain`, `exception`, `unavailable`   | `success` returns a `SIM-` receipt; `failure` is definitive; timeout/uncertain/exception become `OutcomeUnknown`; unavailable fails readiness before claim. |
| `FISCALIZATION_SIMULATED_ETIMS_SCENARIO`  | `accepted`, `rejected`, `timeout`, `uncertain`, `exception`, `unavailable` | Accepted/rejected are explicitly simulated; timeout/uncertain/exception remain unknown; unavailable is blocked before submission.                           |
| `FISCALIZATION_SIMULATED_SEQUENCE`        | `device_then_etims`, `etims_then_device`                                   | Runs only this explicit local simulation order. Production receives no sequence policy.                                                                     |

To exercise partial success, set the first stage to succeed and the second to
fail for the selected sequence. To exercise recovery, leave a first stage
confirmed and rerun the same request; the confirmed stage is reused, not
replayed. Unknown or in-progress outcomes stay blocked and require review.
Relevant safe errors include `401 UNAUTHORIZED`, `403 FORBIDDEN`,
`400 INVALID_FISCALIZATION_WORKFLOW_INPUT`, `409` for duplicate or blocked
requests or a mapping-configuration conflict, `422 FISCALIZATION_MAPPING_FAILED`,
`503 FISCAL_DEVICE_NOT_READY`, and `202` when a stage was attempted but the
overall workflow remains blocked.

The API logger records request ID, stage start, simulated marker, stage result,
and blocker codes. It does not log invoice bodies, mapping payloads, bearer
tokens, encryption keys, or database URLs. Check the final status endpoint and
these safe log fields to diagnose a request; never resubmit an uncertain
operation.

Run the application/API workflow test and deterministic simulator tests with:

```sh
pnpm exec vitest run tests/unit/fiscalization-workflow.test.ts tests/unit/simulated-etims-adapter.test.ts
```

That HTTP test uses the real Express app factory and routes with an injected
Zoho Books test double and in-memory repositories. It verifies intake,
authentication, duplicate prevention, mapping errors, execution, and status.
It does not establish database-engine durability or SQL concurrency. The
PostgreSQL integration suites use separate explicit test database
flags and URLs described in `database-migrations.md`.

Common setup checks: `NODE_ENV=production` rejects simulation;
`ETIMS_PAYLOAD_ENCRYPTION_KEY` is required for simulation; intake returns 503
if Zoho preparation is not configured; intake returns 422 if the invoice or
profiles fail validation; mapping returns 422 if IDs/evidence/configuration do
not match the persisted snapshot; missing sequence or archive preflight blocks
before adapters; an unresolvable duplicate-create race returns `409
FISCALIZATION_REQUEST_CONFLICT`. `GET /health/integrations`
reports `device.receiptIssuance: "simulation_only"` and
`etims.simulated: true`; neither means production is enabled.
