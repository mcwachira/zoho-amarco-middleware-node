# External acceptance and production checklist

This checklist separates evidence still required from work that can be done
with local mocks. Synthetic adapter responses are not vendor or regulator
acceptance.

For the on-site process, use the [customer access request checklist](customer-access-request-checklist.md)
and the offline [office acceptance runbook](customer-office-acceptance-runbook.md).

## Legal and business decision record

- Obtain written confirmation from the customer's Kenyan tax/legal adviser and
  relevant provider contacts for the required ordering between Tremol receipt
  issuance and VSCU/OSCU eTIMS submission.
- Confirm which sale, invoice, advance, credit, refund, and correction events
  require device fiscalization and/or eTIMS reporting.
- Approve treatment of unpaid, partially paid, credited, withheld, refunded,
  and reversed Zoho payments. Do not use invoice status alone as payment proof.
- Approve currency, decimal scale, rounding, discounts, inclusive/exclusive tax,
  exempt supplies, and line/tax reconciliation rules without embedding guessed
  Kenyan rates in this application.
- Until decisions are recorded and translated into versioned policies, keep
  `receiptIssuanceEnabled=false`, `ETIMS_REPORTING_ENABLED=false`, and the
  combined sequence policy absent.

## Zoho Books tenant acceptance

- Select the tenant's Zoho Accounts data center and API domain. Verify the
  registered OAuth redirect URI, scopes, organization ID, offline refresh
  behavior, token expiry, revocation, and re-consent procedures.
- Run read-only invoice and invoice-payment requests against a non-production
  or explicitly approved test organization. Save sanitized response fixtures
  for invoice detail, line tax/discount data, payment pages, partial payments,
  refunds, credits, and malformed/error responses.
- Verify actual pagination metadata and maximum page size for invoice payment
  history, plus handling of duplicates and concurrent ledger changes while a
  page scan is in progress.
- Confirm whether Books API payment records represent applied accounting
  entries or independently settled funds for the customer's payment workflow.
- For the read-only invoice intake test, grant only the
  `ZohoBooks.invoices.READ` scope required by the current client. Optional
  custom-field writeback additionally requires `ZohoBooks.invoices.UPDATE`, but
  request it only if writeback is separately included in the customer-approved
  scope and configured with that organization's custom-field IDs. Source
  support alone does not authorize invoice updates.
- Validate least-privilege scopes and token refresh limits against Zoho's
  current contract. Do not grant write permission for a read-only test.

## Tremol G03 / ZFP Lab Server acceptance

Use a designated test CU with vendor/customer approval. Do not test receipt
commands on a production CU.

- Record supported CU hardware revision, serial identity, firmware, Kenya
  protocol revision, ZFP Lab Server version, installed SDK/runtime, Windows
  version, and compatibility confirmation from Tremol or its authorized
  integrator.
- Confirm the supported server endpoint, authentication/access controls,
  transport security, command queue semantics, maximum request/response sizes,
  and permitted concurrent connections.
- Verify that the installed server emits the supplied named `Type="Status"`
  fields with `0`/`1` values and compare them with all six Kenya status bytes.
  The application maps only those source-defined fields when present; missing
  fields remain unknown and readiness is never inferred. Establish any
  readiness interpretation with the vendor.
- Verify command argument serialization and exact limits for invoice open,
  item sale, subtotal/discount, payment, close, cancellation, and correction.
  Resolve the documented signature discrepancies before implementing a sender.
- Verify operator identity/password behavior, payment-method mappings, CU
  receipt number and timestamp parsing, QR/signature fields, and expected
  behavior for each device result code.
- On a designated test CU, exercise timeout before command acceptance, timeout
  after command acceptance, lost close response, malformed response, CU busy,
  open receipt on restart, and electronic-journal/last-receipt reconciliation.
- Demonstrate that an uncertain receipt is found or confirmed absent using a
  vendor-supported read/reconciliation mechanism before any retry is permitted.
- Complete acceptance with `receiptIssuanceEnabled=false` in ordinary
  deployments until reviewed evidence and a separate release approval enable
  the verified implementation.

The local XML catalogue contains command definitions, not captured runtime
responses. Its examples and the simulator do not prove installed CU behavior.
See [Tremol protocol status](tremol-g03-kenya-protocol-status.md).

## KRA eTIMS acceptance

- Obtain the current official VSCU/OSCU integration specification and identify
  which model the taxpayer has enrolled for. Confirm the application is
  permitted to submit on that taxpayer's behalf.
- Obtain enrollment prerequisites, taxpayer/device identity rules, test vs
  production endpoints, network allowlists, authentication/certificate/key
  lifecycle, signing requirements, and token renewal behavior.
- Obtain official request/response schemas and examples for the supported
  invoice/document categories, customer/item identifiers, tax mapping, totals,
  discounts, and corrections.
- Confirm official meanings for duplicate responses (including any code such
  as `994`), rejection codes, accepted-but-pending results, throttling,
  idempotency keys, and correlation fields.
- Obtain a documented transaction lookup/reconciliation operation and its
  consistency window. Confirm how to resolve a timeout where the submission may
  have been accepted without blindly replaying it.
- Complete synthetic adapter contract tests first, then provider sandbox
  acceptance using approved taxpayer credentials and non-production fiscal
  records. Preserve sanitized, versioned fixtures.
- Keep `ETIMS_REPORTING_ENABLED=false` until application, legal, taxpayer
  enrollment, and provider acceptance gates are signed off.

See [eTIMS integration status](etims-integration-status.md).

## Database and operations acceptance

- Provision dedicated PostgreSQL test databases using the exact
  names and local connection constraints in [database-migrations.md](database-migrations.md).
- Verify the existing migration history before applying the new relational
  constraints. If the guarded migration finds orphan eTIMS rows, stop and
  review those rows; do not delete them to force migration success.
- Run provider integration tests for new schema, migrated schema, eTIMS and
  device attempts, concurrency, cleanup, stale recovery, and restart recovery.
- Agree retention, backup cadence, encryption-at-rest, restore test, database
  least-privilege grants, local firewall rules, and diagnostic access.
- In customer installation, bind the API to loopback by default; expose it
  through an approved TLS reverse proxy or local client boundary. Restrict the
  bearer token to trusted callers and rotate it through the customer's secret
  management process.
- Test graceful stop/start during pending Zoho retrieval and uncertain device
  or eTIMS work. Verify operators can locate request, attempt, and correlation
  identifiers without logging access tokens, raw tax payloads, or credentials.
