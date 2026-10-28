# Developer handover and customer acceptance guide

This guide is the entry point for a developer preparing the current middleware
for a controlled customer installation. The detailed source of truth remains
the linked implementation and operations documents; this guide collects the
setup sequence, Windows visit checklist, acceptance order, and release limits.

## Quick start for a visiting developer

1. Review the [current implementation inventory](implementation-inventory.md),
   [integration contract evidence](integration-contract-evidence.md), and
   [operations and deployment guide](operations-and-deployment.md).
2. Obtain the approvals and least-privilege access in the
   [customer access request checklist](customer-access-request-checklist.md).
3. Print or save the offline [customer office acceptance runbook](customer-office-acceptance-runbook.md),
   which contains stop/go phases, troubleshooting paths, an evidence worksheet,
   the role-by-role customer interview, and the acceptance matrix.
4. Verify the target Windows host, application environment, and ZohoAmarco
   PostgreSQL database with their owners before running any command. The
   middleware database is separate from the customer's Syspro database; the
   application has no Syspro connector.
5. Keep fiscal and eTIMS mutations stopped. Local tests do not establish
   LabServer compatibility, device readiness, or legal acceptance.

## 1. What is implemented

ZohoAmarco is a Node.js/TypeScript Express service that reads Zoho Books
invoices, stores an immutable fiscalization snapshot, and tracks work in a
database. PostgreSQL is the middleware persistence provider. Device and eTIMS processing have separate durable statuses and
attempt histories. The intended fiscalization sequence is not selected in
production because its legal/provider ordering is not verified.

The main boundaries are:

| Area                                                   | Responsibility                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/` and `src/app.ts`                         | Health, OAuth, invoice, profile, workflow, reconciliation, and writeback HTTP routes; authentication, rate limits, and sanitized request logging.                   |
| `src/application/zoho/`                                | OAuth lifecycle, invoice mapping/import, synchronization, and gated result writeback.                                                                               |
| `src/application/fiscalization/`                       | Immutable request preparation, state transitions, orchestration policy, device/eTIMS attempts, stale recovery, encrypted eTIMS payload handling, and manual review. |
| `src/domain/fiscalization/`                            | Fiscalization records, states, safe transitions, and outcome models.                                                                                                |
| `src/integrations/zoho/` and `src/integrations/etims/` | Provider HTTP clients and contract parsing.                                                                                                                         |
| `src/infrastructure/database/` and `prisma/`           | PostgreSQL repositories, schema, and migrations.                                                                                                                    |
| `src/infrastructure/device/`                           | Tremol ZFP LabServer transport/client, disabled fiscal adapter, and test-only simulator.                                                                            |
| `src/server.ts`                                        | Configuration, dependency construction, workers, HTTP listener, and graceful shutdown.                                                                              |

```mermaid
sequenceDiagram
    participant U as Authorized caller/operator
    participant A as ZohoAmarco API/application
    participant Z as Zoho Books
    participant D as ZohoAmarco PostgreSQL
    participant T as Tremol G03 via ZFP LabServer
    participant K as KRA eTIMS
    U->>A: Read approved invoice / request fiscal candidate
    A->>Z: OAuth-protected invoice GET (payment GET when preparation requires it)
    Z-->>A: Provider response
    A->>A: Validate response, map supported fields, validate candidate
    U->>A: Register approved fiscalization request
    A->>D: Persist immutable snapshot; unique org/invoice registration
    U->>A: Process request
    A->>D: Atomic claim and durable attempt
    A-->>U: Current production policy blocks execution before fiscal mutation
    Note over A,T: Read-only adapter is separate; GET /health/device probes ReadVersion only when explicitly configured/approved
    Note over A,K: eTIMS adapter is non-operational; combined sequence is unverified and blocked
    U->>A: Review status / submit evidence-backed manual review
    A->>D: Append decision separately from provider outcome
    A-->>Z: Optional custom-field writeback only after validated authoritative real success and explicit operator permission
```

**Current production boundary:** the HTTP Tremol adapter is read-only and
allows only `ReadStatus()`, `ReadVersion()`, `ReadCurrentReceiptInfo()`, and
`ReadLastAndTotalReceiptNum()`. It is not a fiscal receipt sender. The
production server does not inject a receipt issuer, production eTIMS reporting
is rejected by startup validation, and no combined sequence policy is
configured. Simulation is explicit, deterministic, prohibited in production,
and always marked simulated; it cannot be used as receipt evidence.

The request record is unique by Zoho organization and invoice. Database claims
arbitrate concurrent execution. A timeout after a provider may have received a
request is `OutcomeUnknown`; neither device nor eTIMS submissions are blindly
retried. Stale recovery records uncertainty, while manual-review decisions are
separate, append-only audit records. Zoho result writeback requires a validated
authoritative non-simulated success and its own persisted operation. See
[orchestration details](fiscalization-orchestration.md),
[implementation inventory](implementation-inventory.md), and
[evidence register](integration-contract-evidence.md).

### Invoice lifecycle and code trace

The table follows the implemented boundaries. “Stage exists” does not mean
the external call is enabled or accepted. Default local unit tests use
synthetic responses.

| Stage                           | Source responsibility                                                                                                                                                         | Related tests                                                                                                                                                    | Failure evidence and current limit                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Organization and OAuth       | `src/config/env.ts`, `src/server.ts`, `src/application/zoho/zoho-oauth-service.ts`, `src/integrations/zoho/authorization-url.ts`, `accounts-domain.ts`, `api-domain.ts`       | `tests/unit/zoho-oauth-service.test.ts`, `zoho-oauth-routes.test.ts`, `zoho-authorization-url.test.ts`, `zoho-api-domain.test.ts`, `zoho-token-exchange.test.ts` | Record organization alias, Accounts/API hostnames, scope names and safe error category. Live tenant authorization is unverified.                                                                                                                      |
| 2. Invoice/payment retrieval    | `src/integrations/zoho/books-client.ts`, `src/application/zoho/zoho-invoice-service.ts`, routes in `src/routes/zoho-books-routes.ts`                                          | `tests/unit/zoho-books-client.test.ts`, `zoho-invoice-service.test.ts`, `zoho-books-routes.test.ts`                                                              | Client validates IDs/responses, preserves decimal lexemes, applies bounded GET retry/cancel behavior, and sanitizes errors. A previous written report says invoice GET returned 404; primary response evidence is not retained, and cause is unknown. |
| 3. Invoice mapping              | `src/application/zoho/zoho-invoice-mapper.ts`                                                                                                                                 | `tests/unit/zoho-invoice-mapper.test.ts`                                                                                                                         | Mapping returns validation issues for unsupported/missing fiscal fields; record field names and expected policy, not full invoice payload.                                                                                                            |
| 4. Fiscal candidate preparation | `src/application/fiscalization/prepare-fiscalization-request.ts`, `fiscalization-snapshot.ts`, `src/domain/fiscalization/fiscalization-snapshot.ts`                           | `tests/unit/prepare-fiscalization-request.test.ts`, `fiscalization-snapshot.test.ts`, `payment-evidence.test.ts`                                                 | Snapshot validates source identity/payment evidence and stores an immutable, sanitized representation/digest; it must not silently infer tax or payment rules.                                                                                        |
| 5. Idempotent registration      | `src/application/fiscalization/register-fiscalization-request.ts`, `src/infrastructure/database/postgresql-fiscalization-repository.ts`, `prisma/postgresql/schema.prisma`    | `tests/unit/register-fiscalization-request.test.ts`, `postgresql-fiscalization-repository.test.ts`; guarded PG integration suite                                 | Unique organization/invoice identity returns an existing request rather than creating duplicate work. Record request ID and sanitized DB error category.                                                                                              |
| 6. Claim and device state       | `src/application/fiscalization/fiscalization-service.ts`, `src/domain/fiscalization/status-transitions.ts`, PostgreSQL repository                                             | `tests/unit/fiscalization-service.test.ts`, `status-transitions.test.ts`, `fiscalization-workflow.test.ts`                                                       | Atomic claim and attempt history protect concurrent processing. A status conflict is not permission to create a second request.                                                                                                                       |
| 7. Sequence policy              | `src/application/fiscalization/fiscalization-orchestration-service.ts`, wired in `src/server.ts`                                                                              | `tests/unit/fiscalization-workflow.test.ts`                                                                                                                      | Current production policy returns blocked because legal/provider ordering is unverified. Do not infer device-first or eTIMS-first.                                                                                                                    |
| 8. Device/eTIMS stages          | `src/infrastructure/device/tremol-zfplabserver-client.ts`, `tremol-fiscal-device.ts`; `src/application/fiscalization/etims-reporting-service.ts`; `src/integrations/etims/`   | Tremol client/device tests; `tests/unit/kra-protocol-clients.test.ts`, `etims-reporting.test.ts`                                                                 | Production receipt sender is blocked; KRA adapter is non-operational. Mocks establish fixture handling only. Capture installed versions/contracts before any implementation.                                                                          |
| 9. Unknown outcomes and review  | `src/application/fiscalization/recover-stale-fiscalizations.ts`, `stale-fiscalization-recovery-worker.ts`, `manual-review-service.ts`; PostgreSQL attempt/review repositories | `tests/unit/recover-stale-fiscalizations.test.ts`, `stale-fiscalization-recovery-worker.test.ts`, `manual-review.test.ts`, `fiscalization-history.test.ts`       | A timeout after a possible write is `OutcomeUnknown`; recovery preserves uncertainty. Operator notes/attestation are not provider verification. Never blindly retry.                                                                                  |
| 10. Optional Zoho writeback     | `src/application/zoho/zoho-fiscalization-writeback-service.ts`, config/repository and `books-client.ts`; gated route in `src/routes/zoho-books-routes.ts`                     | `tests/unit/zoho-fiscalization-writeback.test.ts`, `zoho-books-client.test.ts`, `zoho-books-routes.test.ts`                                                      | Requires explicit custom-field mapping, operator `invoice:writeback` permission and persisted authoritative non-simulated device/eTIMS success. Code support is not customer authorization; no live writeback is verified.                            |

### Evidence levels

| Level                                    | What it can establish                                                                        | What it cannot establish                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Source and static inspection             | Current code paths, guards, serialization and documentation contracts.                       | Runtime response from Zoho, LabServer, CU, KRA or customer acceptance.                           |
| Unit tests with mocks/fixtures           | Application behavior for the test inputs and expected failures.                              | Live provider compatibility, actual firmware behavior, taxpayer enrollment, or receipt issuance. |
| Local PostgreSQL integration             | Repository behavior and migration state on the named local test target.                      | Production backup/restore, customer DB permissions or customer data migration.                   |
| Authorized live read-only provider check | That specific account/request returned the observed response at that time.                   | General tenant correctness, mutation permission, device readiness or fiscal success.             |
| Physical device acceptance               | Only the exact installed version, command, transport, unit and conditions actually recorded. | Other commands/firmware, legal workflow, or KRA acceptance.                                      |
| Authorized fiscal/regulatory acceptance  | The specific approved test transaction and records reconciled by responsible parties.        | Unperformed cases or production-wide compliance beyond written acceptance.                       |

## 2. Workstation setup

### Step 1 — Verify the checkout and preserve existing work

Run these read-only commands from the repository root in PowerShell before
installing, formatting, generating clients, or editing anything:

```powershell
Get-Location
git branch --show-current
git rev-parse HEAD
git status --short --branch
git diff --stat
git diff --cached --stat
```

The expected branch for this handover is `dev`; if it differs, stop and ask the
repository owner rather than switching branches. In short status output, the
first status column represents staged/index changes and the second represents
unstaged working-tree changes; `??` marks untracked files. Diff-stat commands
show staged and unstaged tracked edits, while untracked files appear only in
`git status`. Do not clean, reset, stash, or delete these files. Record that
the checkout was already modified; an untracked file can also contain user
work.

### Step 2 — Verify toolchain and install locked dependencies

- Node.js **24 or newer**, as required by `package.json`.
- pnpm **12.14.0**, pinned by `packageManager` and `devEngines`.
- Git and an editor.
- Docker Desktop with Docker Compose for the repository's local PostgreSQL
  service (`postgres:18` in `compose.yaml`). A local PostgreSQL client is
  useful for inspection but is not needed for unit tests.

Check the installed tools and install locked dependencies:

```powershell
node --version
pnpm --version
git --version
docker --version
docker compose version
pnpm install --frozen-lockfile
```

The pnpm version should report `12.14.0`; Node must report major version 24 or
newer. Install both through the organization's approved software distribution
process. `package.json` is the version source; this checkout has no
`.node-version` or `.nvmrc`. `pnpm install --frozen-lockfile` installs the
lockfile graph and fails rather than rewriting a lockfile inconsistent with
`package.json`. Registry/DNS/proxy failures are environment issues; report the
sanitized error category to IT. Do not update dependencies during customer
acceptance as a shortcut.

### Steps 3–6 — Configure, start, and verify the local application

#### Step 3 — Configure local development

From the repository root in PowerShell:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
else { Write-Output '.env already exists; preserve it and review it locally.' }
```

Edit `.env` locally. Keep `DATABASE_PROVIDER=postgresql`, use a private local
database password in both `POSTGRES_PASSWORD` and the URL-encoded password in
`DATABASE_URL`, and keep `HOST=127.0.0.1`. `.env.example` has no active empty
secret assignments and is checked by the environment unit test. It contains
development placeholders; it is not a production configuration.

#### Step 4 — Start PostgreSQL and verify it is local

`compose.yaml` runs PostgreSQL 18 and publishes container port 5432 only on
host loopback port 5438. `docker compose up -d postgres` starts/reuses the
project's named volume; it does not create a separate fresh database for each
run. Check the selected Compose project and database identity before use.
On first initialization of a new empty Compose volume, the image creates the
database named by `POSTGRES_DB` in `.env.example`/the local `.env`. Reusing an
initialized volume does not create a newly named database just because that
setting changed. If the expected database is absent, ask the local DBA to
provision it; do not delete the volume.

```powershell
docker compose up -d postgres
docker compose ps postgres
docker compose exec -T postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Expected: the container is running/healthy and `pg_isready` reports accepting
connections. If it is unavailable, inspect `docker compose logs --tail 100
postgres` and the local Docker service; do not change credentials or delete
volumes to make it pass.

#### Step 5 — Inspect and apply migrations only to an approved target

Before any migration command, inspect the target identity and current history.
The URL must be the intended local ZohoAmarco development database—not Syspro,
a customer database, or a database whose purpose is unclear. `migrate status`
only inspects migration state; `migrate deploy` changes the selected database.
Use the latter only for a newly approved local development database or an
explicitly approved upgrade with a backup and rollback plan:

```powershell
pnpm exec prisma migrate status --schema prisma/postgresql/schema.prisma
# Apply only after confirming the database target and migration approval:
pnpm exec prisma migrate deploy --schema prisma/postgresql/schema.prisma
```

#### Step 6 — Generate the client, start the API, and verify health

`pnpm db:generate` writes the generated client; run it when required and
inspect the worktree before/after. The development server logs a structured
`Zoho Amarco Middleware API started` event when it listens successfully. Run:

```powershell
pnpm db:generate
pnpm dev
```

The API does not run migrations automatically. The Compose port is bound to
loopback on `5438`. `Ctrl+C` stops the development server. To stop PostgreSQL
without deleting its volume, use `docker compose stop postgres`; do not use
`docker compose down -v` unless you intend to delete the local database.

If the database is already at the current migration state, apply no migration
until its target and history have been checked. `migrate deploy` does not drop
the database, but it can apply pending changes. For a customer database, use
the backup, approval, migration-history review, and rollback process in
[database migrations](database-migrations.md). Never use `migrate reset` or
`docker compose down -v` to test migrations: the latter deletes the Compose
PostgreSQL volume and its data.

ZohoAmarco uses PostgreSQL for its own persistence. The repository has no Syspro connector and must not be pointed at the customer's Syspro database as part of this integration.

`.env.example` is a local-development template, not a production environment
or a source of customer values. Keep a real `.env` out of Git and never display
it with `Get-Content`, `type`, shell tracing, logs, or screenshots. Application
settings are parsed by `src/config/env.ts`; there is no dedicated
environment-check package script. `tests/unit/env.test.ts` checks schema rules,
not a visiting host's values. To check the actual environment, start only after
confirming the PostgreSQL target and inspect startup's sanitized validation
messages; do not copy raw environment data into a ticket. Only keys read by
`src/config/env.ts` are application settings. Compose's `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB` configure the local container.

### Startup checks

With the API running, PowerShell examples are:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health/live
Invoke-RestMethod http://127.0.0.1:3000/health/ready
Invoke-RestMethod http://127.0.0.1:3000/health/integrations
```

`/health/live` returns HTTP 200 with `status: ok` if the process responds.
`/health/ready` returns 200 `ready` only when its bounded database check
completes; missing/unavailable/timed-out DB returns 503 `not_ready`.
`/health/integrations` returns configuration and blockers, not provider
verification. `/health/dependencies` returns HTTP 200 when diagnostics
complete, with separate database/device states that may say `unavailable`; it
probes PostgreSQL and, when configured, the device, so it may issue a
LabServer read. `/health/device` returns 503 when no diagnostic adapter exists
or the probe is unavailable; when configured it issues bounded `ReadVersion()`
and returns `connected` or `unavailable`, not the device version. These checks
do not prove Zoho reachability, CU readiness, fiscal readiness, or receipt
capability.
See
[health and operations](operations-and-deployment.md#startup-and-health-verification).
These `/health/*` routes are registered before the `/integrations/zoho`
bearer-authentication middleware. Keep `HOST` on loopback unless the customer
has approved and enforced an appropriate network boundary; in particular,
any caller that can reach `/health/device` or `/health/dependencies` can cause
the configured read-only device probe. Do not expose the API or LabServer to
untrusted networks. This is a current routing property, not an authentication
guarantee.

### Step 7 — Stop the application safely

For local `pnpm dev`, use `Ctrl+C` in that PowerShell window and let shutdown
finish. `src/server.ts` handles SIGINT/SIGTERM by stopping background workers,
closing the HTTP listener and draining requests, closing the Tremol HTTP
transport, and disconnecting PostgreSQL. If shutdown exceeds
`SHUTDOWN_TIMEOUT_MS`, inspect sanitized logs, in-flight request/attempt state,
and dependency availability before taking further action. Forced termination
can make an external write's outcome uncertain; it is not the first diagnostic
step. In a customer deployment, use the approved supervisor's normal stop
action and verify signal delivery; this repository has no Windows service
wrapper or installer.

## 3. Configuration and secrets

`src/config/env.ts` validates application settings at startup. The complete
application environment reference, defaults, allowed values, and validation
limits are in [operations and deployment](operations-and-deployment.md#configuration-reference).
The `.env.example` file covers local PostgreSQL defaults and optional provider
configuration. Docker Compose variables (`POSTGRES_USER`,
`POSTGRES_PASSWORD`, `POSTGRES_DB`) configure the local container; they are not
application environment schema fields.

Important groups:

- **Runtime/API:** `NODE_ENV`, `HOST`, `PORT`, rate-limit bounds,
  `DEPENDENCY_HEALTH_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS`, and `LOG_LEVEL`.
- **Database:** `DATABASE_PROVIDER`, PostgreSQL `DATABASE_URL` and timeout
  bounds.
- **Access control:** distinct service and operator bearer credentials, or
  named `OPERATOR_API_CREDENTIALS_JSON` identities with explicit permissions.
  Production requires a service credential and operator authentication.
- **Zoho:** paired OAuth client ID/secret, 64-hex-character encryption key,
  organization ID, registered redirect URI and Accounts data center. Sync is
  off by default. Read-only invoice intake requires only
  `ZohoBooks.invoices.READ`. Optional custom-field writeback additionally
  requires tenant custom-field IDs and `ZohoBooks.invoices.UPDATE`; request
  that permission only when a separately approved scope includes writeback.
  Configuring the feature does not itself authorize changing a customer
  invoice; the writeback is operator-triggered and guarded by persisted
  authoritative outcomes and operator permission. No live writeback has been
  verified.
- **Tremol:** `TREMOL_ADAPTER` defaults to `disabled`; opting into
  `zfplabserver_readonly` requires the HTTP origin and bounded timeout. This
  does not enable fiscal issuance.
- **eTIMS:** disabled by default. Provider-specific settings, encrypted payload
  key/keyring and explicit adapter are required for enabled non-production
  configuration. Current provider contracts remain unverified; production
  submission is blocked.
- **Recovery/simulation:** recovery is off by default and never replays an
  uncertain fiscal operation. Simulation is local-only, explicit, and rejected
  in production.

Provision secrets through the customer's approved secret manager or protected
service environment. Never commit `.env`, paste credentials into tickets/chat,
place secrets in shell history, or include raw support bundles. Keep the Zoho
OAuth and eTIMS payload encryption keys backed up under separate access
controls. Rotate encryption keys by retaining all old key IDs until encrypted
rows have been rewrapped or expired under an approved procedure. Losing an old
key can make stored tokens or eTIMS payloads unreadable.

The API is server-to-server; it does not configure CORS for arbitrary browser
origins. It binds to loopback by default. If remote callers are approved, place
it behind the customer's authenticated TLS boundary, explicitly review the
bind address and firewall rules, and account for the in-process IP rate limiter
when operating behind a proxy.

## 4. Build, test, and release checks

The scripts below are defined in `package.json`:

```powershell
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm format:check
pnpm build
pnpm test --reporter=dot
pnpm db:validate
pnpm db:generate
pnpm openapi:lint
git diff --check
```

Use the following matrix to choose the check that matches the change. Run
commands from the repository root. These commands assume PowerShell on the
Windows workstation; the `pnpm` and `git` commands are otherwise platform
independent.

| Check                                           | Purpose / prerequisites                                                                                                                                       | Pass means / failure next step                                                                                                                                                 | Side effects and office-readiness                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck`                                | Type-check application code; dependencies installed.                                                                                                          | No TypeScript errors. A failure identifies compile-time contract drift; inspect the first source error.                                                                        | No external service or database; no intended source writes. Required before office visit.                                                                                            |
| `pnpm typecheck:tests`                          | Type-check tests and fixtures.                                                                                                                                | Test interfaces compile; fix test/source type mismatch.                                                                                                                        | No external service or database. Required before office visit.                                                                                                                       |
| `pnpm lint`                                     | ESLint across the repository.                                                                                                                                 | No lint errors; inspect the named file/rule rather than disabling it broadly.                                                                                                  | No intended writes. Required before office visit.                                                                                                                                    |
| `pnpm format:check`                             | Prettier check across tracked and configured files.                                                                                                           | All checked files match formatting. Use targeted `pnpm exec prettier --write <file>` only after reviewing the file and worktree.                                               | Check is read-only; `format --write` changes files. Required before office visit.                                                                                                    |
| `pnpm test --reporter=dot`                      | Complete Vitest suite; mocks/local fixtures by default.                                                                                                       | Passing tests verify only the exercised local behavior. A skipped integration suite means its explicit run flag/DB was absent; it is not a pass for that integration.          | No provider/hardware access by default; four PostgreSQL integration files skip unless explicitly enabled. Required before office visit.                                              |
| Focused `pnpm exec vitest run … --reporter=dot` | Run a relevant unit test subset (examples below).                                                                                                             | Confirms only those assertions. On failure, inspect the source boundary and fixture; do not weaken expectations.                                                               | No external call for unit tests unless explicitly identified. Useful during changes and required for changed behavior.                                                               |
| `pnpm build`                                    | Emit production JavaScript via TypeScript compiler.                                                                                                           | Successful compile creates `dist/`.                                                                                                                                            | Writes build output; inspect `git status` before/after. Required before release/office test artifact preparation.                                                                    |
| `pnpm db:validate`                              | Validate `prisma/postgresql/schema.prisma`.                                                                                                                   | Prisma schema is valid; it does not prove migrations apply to a live DB.                                                                                                       | No DB connection or migration. Required before office visit.                                                                                                                         |
| `pnpm db:generate`                              | Generate PostgreSQL Prisma client.                                                                                                                            | Client generation succeeds for the checked-in schema.                                                                                                                          | Writes `src/generated/prisma/postgresql` (normally ignored); inspect status. Required after schema/client changes, otherwise optional.                                               |
| `pnpm openapi:lint`                             | Lint `docs/openapi.yaml`.                                                                                                                                     | Spec passes configured Redocly rules. Six known issues are explicitly ignored in the current configuration.                                                                    | No external access or writes. Required when API contract/docs change; safe release check.                                                                                            |
| `pnpm audit:deps`                               | Audit locked dependency tree at the configured high severity threshold.                                                                                       | No reported findings at that threshold; this is a point-in-time registry audit, not proof of zero risk.                                                                        | Registry/network access; no app/provider request. Required before release/office artifact.                                                                                           |
| `git diff --check`                              | Detect whitespace errors in tracked diffs.                                                                                                                    | Exit 0 means no whitespace errors in tracked changes. Untracked files need separate review/format check.                                                                       | Read-only. Required before handover.                                                                                                                                                 |
| PostgreSQL repository integration tests         | Require `RUN_POSTGRES_INTEGRATION=1` or `RUN_POSTGRES_OAUTH_INTEGRATION=1`, the corresponding explicit URL, and confirmed dedicated local `zoho_amarco_test`. | Pass verifies repository behavior against that schema version; it does not validate production DB operations. A connection failure is environment failure, not a passing test. | Writes/deletes only rows created by the suite, except the token suite uses the singleton `ZohoToken` row in the dedicated test DB. Run only after verifying target and test cleanup. |
| PostgreSQL fresh-install test                   | Require `RUN_POSTGRES_MIGRATION_INTEGRATION=1` and explicit `ZOHO_POSTGRES_MIGRATION_TEST_DATABASE_URL` to a new, empty, dedicated local DB.                  | Pass means the migration chain applied and assertions saw expected schema; it does not prove upgrade behavior on customer data.                                                | Applies migrations and creates tables. Never use dev/test/customer DB, never reset, and never reuse a populated migration-test DB. Run only when fresh-install evidence is needed.   |
| Guarded Zoho verifier `pnpm verify:zoho:live`   | Requires `ZOHO_LIVE_VERIFY=1`, intended non-production Zoho credentials/tenant/invoice, and the isolated `zoho_amarco_zoho_live_test` token database.         | Verifies one approved invoice GET and local mapping structure only. 404 is not a cause diagnosis without safe provider error detail.                                           | Makes an external read-only Zoho request and may refresh/store a token in the dedicated verifier DB. Requires explicit customer/Zoho approval; never run as routine local CI.        |

The minimum office-preparation gate is: clean results for both typechecks,
lint, formatting, full default test suite, build, schema validation, OpenAPI
lint, dependency audit, and diff check. “Clean” here means the checks report
success; it does not mean the worktree should be cleaned. Review and retain all
pre-existing modifications.

Focused Tremol contract tests:

```powershell
pnpm exec vitest run tests/unit/tremol-vendor-sdk.test.ts tests/unit/tremol-zfplabserver-client.test.ts tests/unit/tremol-zfplabserver-transport.test.ts tests/unit/tremol-fiscal-device.test.ts tests/unit/tremol-device-diagnostics.test.ts tests/unit/tremol-simulator.test.ts --reporter=dot
```

Focused invoice/fiscalization tests can be selected by their current files, for
example:

```powershell
pnpm exec vitest run tests/unit/zoho-books-client.test.ts tests/unit/zoho-invoice-mapper.test.ts tests/unit/prepare-fiscalization-request.test.ts tests/unit/fiscalization-workflow.test.ts tests/unit/zoho-fiscalization-writeback.test.ts --reporter=dot
```

Other verified focused groups (all paths exist in `tests/unit/`):

```powershell
# OAuth and HTTP authorization / configuration
pnpm exec vitest run tests/unit/zoho-oauth-routes.test.ts tests/unit/zoho-oauth-service.test.ts tests/unit/zoho-authorization-url.test.ts tests/unit/zoho-api-domain.test.ts tests/unit/api-authorization.test.ts tests/unit/env.test.ts --reporter=dot

# Idempotency, state transitions, claims, unknown outcomes and recovery
pnpm exec vitest run tests/unit/register-fiscalization-request.test.ts tests/unit/status-transitions.test.ts tests/unit/fiscalization-service.test.ts tests/unit/fiscalization-workflow.test.ts tests/unit/recover-stale-fiscalizations.test.ts tests/unit/stale-fiscalization-recovery-worker.test.ts --reporter=dot

# Tremol transport, allowlist, response parser, diagnostics and blocked receipt proposal
pnpm exec vitest run tests/unit/tremol-zfplabserver-transport.test.ts tests/unit/tremol-zfplabserver-client.test.ts tests/unit/tremol-device-diagnostics.test.ts tests/unit/tremol-receipt-command-builder.test.ts tests/unit/tremol-fiscal-device.test.ts tests/unit/tremol-vendor-sdk.test.ts --reporter=dot

# OSCU/VSCU client shapes, mapping, and reconciliation boundaries
pnpm exec vitest run tests/unit/kra-protocol-clients.test.ts tests/unit/kra-sales-mapping.test.ts tests/unit/etims-reporting.test.ts tests/unit/etims-reconciliation-worker.test.ts --reporter=dot

# HTTP routes, health, logging, rate limits and shutdown
pnpm exec vitest run tests/unit/zoho-books-routes.test.ts tests/unit/fiscal-profile-routes.test.ts tests/unit/manual-review-routes.test.ts tests/unit/health.test.ts tests/unit/observability-logging.test.ts tests/unit/rate-limit.test.ts tests/unit/graceful-shutdown.test.ts --reporter=dot
```

The normal suite includes mocked HTTP and synthetic database tests; it makes no
Zoho, KRA, or hardware calls. Database integration tests are skipped unless
their explicit flags and designated local databases are provided. Their
connection names and side effects are guarded in
[database-migrations.md](database-migrations.md). Do not point an integration
test at the application database or a customer system.

Before running database integration tests, provision a disposable local test
database with the exact required name/port and review its existing contents.
Previously documented target names are historical facts, not permission to
reuse a database: inspect the current local `.env` and local PostgreSQL
catalog first. This PowerShell-safe Node command prints only host, port and
database name for test URL variables (never user/password/query parameters):

```powershell
node --input-type=module -e 'import "dotenv/config"; for (const k of ["DATABASE_URL", "ZOHO_FISCALIZATION_TEST_DATABASE_URL", "ZOHO_OAUTH_TEST_DATABASE_URL", "ZOHO_POSTGRES_MIGRATION_TEST_DATABASE_URL"]) { const v = process.env[k]; if (!v) { console.log(`${k}: absent`); continue; } try { const u = new URL(v); console.log(`${k}: host=${u.hostname}, port=${u.port || "default"}, database=${decodeURIComponent(u.pathname.slice(1))}`); } catch { console.log(`${k}: configured but invalid URL`); } }'
```

For the repository integration suites, the source guards require loopback port
`5438` and database `zoho_amarco_test`; the fiscalization and OAuth suites use
separate URL variables and only clean rows they create, except the token suite
uses the test database's singleton token row. Before enabling flags, check the
actual databases and migration history using the local PostgreSQL administrator
or approved `psql` access. For the Compose container, these are read-only
inspection examples:

```powershell
docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d postgres -Atc "SELECT datname FROM pg_database ORDER BY datname;"'
docker compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d zoho_amarco_test -Atc "SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY migration_name;"'
```

Confirm the listed target is the designated local test DB and its migration
state is the one required by the integration suite. If the host, name, owner,
or contents are ambiguous, stop. Never point tests at `DATABASE_URL`, a
customer database, or Syspro.

Fresh migration testing requires a new, separately inspected, empty,
dedicated database with a `zoho_amarco_migration_test` name (optional
lowercase suffix segments are accepted). A previously used suffix such as
`zoho_amarco_migration_test_fresh_20261028` is already populated and must not be
reused as an empty target. If a new target is needed, first query whether that
exact database name already exists. Only an authorized local PostgreSQL
administrator may create a new database, using the agreed new suffix; never
drop/reset an existing name automatically. Configure the explicit migration
test URL in the protected local environment and follow the guarded command in
[database migrations](database-migrations.md). The integration test itself
checks that the target has no public base tables before applying migrations.
Do not run `migrate reset` or reuse development/integration databases for a
fresh-install check.

Only after confirming the configured fiscalization and OAuth URLs both resolve
to the intended local test database, run the repository suites from PowerShell:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "1"
$env:RUN_POSTGRES_OAUTH_INTEGRATION = "1"
pnpm exec vitest run tests/integration/postgresql-fiscalization-repository.integration.test.ts tests/integration/postgresql-zoho-token-repository.integration.test.ts tests/integration/postgresql-zoho-oauth-attempt.integration.test.ts --reporter=dot
Remove-Item Env:RUN_POSTGRES_INTEGRATION
Remove-Item Env:RUN_POSTGRES_OAUTH_INTEGRATION
```

The fiscalization URL variable is `ZOHO_FISCALIZATION_TEST_DATABASE_URL`; the
OAuth URL variable is `ZOHO_OAUTH_TEST_DATABASE_URL`. Both are independently
checked by their integration suites. The fiscalization suite deletes its
synthetic request/profile/operation rows; OAuth-attempt cleanup deletes only
synthetic attempts. The token integration suite deletes the singleton token
row and therefore must run only on the dedicated test database, never on a
development/production database. These suites do not apply migrations. For an
empty fresh-install database, use the separately guarded
`tests/integration/postgresql-migrations.integration.test.ts` command in
[database migrations](database-migrations.md); it applies the migration chain
and must target a new empty database.

`pnpm verify:zoho:live` is a separate, opt-in, read-only invoice check. It
requires `ZOHO_LIVE_VERIFY=1`, `ZOHO_LIVE_TEST_INVOICE_ID`, configured Zoho
OAuth settings and a dedicated migrated `zoho_amarco_zoho_live_test` database
via `ZOHO_LIVE_VERIFY_DATABASE_URL` or the documented safe loopback derivation.
It must not run in production. Only after separate written approval, verified
tenant/invoice identity, and the database guard above, a PowerShell operator
may opt in for one read-only GET:

```powershell
$env:ZOHO_LIVE_VERIFY = "1"
try { pnpm verify:zoho:live }
finally { Remove-Item Env:ZOHO_LIVE_VERIFY }
```

The check may refresh OAuth tokens and writes a refreshed token to its
dedicated verifier database; it never updates the invoice. Tenant and invoice
non-production status must be independently approved. Do not add secrets or
database URLs to this command. A prior written report says the configured
invoice GET returned HTTP 404; the cause is unresolved and the underlying
response/log is not retained in the repository. Treat it as a previously
reported result, not primary evidence; it does not confirm the intended
organization or successful invoice access. See
[live Zoho verification](operations-and-deployment.md#read-only-zoho-tenant-verification).

`pnpm audit:deps` runs the dependency audit. The SQL Server persistence driver
chain that previously included Azure Identity/MSAL has been removed because
PostgreSQL is the only supported ZohoAmarco persistence provider. The latest
reported audit found no known vulnerabilities; repeat the audit for release
evidence. See [dependency security](dependency-security.md).

### Safe code-change map

Use this map for small, reviewed changes. Follow the neighboring tests and
preserve the invariants below; do not bypass the production gates to exercise a
new path.

| Change                                                       | Primary source                                                                                                                                                                                                                                         | Tests to extend                                                                                                                                                                                   | Required safeguards                                                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a Zoho invoice response field                            | `src/integrations/zoho/books-client.ts`, then `src/application/zoho/zoho-invoice-mapper.ts`                                                                                                                                                            | `tests/unit/zoho-books-client.test.ts`, `tests/unit/zoho-invoice-mapper.test.ts`                                                                                                                  | Validate the provider response at the boundary; preserve decimal number lexemes and opaque IDs; do not log full invoice records.                                                                                                                              |
| Change fiscal candidate mapping or required-field validation | `src/application/zoho/zoho-invoice-mapper.ts`, `src/application/fiscalization/prepare-fiscalization-request.ts`, `src/application/fiscalization/fiscalization-snapshot.ts`                                                                             | `tests/unit/zoho-invoice-mapper.test.ts`, `tests/unit/prepare-fiscalization-request.test.ts`, `tests/unit/fiscalization-snapshot.test.ts`                                                         | Do not infer tax, payment, customer or item data; retain decimal strings and immutable invoice snapshots.                                                                                                                                                     |
| Change OAuth or organization/data-center handling            | `src/application/zoho/zoho-oauth-service.ts`, `src/integrations/zoho/authorization-url.ts`, `src/integrations/zoho/accounts-domain.ts`, `src/integrations/zoho/api-domain.ts`, `src/integrations/zoho/token-exchange.ts`                               | `tests/unit/zoho-oauth-service.test.ts`, `tests/unit/zoho-authorization-url.test.ts`, `tests/unit/zoho-api-domain.test.ts`, `tests/unit/zoho-token-exchange.test.ts`                              | Preserve PKCE/state validation, encrypted token storage, organization scoping, refresh leases and sanitized errors.                                                                                                                                           |
| Add a documented LabServer read command                      | `src/infrastructure/device/tremol-zfplabserver-client.ts`, `src/infrastructure/device/tremol-zfplabserver-transport.ts`                                                                                                                                | `tests/unit/tremol-zfplabserver-client.test.ts`, `tests/unit/tremol-zfplabserver-transport.test.ts`, and `tests/unit/tremol-device-diagnostics.test.ts` if surfaced in diagnostics                | Require version-matched vendor evidence; retain the explicit allowlist, single-command serialization, bounded timeout, strict response validation and no automatic retry. A GET example alone does not verify the installed LabServer.                        |
| Implement a Tremol receipt operation                         | `src/infrastructure/device/tremol-fiscal-device.ts`, `src/infrastructure/device/tremol-receipt-command-builder.ts`, `src/application/fiscalization/fiscalization-service.ts`, `src/application/fiscalization/fiscalization-orchestration-service.ts`   | `tests/unit/tremol-receipt-command-builder.test.ts`, `tests/unit/tremol-fiscal-device.test.ts`, `tests/unit/fiscalization-service.test.ts`, `tests/unit/fiscalization-workflow.test.ts`           | Do not implement until the exact command sequence, argument encoding, response semantics, timeout/outcome rules and installed firmware/LabServer compatibility are authoritative. Preserve all startup and execution gates; test only with verified fixtures. |
| Change request states, claims or recovery                    | `src/domain/fiscalization/status.ts`, `src/domain/fiscalization/status-transitions.ts`, `src/domain/fiscalization/fiscalization-operations.ts`, `src/application/fiscalization/`, `src/infrastructure/database/postgresql-fiscalization-repository.ts` | `tests/unit/status-transitions.test.ts`, `tests/unit/fiscalization-workflow.test.ts`, `tests/unit/recover-stale-fiscalizations.test.ts`, `tests/unit/postgresql-fiscalization-repository.test.ts` | Preserve database-atomic claims and attempt history. An uncertain external result is not a failed result and must never be automatically replayed.                                                                                                            |
| Change PostgreSQL persistence                                | `prisma/postgresql/schema.prisma`, `prisma/postgresql/migrations/`, `src/infrastructure/database/postgresql-*.ts`                                                                                                                                      | Matching repository unit test and `tests/integration/postgresql-fiscalization-repository.integration.test.ts` or the relevant OAuth/eTIMS integration test                                        | Use additive migrations, retain unique constraints and transaction boundaries, and run destructive/fresh-install checks only on a newly inspected dedicated test database. Never use the customer Syspro database.                                            |
| Change KRA/eTIMS mapping or transport                        | `src/integrations/etims/`, `src/application/etims/`, `src/application/fiscalization/etims-reporting-service.ts`                                                                                                                                        | `tests/unit/kra-protocol-clients.test.ts`, `tests/unit/kra-sales-mapping.test.ts`, `tests/unit/etims-reporting.test.ts`, `tests/unit/etims-reconciliation-worker.test.ts`                         | Keep OSCU and VSCU contracts separate. Do not operationalize submission/reconciliation until the specific official contract, enrollment, environment and response semantics are verified.                                                                     |
| Add or change configuration                                  | `src/config/env.ts`, `.env.example`, `src/server.ts`                                                                                                                                                                                                   | `tests/unit/env.test.ts` and `tests/unit/health.test.ts` when exposed operationally                                                                                                               | Keep secrets out of examples and validation errors; validate related settings together; disabled integrations remain optional; do not add a boolean that bypasses unverified-contract gates.                                                                  |
| Change an HTTP route or response contract                    | `src/app.ts`, `src/routes/`, `docs/openapi.yaml`                                                                                                                                                                                                       | Matching route test under `tests/unit/` and `pnpm openapi:lint`                                                                                                                                   | Keep auth/permission checks, bounded inputs, correlation IDs, safe error responses and route-level write/fiscal gates. Update OpenAPI only to match implemented behavior.                                                                                     |

### How to make and review a targeted change

Use the same sequence for a mapping correction or a provider-boundary change:

1. Reproduce the issue with the smallest existing test or sanitized fixture.
   Do not capture credentials, complete invoices, or raw device settings.
2. Trace the behavior from the route through the application service and
   domain decision to the provider or database adapter. Change the layer that
   owns the behavior rather than duplicating validation.
3. Find authoritative, versioned evidence before changing provider behavior.
   If the evidence is missing, record the exact missing command/field/response
   and keep the affected adapter blocked.
4. Make the smallest source edit and add a regression assertion for expected
   behavior and the relevant failure or uncertain outcome.
5. Run the focused test in the map, then both typechecks, lint, formatting,
   relevant integration tests (only with confirmed safe targets), and the full
   suite. Run OpenAPI lint for API contract changes.
6. Review `git status --short --branch`, staged and unstaged diffs, untracked
   files, and generated output. Preserve all pre-existing modifications. Check
   that permissions, secret redaction, production gates, idempotency, and
   unknown-outcome handling remain intact. Record test results, evidence,
   limitations, and rollback steps.

Representative diagnosis routes through the code:

| Change scenario                                      | Inspect / test                                                                                                                                                                                                                                                                           | Required evidence and gate                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zoho HTTP status or error classification is wrong    | `src/integrations/zoho/books-client.ts` extracts safe provider status/code; `src/routes/zoho-books-routes.ts` maps it to API categories. Extend `tests/unit/zoho-books-client.test.ts` and `tests/unit/zoho-books-routes.test.ts`.                                                       | Add only the documented provider error fixture. A bare 404 stays ambiguous; do not expose raw provider response.                                                                                                                               |
| OAuth, organization, or data center needs correction | `src/application/zoho/zoho-oauth-service.ts`, `src/integrations/zoho/authorization-url.ts`, `accounts-domain.ts`, `api-domain.ts`, and `token-exchange.ts`. Run OAuth route/service, URL, domain and token-exchange tests.                                                               | Confirm the intended organization, data center and grant with the Zoho administrator. Preserve PKCE/state, encrypted token storage, refresh lease and least-privilege scopes.                                                                  |
| Add/correct a mapped invoice field                   | Validate provider shape in `src/integrations/zoho/books-client.ts`, map it in `src/application/zoho/zoho-invoice-mapper.ts`; run `zoho-books-client`, `zoho-invoice-mapper`, `prepare-fiscalization-request`, and `fiscalization-snapshot` unit tests.                                   | Confirm field semantics with current Zoho documentation and approved tenant data. Preserve decimal strings and do not infer tax, payments, or missing fiscal data.                                                                             |
| Registration, state, claim, or recovery defect       | Trace `register-fiscalization-request.ts`, `domain/fiscalization/status-transitions.ts`, `fiscalization-service.ts`, `fiscalization-orchestration-service.ts`, and `postgresql-fiscalization-repository.ts`; run registration, status, service, workflow, recovery and repository tests. | Preserve organization/invoice idempotency, atomic claim, durable attempts, and no automatic replay after `OutcomeUnknown`. Any PG integration requires the dedicated local test DB.                                                            |
| Add a LabServer read command                         | Update the finite command union/dispatch and strict response parser in `src/infrastructure/device/tremol-zfplabserver-client.ts`; run client, transport and diagnostics tests.                                                                                                           | Require vendor confirmation for installed version, signature, response fields and repeat safety. Keep serialized bounded calls and command allowlist.                                                                                          |
| Implement a fiscal receipt command                   | `src/infrastructure/device/tremol-receipt-command-builder.ts`, `tremol-fiscal-device.ts`, `src/application/fiscalization/fiscalization-service.ts`, and `fiscalization-orchestration-service.ts`; tests include receipt-plan, device, service and workflow.                              | Requires exact authoritative command sequence, argument encoding, responses, timeout semantics, device/LabServer acceptance, explicit transaction approval and recovery plan. Keep the fiscal gate closed until a separately reviewed release. |
| Change eTIMS mapping or transport                    | Inspect `src/application/etims/`, `src/application/fiscalization/etims-reporting-service.ts`, and `src/integrations/etims/`; run KRA client, sales mapping, reporting and reconciliation tests.                                                                                          | Establish which distinct OSCU or VSCU contract applies, its enrollment, environment, payload and outcome lookup. Do not enable submission based on mock success.                                                                               |
| Change PostgreSQL persistence                        | Update `prisma/postgresql/schema.prisma`, an additive migration if required, mapper/repository, and matching repository test. Run schema validation/generation; integration only on an inspected dedicated target.                                                                       | DBA reviews migration and backup/restore implications. Never edit applied migration files or use development/customer DB for fresh install.                                                                                                    |
| Change environment validation                        | Update `src/config/env.ts`, `.env.example`, `src/server.ts`, `tests/unit/env.test.ts`, and health tests if observable.                                                                                                                                                                   | Keep secrets out of examples/errors; related settings must validate together; disabled integrations stay optional; no flag may bypass an unverified contract.                                                                                  |
| Change route or health diagnostics                   | Update `src/app.ts` or owning route, matching route/health test, and `docs/openapi.yaml` if the public response changes.                                                                                                                                                                 | Preserve authentication, permissions and safe errors. Document whether health probes cause external/device traffic; health must not imply provider or fiscal readiness.                                                                        |

For a local failure, first rerun only the affected test using the existing
Vitest command form, for example
`pnpm exec vitest run tests/unit/zoho-books-client.test.ts --reporter=dot`.
Then run both typechecks, lint, formatting and the full test suite before
handing off a code change. Database integration tests require the explicit
isolated targets described above. `pnpm db:generate` writes generated Prisma
client files; inspect `git status` before and after generation and do not stage
generated output unless the repository explicitly tracks it. `pnpm build`
writes `dist/`; do not mistake build output for source changes.

## 5. Customer Windows server visit checklist

Collect facts before changing configuration. Do not guess hostnames, ports,
credentials, fiscal mappings, legal sequence, or test invoice IDs.

### Host, access, and database

- [ ] Record Windows Server edition/version/build, patch status, hostname, time
      zone, NTP status, DNS, proxy settings, and reboot/maintenance process.
- [ ] Confirm an approved account can install/run Node.js 24+ and pnpm 12.14.0,
      read the release directory, read injected secrets, write application logs,
      and reach only the required database and local services.
- [ ] Identify the approved Windows service supervisor. Confirm it starts in
      the release working directory, restarts according to policy, captures
      stdout/stderr, forwards a graceful stop, and runs under a least-privilege
      service account. No service wrapper or installer is included here.
- [ ] Record intended API bind host/port and caller network path. Default bind
      is `127.0.0.1:3000`; document any approved reverse proxy, TLS termination,
      firewall allowlist, and authentication boundary. Do not expose port 3000
      or LabServer port 4444 to an untrusted network.
- [ ] Identify database provider, host/instance, database name, TLS/certificate
      requirements, least-privilege login, backup owner, backup cadence, restore
      test, retention, and maintenance window. Keep credentials in the approved
      secret manager.
- [ ] Confirm migrations and schema generation will be applied through the
      reviewed provider-specific process with a verified backup and rollback
      path. Startup does not migrate automatically.

### Zoho, Tremol, and KRA/eTIMS

- [ ] Confirm Zoho organization and Accounts data center, OAuth app owner,
      registered redirect URI, requested scopes, authorized test invoice, and
      consent/revocation contact. Obtain read permission first. Do not assume
      the previous 404 is fixed.
- [ ] Record the installed ZFP LabServer version/build, configuration owner,
      actual listening origin/port, local authentication/access controls,
      supported HTTP mode, and how the service is supervised.
- [ ] Identify the actual Tremol G03 model, serial/identity reference, firmware,
      approved Kenya CU configuration/registration state, connection type,
      vendor driver, USB/serial cable or network details, serial settings, and
      authorized device operator. Do not expose device passwords in notes.
- [ ] Ask the authorized Tremol contact to confirm compatibility among the
      installed LabServer definitions, supplied SDK generation timestamp, G03
      firmware, and Kenya CU protocol. Record evidence and contact details.
- [ ] Record customer IT/network restrictions, Windows Firewall rules, outbound
      Zoho/KRA endpoints, TLS inspection/proxy behavior, and whether local
      loopback access from the service account reaches LabServer.
- [ ] Identify the applicable KRA eTIMS model, taxpayer enrollment, official
      sandbox, authorized support contact, credentials/certificate owner, legal
      sequence decision, and safe reconciliation procedure. Do not enable
      reporting until these are approved.
- [ ] Obtain written authorization for any live Zoho read, device read, or
      fiscal mutation. Identify a known test invoice, expected tax/payment
      handling, evidence capture location, abort contact, and reconciliation
      owner. A test invoice alone does not authorize issuing a receipt.

Record unknown values in the customer change/acceptance record; never fill them
with sample values from repository documentation.

## 6. Physical acceptance plan

Perform checks in order. Stop when an earlier step fails. Use the customer's
approved maintenance window and designated non-production/test setup. The
application's current production gates keep fiscal receipt issuance and eTIMS
submission unavailable; do not work around those gates during acceptance.

| Step                      | Purpose and action                                                                                                                                                                                                                                                            | Expected result and record                                                                                                                                                                                                             | Risk / stop condition                                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0. Change review          | Record release revision, Windows build, database target, backups, service identity, feature flags, vendor versions, and written approvals. Keep receipt issuance/eTIMS gates closed.                                                                                          | Signed preflight record with actual values collected from the site.                                                                                                                                                                    | No provider call. Stop if backups, rollback owner, authorization, or configuration owner is missing.                                                                                                   |
| 1. Process/database       | Start the API under the approved supervisor; call `GET /health/live` and `GET /health/ready`.                                                                                                                                                                                 | Liveness `200`; readiness `200` only when DB is reachable. Record correlation ID and sanitized logs.                                                                                                                                   | No provider mutation. Stop on config, database, or migration error; do not auto-migrate.                                                                                                               |
| 2. Configuration          | Call `GET /health/integrations` and `GET /health/dependencies`.                                                                                                                                                                                                               | Secrets absent; receipt issuance and combined workflow report blocked. Optional providers are configured/unverified or not configured.                                                                                                 | Dependency diagnostics may perform the selected read-only device check. Stop if flags unexpectedly enable simulation, eTIMS, or an unsupported adapter.                                                |
| 3. LabServer read-only    | With explicit customer/vendor approval and `TREMOL_ADAPTER=zfplabserver_readonly`, call `GET /health/device` once. This application endpoint invokes only the client's `ReadVersion()` connectivity check.                                                                    | HTTP 200 `{status:"connected",component:"device"}` or HTTP 503 `{status:"unavailable",component:"device",...}`. The route deliberately does not return the version. Record only status, category, LabServer build, and correlation ID. | Read-only command; bounded by device and health timeouts. Stop on timeout, nonzero code, malformed response, mismatch, or sensitive output. Do not retry automatically. Connectivity is not readiness. |
| 4. Optional status read   | Only if vendor/customer authorize and need it, use a trusted local probe to issue the manual's direct `GET /ReadStatus()` once. There is no public middleware route for raw `ReadStatus`; do not invent one.                                                                  | Record HTTP status, result code, and sanitized field names/types/values. Compare with the supplied Kenya definitions and vendor guidance.                                                                                              | Read-only per source definitions, but installed behavior/repeat safety is unverified. Stop on any unexpected side effect, response shape, or timeout; do not interpret missing fields as healthy.      |
| 5. GET/POST compatibility | If the vendor wants the SDK mode verified, on the same approved test setup send exactly one bounded source-equivalent `POST /` with `Content-Type: text/plain` and `<Command Name="ReadVersion"></Command>`. The manual's GET path remains the application's configured mode. | Record method, endpoint origin, HTTP status, result code, sanitized version, timestamp, LabServer build, and correlation ID. Ask vendor to confirm definition/firmware compatibility.                                                  | Read command only. This tests one POST request shape, not the SDK's synchronous XHR runtime or other commands. Never retry after timeout/uncertain result or automatically switch modes.               |
| 6. Zoho read-only check   | Only with separate authorization and a known non-production organization/invoice, run the guarded `pnpm verify:zoho:live` procedure using its dedicated database.                                                                                                             | Record the actual current response. A prior written report says the configured invoice returned 404, but the underlying response evidence is not retained and the cause is unknown.                                                    | Does not write invoice fields, but may refresh the OAuth token in the dedicated verification DB. Stop on tenant/invoice ambiguity.                                                                     |
| 7. Simulation preflight   | In a separate non-production/local environment only, execute the documented simulated workflow and inspect durable status/history.                                                                                                                                            | Response and persisted outcome explicitly say `simulated`; receipt is synthetic.                                                                                                                                                       | No hardware/KRA call. Never enable simulation in production or count it as fiscal acceptance.                                                                                                          |
| 8. Fiscal mutation        | **Not currently available for customer acceptance.** Do not invoke receipt issuance, cancellation, or KRA production operations.                                                                                                                                              | A future separately reviewed release must have verified command contracts, legal sequence, approved test invoice/CU, signed test procedure, operator, and an evidence-backed recovery plan.                                            | Requires explicit customer and vendor/KRA authorization and code that passes its own release review. No action in this handover authorizes it.                                                         |

### Unresolved Tremol transport question

The manual §4.12 documents direct HTTP GET command URLs. The supplied SDK's
`do()` uses synchronous HTTP POST with XML to the root. The manual does not
explicitly establish both modes, and the installed LabServer version has not
been checked. Prefer the application's GET path for the initial read-only
check. The optional bounded POST probe above may establish only whether that
single `ReadVersion` request shape works on that installation. If it times out,
do not replay it. Do not call SDK settings/configuration methods,
`PrintDiagnostics()` (absent from supplied source), or generic command
dispatchers. See [Tremol evidence](tremol-g03-kenya-protocol-status.md).

## 7. Troubleshooting

| Symptom                                       | First checks                                                                                                                                                           | Safe next action                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup says invalid environment              | Read sanitized setting names; compare `.env` with `src/config/env.ts`; confirm PostgreSQL configuration and paired credentials.                                        | Correct only the named value. Never include the rejected value in support logs. Validate with `pnpm typecheck` and `tests/unit/env.test.ts`.                            |
| Database connection or migration failure      | Verify PostgreSQL host, port, TLS, database role, selected schema, migration history, and backup.                                                                      | Do not rerun migration against another database. Follow the PostgreSQL recovery in `database-migrations.md`; escalate orphan/partial migration state to the DBA.        |
| Zoho authorization/scope or data-center error | Verify tenant Accounts domain, registered redirect URI, organization ID, READ scope, token expiry/revocation, and that API domain matches Accounts data center.        | Reauthorize through the supported OAuth flow if required. Do not paste tokens or attempt invoice writeback to diagnose a read failure.                                  |
| Zoho invoice 404                              | Confirm exact invoice ID and organization in the approved tenant; inspect safe error category.                                                                         | Cause remains unresolved for the previous live check. Do not enumerate or mutate invoices to guess the cause. Re-run only the guarded read-only verifier with approval. |
| Zoho 429 or 5xx                               | Check safe status/error category, request cadence, and provider limits.                                                                                                | Client uses bounded retries only for its supported GET cases. Do not manually multiply requests; respect the persisted synchronization result.                          |
| ZFP LabServer unavailable                     | Verify host service is running, configured endpoint/port, loopback reachability from service account, Windows firewall, proxy, and whether HTTPS is required.          | Use `/health/device` once after confirming adapter selection. No `ServerFindDevice` scan or settings mutation is required.                                              |
| Device unavailable/busy                       | Check vendor LabServer UI/log and physical connection/driver/serial/network state with the device operator.                                                            | Preserve the correlation ID and safe error category. Do not infer fiscal readiness or run configuration commands. Ask the vendor to interpret device status codes.      |
| Tremol timeout/disconnect                     | Determine whether the request may have reached the server/device; preserve the request timestamp and correlation ID.                                                   | Treat the command outcome as unknown. Do not retry automatically. Use only an approved vendor-authoritative read/reconciliation procedure.                              |
| Malformed XML / unexpected fields             | Compare status/result envelope, names, types, encoding and LabServer definitions version with supplied docs.                                                           | Preserve a sanitized fixture for contract tests; do not log raw payloads or enable fiscal commands as a diagnostic.                                                     |
| Nonzero LabServer result code                 | Record HTTP status and numeric result code. Manual §4.11 describes server error categories; code 40 may include device status bytes in SDK handling.                   | Meanings vary by server/device context; consult the exact manual/version and vendor. A nonzero result does not automatically prove no side effect.                      |
| `OutcomeUnknown` fiscal/eTIMS operation       | Inspect durable request state, attempt history, correlation IDs, and manual-review case.                                                                               | Do not submit again. Obtain authoritative external evidence and record a supported reconciliation decision; operator attestation is not provider verification.          |
| Duplicate invoice / active claim              | Confirm organization+invoice identity and durable request state; concurrent duplicate create resolves to the unique persisted request.                                 | Read status/history. Do not create a second request with alternate IDs to bypass idempotency.                                                                           |
| Windows access/connection failure             | Check service identity ACLs, current working directory, environment injection, DNS/proxy, firewall, driver installation, and user vs service-account network behavior. | Reproduce from the service account and record sanitized OS/service logs. Have customer IT or device vendor correct policy/driver settings.                              |

Do not assign unverified meanings to vendor error codes. Source/version-specific
reference is in the [Tremol status report](tremol-g03-kenya-protocol-status.md),
[KRA client evidence](kra-protocol-clients.md), and
[integration evidence register](integration-contract-evidence.md).

## 8. Deployment, upgrade, rollback, and ownership

This repository supplies buildable Node.js source, not a signed Windows
installer, Windows service definition, database backup agent, or production
secret manager. The customer owns those platform services. For a controlled
deployment:

1. Approve a reviewed source revision and perform the release checks in §4.
2. Build/install on the target Windows architecture with the pinned Node/pnpm
   versions. Store the release in a versioned directory; do not overwrite the
   last known release.
3. Provision the database, least-privilege account, TLS, backups and tested
   restore. Review existing migration history and apply only the matching
   provider migrations during an approved window.
4. Inject production secrets through the approved secret provider and verify
   startup configuration. Do not copy developer `.env` files.
5. Confirm `HOST`, port, TLS/proxy boundary, firewall, bearer credentials,
   access logs, retention, monitoring and named operational owners.
6. Start `node dist/server.js` from the release directory with the approved
   Windows process supervisor. Check `/health/live`, `/health/ready`, and
   `/health/integrations`; perform `/health/device` only if read-only device
   diagnostics were approved and configured.
7. Stop through the supervisor and verify SIGTERM/SIGINT handling, background
   worker stop, HTTP drain, device transport close, and database disconnect.

Before an upgrade, take and verify a database backup, capture current
`_prisma_migrations` state, retain the previous release and configuration
version, and review forward migration behavior. If an application rollback is
needed after an additive schema migration, restore a compatible database backup
or follow an approved forward-fix plan; do not edit deployed migration history
or blindly reverse data migrations. Assign the customer DBA, Windows service
owner, Zoho tenant administrator, and Tremol/KRA contacts before handover.

## 9. Evidence and limitations register

| Evidence level                          | Current state                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented and locally tested          | Application state model, idempotent request registration, repositories, retries/recovery boundaries, manual review, read-only Zoho client, blocked Tremol fiscal boundary, mock/simulation behavior, security gates, and operational endpoints. See test suite and `implementation-inventory.md`. |
| Source/document supported               | Tremol Kenya command definitions and generic LabServer GET/XML documentation; supplied SDK POST behavior; official KRA specs included in repository. Source review does not prove installed compatibility or taxpayer enrollment.                                                                 |
| Mocked provider tests                   | Zoho, eTIMS, LabServer, device simulator, and workflow contract behavior through synthetic HTTP/fetch fixtures. These prove application decisions for fixtures only.                                                                                                                              |
| Local database integration              | PostgreSQL repository integration and fresh-install migration tests have passed against designated local test databases. The 2026-10-28 fresh install used a newly created suffixed migration-test database; development and integration databases were preserved. Re-run for release evidence.   |
| Live Zoho tenant                        | A previous written report says a guarded invoice GET returned 404; the repository does not retain primary response evidence and the cause is unresolved. No successful invoice compatibility result is claimed.                                                                                   |
| KRA sandbox                             | Not established by unit tests; current provider contracts/enrollment/reconciliation remain unverified.                                                                                                                                                                                            |
| Customer ZFP LabServer/G03              | Not hardware-verified. GET and SDK POST compatibility, actual status XML, device/firmware matrix, and fiscal command behavior require authorized on-site acceptance.                                                                                                                              |
| Production fiscal receipt/KRA operation | Disabled/blocked. Do not treat simulated success, HTTP 200, or an uncorrelated provider response as proof of a real receipt.                                                                                                                                                                      |

Keep this table current with dated test output and sanitized vendor/customer
evidence. Never promote a status to live or hardware verified without the
corresponding recorded result.

## 10. Blocker register and closure rules

Use the register below as the working list for engineering and the office
visit. A blocker is closed only when its acceptance evidence is attached to a
change/acceptance record and the named owner accepts it. A test result from a
mock, simulator, source inspection, or HTTP status cannot substitute for a
provider, device, regulatory, or customer result.

| ID                               | Severity / impact                                                  | Current evidence                                                                                                                                                      | Unknown / dependency                                                                                                                    | Owner                                               | Objective closure evidence                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B-01 Receipt sender              | Critical; no real fiscal receipt can be issued by this build.      | `TremolFiscalDevice.executeReceiptCommands()` builds a proposal then returns `RECEIPT_ISSUANCE_BLOCKED`; no device command is sent.                                   | Version-specific command, arguments, order, response and legal sequence; Tremol/authorized integrator and customer/compliance approval. | Developer + Tremol + finance/compliance approver    | Reviewed command contract, implementation behind gates, contract tests from authoritative fixtures, device acceptance on identified CU, and signed transaction reconciliation. |
| B-02 KRA/eTIMS submission        | Critical; combined production fiscal workflow cannot run.          | `KraEtimsReportingAdapter` reports `contractVerified:false`, `operational:false`; submit returns `not_submitted` while closed; reconciliation is unverified.          | Customer OSCU/VSCU applicability, enrollment, authoritative current protocol and approved test environment.                             | Customer compliance + KRA/eTIMS support + developer | Written model/enrollment evidence, verified provider contract and sandbox result, error/recovery tests, responsible-authority acceptance.                                      |
| B-03 Zoho invoice retrieval      | High; intake cannot be accepted against the customer's tenant yet. | Repository documentation reports a prior guarded invoice GET 404, but raw primary response evidence is not retained. Current verifier is read-only and guarded.       | Intended organization, data center, exact invoice ID/ownership/visibility, granted scope, and provider error detail.                    | Zoho administrator + developer                      | Approved invoice GET succeeds in intended tenant; sanitized evidence includes tenant alias, region, request time/correlation, provider category and mapping result.            |
| B-04 LabServer/G03 compatibility | Critical; cannot trust reads or any fiscal operation on target.    | Application uses bounded async HTTP GET for an allowlisted read set; supplied SDK source uses POST/XML; installed target is not verified.                             | Installed versions, network path, version-matched transport/response contract and repeat safety.                                        | Windows admin + device operator + Tremol            | Version inventory and vendor confirmation; one approved bounded read succeeds with captured sanitized response against identified installation.                                |
| B-05 Ambiguous fiscal outcome    | Critical; retry may duplicate an externally issued receipt.        | Application records possible external timeout as `OutcomeUnknown`; stale recovery does not replay; no authoritative CU lookup/reconciliation contract is established. | Device journal/reference lookup and authorized interpretation/recovery process.                                                         | Tremol + device operator + customer compliance      | Written lookup/reconciliation procedure and witnessed test proving success, failure, ambiguity, restart and manual resolution without unsafe replay.                           |
| B-06 Windows deployment          | High; customer-host operation and recovery unknown.                | Node service source supports startup/shutdown; repository does not provide a Windows service installer or supervisor.                                                 | Host topology, service identity, firewall/proxy, TLS, log/backup/restore ownership and restart policy.                                  | Customer Windows/network/DB admins + developer      | Approved deployment record, least-privilege service test, health evidence, backup restore rehearsal, restart/rollback exercise.                                                |
| B-07 Accounting/fiscal policy    | Critical; correct mapping and sequence cannot be guessed.          | Mapper and snapshot validators reject unsupported/missing inputs; payment assessment is not authoritative provider evidence.                                          | Tax, rounding, discounts, customer/item, payment, currency, credit/refund rules and OSCU/VSCU/device ordering.                          | Finance/compliance + applicable authority           | Signed field/rule matrix tied to versioned mapping and approved end-to-end test scenario.                                                                                      |
| B-08 Writeback scope             | High if included; customer invoice mutation is externally visible. | Custom-field writeback exists behind mapping, OAuth UPDATE scope, persisted authoritative results, and `invoice:writeback` permission. No live writeback verified.    | Whether it is in scope, field IDs, expected values, customer rollback/review procedure.                                                 | Customer sponsor + Zoho admin                       | Explicit written approval, tested mapping in approved tenant, audit evidence and customer verification. Otherwise leave unmapped/disabled.                                     |

Local work can continue on validation, fixture-based contract coverage,
sanitized errors, state-transition tests, and documentation. No code or
configuration shortcut closes the external dependencies in B-01 through B-07.

## 11. Remediation playbooks

Each playbook starts with evidence collection and advances only when the
previous gate passes. Preserve timestamps, source/build revision, sanitized
error category, correlation ID where present, and responsible owner. Never
attach raw invoice payloads, OAuth tokens, device passwords, full XML bodies,
database URLs, or encryption keys to an issue.

### 11.1 B-01 — Receipt sender is deliberately blocked

**Problem and impact.** The public fiscalization workflow can register and
process state, but the current device adapter does not transmit a receipt
sequence. In `src/infrastructure/device/tremol-fiscal-device.ts`,
`executeReceiptCommands()` calls the local plan builder and returns the
`RECEIPT_ISSUANCE_BLOCKED` failure. This is a deliberate safety boundary, not a
transport defect. Removing the block without a complete contract risks a
wrong tax category, duplicate/partial receipt, invalid customer data, or an
irreconcilable fiscal event.

**Preconditions and ownership.** A developer owns source tracing and tests;
Tremol or its authorized integrator must establish the installed-version
contract; the customer finance/compliance owner must establish fiscal rules;
the device operator and customer change approver must authorize any eventual
transaction. Do not inspect command behavior by experimenting with mutating
commands. This task authorizes no receipt operation.

**Diagnosis and remediation sequence.**

1. Trace the accepted request entry in `src/routes/zoho-books-routes.ts`
   (the invoice fiscalization registration/process routes) through
   `src/application/fiscalization/fiscalization-orchestration-service.ts`,
   `src/application/fiscalization/fiscalization-service.ts`, the
   `FiscalDevice` interface, and `TremolFiscalDevice.issueReceipt()`.
   Confirm in the current code that registration persists a snapshot, the
   policy gates execution, the service claims a request, and the adapter then
   blocks before transport. If the route/policy response differs, record the
   actual response and inspect the corresponding route test; do not infer a
   receipt was attempted from an API request.
2. Inspect `buildReceiptCommandPlan()` and
   `src/infrastructure/device/tremol-receipt-command-builder.ts`. Treat the
   output as a non-executable proposal. Compare each proposed field against
   `docs/tremol-g03-kenya-protocol-status.md`, `docs/Manual.pdf`, the Kenya CU
   PDF, the version-matched SDK source under `docs/JS/`, and the installed
   server's own versioned documentation. The supplied generic manual and SDK
   examples do not by themselves verify installed Kenya command semantics.
3. Ask Tremol in writing for the exact supported combination of G03 model,
   firmware, country configuration, LabServer build, and SDK/runtime. Request
   authoritative signatures and argument encoding for open-invoice, item,
   subtotal, payment, close/finalize, and any operator-authentication steps;
   required ordering; character encoding and field limits; success and failure
   envelopes/codes; whether each command can partially mutate; command
   timeout/abort semantics; and a read-only way to find a transaction after a
   lost response. Request a versioned document or written support response,
   not an oral “it should work.”
4. Separately obtain signed customer policy for tax classification, prices,
   discounts, currency, customer/item identifiers, payments, rounding, and
   sequence relative to eTIMS. Escalate legal interpretation to the customer’s
   designated compliance authority; do not derive it from a device example.
5. Only after steps 3–4, create a reviewed contract table mapping validated
   snapshot fields to vendor arguments and response fields. Identify which
   module owns encoding/parsing, how response receipt metadata is validated,
   and which errors are confirmed “not executed” versus uncertain. Do not
   write a payload until signatures and semantics are established.
6. In a future implementation change, keep the sender behind the existing
   `FiscalDevice` boundary and existing startup/workflow gates. Add an
   authoritative sanitized fixture for every command response and tests for
   argument bounds, encoding, serialization, nonzero result, malformed or
   incomplete response, timeout before send, timeout after possible send,
   cancellation, concurrency, and blocked policy. Preserve immutable
   snapshot/digest and attempt history. Do not add fallback transport or
   generic dispatch.
7. Before any authorized device acceptance, have the customer designate a
   test scenario, device operator, stop authority, authoritative outcome
   lookup, evidence custodian, and reconciliation owner. The test must be
   transaction-specific, written and supervised. Record one attempt and stop
   if the returned result is incomplete, unexpected, or uncertain.

**Verification and closure.** Run the focused Tremol tests listed in §4,
especially `tremol-receipt-command-builder.test.ts`,
`tremol-fiscal-device.test.ts`, client/transport tests and the complete unit
suite after code changes. Passing fixtures establish local parsing/dispatch
behavior only. Closure additionally requires vendor-confirmed contract,
identified target versions, witnessed command behavior and authoritative
receipt reconciliation. If the current blocked result changes before those
conditions, roll back the code change and keep the production gate closed.

**Why idempotency is not enough.** A unique local `(organization, invoice)`
record prevents duplicate middleware registration. It cannot atomically
commit with a physical CU. If the CU accepts a command but the network or
process loses the response, PostgreSQL may hold only `InProgress` or
`OutcomeUnknown`. Sending again can issue a second receipt. No application
request key proves what the external device did.

### 11.2 B-02 — KRA/eTIMS submission adapter is non-operational

**Problem and impact.** `src/integrations/etims/kra-etims-reporting-adapter.ts`
currently reports `contractVerified:false` and `operational:false`. `submit()`
returns `not_submitted` while activation is closed; `reconcile()` reports an
unknown result because lookup is unverified. `kra-oscu-client.ts` and
`kra-vscu-client.ts` are distinct protocol clients and their presence is not
provider acceptance. `src/config/env.ts` rejects production when
`ETIMS_REPORTING_ENABLED` is true. Therefore an eTIMS client test does not mean
production reporting works.

**Ownership and diagnosis.** The customer compliance owner identifies the
applicable model and taxpayer/environment; KRA/eTIMS support or an authorized
integrator supplies current contract and enrollment evidence; the developer
compares it to adapter code; the customer approver authorizes sandbox access.
Do not select OSCU or VSCU from convenience or local availability.

1. Inspect `src/config/env.ts`, `src/server.ts`,
   `src/integrations/etims/kra-oscu-client.ts`,
   `kra-vscu-client.ts`, `kra-etims-reporting-adapter.ts`,
   `src/application/fiscalization/etims-reporting-service.ts`, and
   `src/application/etims/`. Confirm selected mode, disabled production gate,
   response categories, persistence and reconciliation behavior. Use
   `tests/unit/kra-protocol-clients.test.ts`,
   `kra-sales-mapping.test.ts`, `etims-reporting.test.ts`, and reconciliation
   tests to locate what local fixtures cover.
2. Ask the compliance owner which eTIMS model applies and request evidence of
   enrollment, taxpayer identity in a non-secret form, environment, issuing
   party, and decision owner. Ask why OSCU or VSCU is applicable. A local VSCU
   URL or a configured OSCU environment alone does not answer this.
3. Obtain the current authoritative protocol for the selected model: base
   environment, authentication/certificates, request schemas, required invoice
   fields, decimal/currency rules, response fields and meanings, duplicate
   semantics/idempotency, rate/timeout limits, receipt/reference ownership,
   lookup/reconciliation API, cancellation/correction behavior, and approved
   sandbox process. Ask the provider to identify the version and changes from
   the supplied documents.
4. Build a field-by-field gap matrix against
   `src/application/etims/kra-sales-mapping.ts`, client validation, adapter
   submission and persisted result model. Mark every unsupported or ambiguous
   field; do not fill it from invoice totals or guessed mappings.
5. In a separate implementation task, add only the selected model's verified
   contract. Add fixtures for accepted, rejected, malformed, timeout before
   send, timeout after possible send, duplicate, and lookup results. Keep OSCU
   and VSCU adapter identity separate. Define `not_submitted`, confirmed
   rejection, accepted, and `outcome_unknown` precisely; never retry a
   submission just because the response was lost.
6. Run unit/contract tests, then an explicitly approved sandbox test. Record
   environment, contract version, sanitized request shape, response category,
   provider reference, correlation ID, and compliance owner interpretation.
   Sandbox success remains technical evidence; the compliance owner must
   separately confirm that the actual customer workflow and legal obligations
   are satisfied.

**Closure/stop rule.** Closure requires protocol/version confirmation, actual
test enrollment, approved sandbox evidence, verified reconciliation behavior,
and written compliance acceptance of the intended workflow. If provider
access is unavailable, keep the adapter non-operational and document the
requested evidence, owner, and due date. Do not toggle the gate to make a
health response green.

### 11.3 B-03 — Diagnose the reported Zoho invoice 404

**Problem and impact.** A prior written report states that a guarded invoice
GET returned HTTP 404 after OAuth checks. Its raw response is not retained in
this repository. No cause is established, and this task did not reproduce the
request. Invoice intake is not externally accepted until a known invoice is
retrieved from the intended organization.

**Ownership and access.** The Zoho administrator must confirm tenant, region,
organization, integration user, approved invoice, and authorization without
sharing tokens. A developer needs only approved read access to one known
invoice. The first request must be exactly scoped; do not enumerate invoices
or use writeback to diagnose a GET.

1. Establish safe request context from the operator/Zoho admin: organization
   alias and non-secret organization ID, Accounts data center, API domain from
   the authorized OAuth context, integration user/role, exact approved invoice
   ID, and evidence that that invoice belongs to that organization. Record no
   customer invoice contents.
2. Inspect `src/config/env.ts`, `src/integrations/zoho/accounts-domain.ts`,
   `api-domain.ts`, `authorization-url.ts`, OAuth service/token repository,
   and `src/integrations/zoho/books-client.ts`. Check that Accounts and API
   domains match a supported region, the configured organization is the
   confirmed one, URL path construction encodes the opaque ID safely, and the
   grant includes invoice READ. Never print runtime environment or tokens.
3. Inspect error transformation in `books-client.ts` and
   `src/routes/zoho-books-routes.ts`. Distinguish application-generated
   validation/configuration failures from a received upstream HTTP status.
   The route only maps a provider response with the documented invoice code
   `1002` to a definitive invoice-not-found category; an unstructured 404 is
   ambiguous/upstream failure. Do not infer missing invoice from a bare 404.
4. Have the Zoho admin independently open the exact invoice under the selected
   organization and confirm it is visible to the OAuth-authorized integration
   user. If not visible, the admin should resolve organization/user permissions
   in Zoho and provide a newly approved exact invoice reference. The developer
   must not guess a different ID.
5. Compare organization ID, invoice ID, configured API domain and sanitized
   provider result category in one read-only request. Use `pnpm
verify:zoho:live` only under the separate approval, exact configuration and
   dedicated verifier database procedure in §4 and
   `operations-and-deployment.md#read-only-zoho-tenant-verification`. That
   script makes a live GET and may refresh/store a token; it is not a routine
   local test. Do not run it during this documentation task.
6. Interpret results by evidence: 401 points to authentication/token
   validation investigation; 403 to granted authorization/role; 429 to
   bounded rate handling; 5xx/network to provider availability; a structured
   documented code may support a not-found conclusion for that request; bare
   404 remains ambiguous. These are categories, not proof of the underlying
   configuration cause. Preserve only sanitized status/code/category,
   timestamp, correlation ID and tenant/invoice aliases.
7. If the invoice succeeds, inspect mapper output field-by-field against the
   admin-approved invoice values without exporting the full record. Record
   validation result and which required source fields were present. Do not
   proceed to fiscalization just because retrieval/mapping passed.

**Code remediation if the issue persists.** Reproduce with a mocked response
in `tests/unit/zoho-books-client.test.ts` or
`tests/unit/zoho-books-routes.test.ts`; preserve upstream status and safe
numeric code while discarding raw body/message. Correct only a demonstrated
URL, region or classification defect. Add a regression for structured and
bare 404, wrong org/region, auth, scope, timeout and malformed response. Do
not broaden access or expose provider bodies to logs.

**Acceptance.** The intended tenant, region, organization and exact invoice
must be confirmed by the admin; one approved GET must return a structurally
valid invoice; mapper validation must produce an accepted candidate or
explicit documented field gaps; the sanitized evidence must be attributable
to that exact request. A successful OAuth exchange alone is not invoice
access, and a successful invoice GET is not fiscal acceptance. If tenant
access is unavailable, mark B-03 blocked and schedule an authorized read-only
verification rather than claiming resolution.

### 11.4 B-04 — Verify installed ZFP LabServer/G03 compatibility

**Problem and impact.** The application read client uses a bounded asynchronous
HTTP GET command allowlist; the supplied JavaScript SDK uses synchronous HTTP
POST with XML. The supplied manual's direct interface documents GET command
routes. The customer's installed LabServer and firmware have not been tested
against either path. A listening socket is only network reachability, not
LabServer command compatibility, device communication, device readiness, or
legal readiness.

**Owners and permissions.** Windows/network administrator provides host,
service/process and route observations. Device operator provides identity and
may supervise approved read-only checks. Tremol/authorized integrator
confirms version-specific interface and command semantics. Customer
approver authorizes each read. Server access does not automatically authorize
operating the CU.

1. Record G03 model, serial/identity alias, firmware/version, country/Kenya
   configuration and registration evidence through the authorized operator.
   Do not record device passwords. Ask whether the device is in active business
   use and define an interruption window.
2. On the Windows host, have the administrator identify LabServer's installed
   version/build, install path, actual process/service name, account, startup
   mode, listener address/port and log location. Do not assume service name
   `ZFPLabServer` or endpoint `localhost:4444`; these are possible examples in
   existing notes, not the customer's verified values.
3. From the middleware host/service identity, verify name resolution and TCP
   reachability to the administrator-confirmed endpoint using the customer's
   approved tool. This establishes only route/listener reachability. If it
   fails, capture timestamp, source/destination aliases, port, DNS result and
   sanitized error; ask network admin to inspect routing/firewall/proxy/TLS.
   Do not change firewall rules yourself.
4. Inspect the configured `TREMOL_ADAPTER`, `TREMOL_TRANSPORT`,
   `TREMOL_BASE_URL`, and `TREMOL_TIMEOUT_MS` against current env validation.
   The configured URL must be an HTTP(S) origin without credentials/path/query;
   HTTP transport is the only implemented transport. Use the actual approved
   origin, never a guessed default. Confirm only one diagnostic client will
   address the CU at a time; local client serialization does not coordinate
   other processes or vendor tools.
5. Request a written vendor matrix for exact LabServer build, G03/firmware and
   Kenya configuration. It must state whether direct HTTP GET mode, SDK
   POST/XML mode, or both are supported; request/response envelopes and
   character encoding; command argument syntax; result code definitions;
   timeout/cancellation behavior; repeat safety; serialized access; and which
   commands are read-only. Ask for a version-matched response fixture or
   redacted trace. The supplied SDK/manual is not enough to assume dual-mode
   support.
6. If that matrix confirms the application's existing GET read path and the
   operator approves a read, configure the adapter for the verified endpoint
   and execute at most one `GET /health/device`. Source behavior is a bounded
   `ReadVersion()` query. It returns only `connected` or `unavailable`; it
   does not reveal version. Correlate it with the LabServer logs/version
   obtained separately. A timeout/error is not automatically retried.
7. If a richer read is required, do not create an endpoint or invoke a generic
   dispatcher. Use only a command already allowed by
   `TremolZfpLabServerClient` and confirmed read-only for this installation;
   any direct vendor probe must be explicitly approved, exact and bounded.
   Do not switch to POST after GET fails. A POST/XML probe is a separate
   vendor-approved change/test for that exact read command only.
8. Compare sanitized response shape, HTTP status, result code, server build
   and command timestamp. If LabServer answered but indicates device error,
   the next action is operator/vendor inspection of device connection, driver,
   serial/network configuration and logs—not fiscal readiness inference.

**Code remediation.** For a confirmed GET-contract mismatch, update only the
existing transport/client boundary in `src/infrastructure/device/`, add a
versioned redacted fixture and tests for serialization, XML root/result code,
timeouts, malformed/empty responses, nonzero result and no retry. Do not add
SDK fallback or widen the allowlist. Run the focused Tremol tests in §4.

**Acceptance.** Record server and device identifiers/versions, route source,
approved command, one observed response category, timing, and sanitized
correlation evidence. A connected response proves only that one configured
read command was answered. Fiscal readiness and mutation remain blocked until
separate vendor, policy, recovery and authorization gates pass.

### 11.5 B-05 — Uncertain receipt outcomes and safe recovery

**Problem and impact.** A process cannot atomically commit a PostgreSQL
transaction with a fiscal control unit or KRA. If the network fails after a
command may have reached the external system, neither the response nor local
state alone can establish whether an external receipt exists. A blind replay
may duplicate fiscal issuance. This is a critical blocker independent of
whether the request state machine is well tested.

**Current boundary.** Inspect `src/domain/fiscalization/status-transitions.ts`,
`fiscalization-operations.ts`, `src/application/fiscalization/fiscalization-service.ts`,
`recover-stale-fiscalizations.ts`, `stale-fiscalization-recovery-worker.ts`,
manual-review service/repositories, and corresponding unit/PG integration
tests. The code has `OutcomeUnknown`, durable attempts and stale recovery that
does not replay. Manual review stores an operator decision/evidence reference;
it does not independently query or prove device/KRA state.

1. Ask Tremol/authorized integrator for the authoritative lookup available
   after interrupted close/finalize: journal query, receipt reference, fiscal
   memory lookup, or other documented method; required operator credentials;
   retention window; exact fields matching a transaction; and vendor-approved
   handling for a command that may have executed. Ask KRA/eTIMS separately for
   its own submission lookup and resubmission semantics. These are not
   interchangeable sources.
2. Ask finance/compliance how an external device receipt is associated with
   the invoice and how discrepancy is adjudicated. A counter increase alone
   cannot identify which invoice or prove content. Obtain a named decision
   owner and secure evidence-retention location.
3. Define a state/evidence table before implementing recovery: definitely not
   sent; confirmed rejected/not executed; accepted with authoritative
   reference; request may have reached provider but no confirmation; stale
   process claim; and external lookup unavailable/ambiguous. For each state,
   specify allowed next action and who can authorize it. Do not define retry
   for the ambiguous categories without vendor/provider authority.
4. Add test scenarios in a future change using controlled adapters: known
   success; known failure before submission; timeout before send; disconnect
   after possible send; process restart while `InProgress`; result received but
   DB persistence fails; lookup confirms success; lookup confirms not found;
   lookup is unavailable/ambiguous; manual reviewer lacks evidence. Assert
   unknown outcomes are not replayed and state/audit history is durable.
5. Verify the persistence failure case explicitly: if the external result is
   known but database persistence fails, preserve the request/attempt
   correlation and use the authoritative external lookup before any further
   action. Never translate a persistence exception into confirmed external
   failure.
6. On an actual ambiguous incident, stop submissions for that invoice/device
   as defined by customer policy; preserve timestamps, request ID, attempt
   number and sanitized transport category; contact the designated device
   operator/vendor and compliance owner; use only the approved authoritative
   lookup; then record evidence and a manual-review decision. Do not issue a
   second receipt to “see if it works.”

**Acceptance.** Vendor/provider signs off a repeatable lookup and documented
interpretation; tests cover all listed branches; process recovery preserves
unknown state; the operator runbook names an owner and escalation; and a
controlled acceptance demonstrates reconciliation without duplicate
submission. Until all of these exist, no fiscal mutation is permitted.

### 11.6 B-06 — Windows deployment, topology and operational recovery

**Problem and impact.** The repository contains a Node service and graceful
shutdown handling but no Windows service installer/supervisor. Interactive
developer access does not prove the customer service identity has the same
environment, DNS, proxy, certificate trust, database or LabServer access.

1. With the Windows administrator, inventory server name/role, Windows
   edition/build, patch level, process architecture, Node and pnpm policy,
   application/LabServer placement, approved service supervisor, service
   account alias, and deployment/change window. Record no passwords.
2. Draw the actual connection path: middleware host → PostgreSQL endpoint;
   middleware host → Zoho HTTPS endpoints/proxy; middleware host → LabServer;
   and, if eventually authorized, middleware host → selected eTIMS endpoint.
   For each, record source/destination alias, protocol, configured port,
   firewall owner, DNS/TLS trust/proxy and allowed direction. Do not prescribe
   a port or ask for a firewall opening before the configured path is known.
3. Confirm how service environment variables and secrets are provisioned,
   protected and rotated. Confirm the service account can read the release and
   secret source, write only required logs/temp locations, and reach required
   dependencies. Test from the service context under supervision; do not infer
   from a developer's interactive shell.
4. Confirm service start/stop/restart and boot ordering, stdout/stderr/log
   routing and retention, monitoring, escalation, and how the previous release
   is restored. The repository's `pnpm build` creates `dist/`; runtime start is
   `node dist/server.js`. There is no in-repo Windows service wrapper.
5. Before deployment, preserve release identity and database migration state;
   ensure backup restore owner and rollback decision are named. Apply no
   customer migration without the DBA's review and approved window.
6. Start through the customer's approved supervisor. Check `/health/live`,
   `/health/ready`, `/health/integrations`, and only when authorized the
   device diagnostic endpoints. Confirm health routes are not accidentally
   exposed outside the approved network: they are registered before the
   `/integrations/zoho` bearer middleware, and device/dependency checks can
   cause read-only calls.
7. Exercise graceful stop/restart only in an approved window with no active
   operation. Confirm shutdown drains and closes dependencies. If a possibly
   external operation is in progress, do not force-stop first; capture its
   durable state and have the owner decide.

**Code remediation** is appropriate only for a reproducible process defect:
inspect `src/server.ts`, `src/app.ts`, shutdown tests and deployment logs;
add a unit test. Network/identity/configuration failures belong to IT unless
source evidence proves a code defect. Closure requires successful service
context start, database readiness, approved network checks, restart/rollback
evidence and tested restore ownership—not merely an interactive `pnpm dev`.

### 11.7 B-09 — Database safety, migrations, backup and restore

**Problem and impact.** PostgreSQL is ZohoAmarco's own persistence. It is not
the customer's Syspro database. The customer database has not been assessed
by this guide. A correct migration chain does not establish that a production
backup restores or that an upgrade is operationally safe.

1. Before any DB command, identify the connection's host, port and database
   name without displaying user/password/query values. Confirm the host is the
   expected local or customer PostgreSQL instance and database name is the
   middleware DB. If ambiguous or pointing to Syspro/customer data outside
   agreed scope, stop.
2. For local repository DB tests, follow the guards in
   `database-migrations.md`. Existing `zoho_amarco_test` is not a disposable
   fresh-install target; the historically used suffixed migration DB is
   populated and must not be reset/reused. Inspect existence and migration
   state read-only. Use a newly approved empty local database only for fresh
   install; do not drop/reset an existing DB to clear a failure.
3. For an existing environment, run only `pnpm exec prisma migrate status
--schema prisma/postgresql/schema.prisma` after confirming its target. This
   reports migration state; it does not apply migrations. Review pending
   migrations and customer backup/rollback approval before
   `pnpm exec prisma migrate deploy --schema prisma/postgresql/schema.prisma`.
   `pnpm db:validate` is schema validation, not database inspection; `pnpm
db:generate` writes the client, not database state.
4. If migration fails, preserve the exact migration name, sanitized Prisma/PG
   category, target alias, `_prisma_migrations` status and timestamp. Do not
   edit migration history, rerun destructive commands or manually alter
   partial objects. The DBA and developer should compare the migration SQL
   with the actual catalog and decide on an additive repair/forward fix.
5. With the customer DBA, document backup mechanism, owner, cadence, retention,
   encryption/access, off-host storage, recovery point objective and recovery
   time objective. Request a recent restore drill record. A “backup job green”
   is not proof of recoverability.
6. Plan restore rehearsal against a separately approved isolated target that
   cannot overwrite source or customer data. DBA performs restore with
   least-privilege procedure, validates database/schema/migration rows and
   representative synthetic/approved records, then application owner checks
   `/health/ready` and read-only repository access. Do not use Syspro as source
   or destination.
7. Record source backup reference, restore timestamp, isolated target alias,
   schema/migration result, application check, DBA owner and signoff. If no
   isolated target or restore owner exists, mark blocked; do not attempt a
   production restore rehearsal in place.

**Tests and closure.** Local migration verification historically passed on a
new dedicated suffixed database; it does not prove customer database upgrade,
backup or restore. Repository integration tests may write/delete synthetic
records; follow §4 target guards. Acceptance requires DBA-approved restore
rehearsal, migration review for the exact release, and documented rollback
owner. Never run `migrate reset`, `docker compose down -v`, or an integration
suite against an unknown URL.

### 11.8 B-07 — Production readiness and external acceptance

Track every decision with this minimum record: issue ID; precise missing
behavior; source/evidence links; responsible person/role; required permission;
dependency; action; verification command or witnessed procedure; objective
acceptance criteria; status/date; sanitized evidence reference; rollback/stop
condition. “Developer to investigate” is not an owner or an acceptance
criterion.

Use separate gates, in order:

1. **Local software gate:** typechecks, lint/format, unit/contract tests,
   build, OpenAPI and schema checks pass for the reviewed revision; DB tests
   use isolated targets. This establishes software behavior for covered cases.
2. **Zoho tenant gate:** administrator confirms organization/data center/user;
   exact approved invoice GET and mapping succeed; if writeback is in scope,
   separately approve UPDATE scope, fields and a controlled writeback/recovery
   test. Read-only access does not require write permission.
3. **Device gate:** identify CU and LabServer versions; vendor confirms
   exact transport/commands; authorized read-only command succeeds; no
   unsupported fallback. This still is not fiscal readiness.
4. **eTIMS gate:** compliance establishes OSCU/VSCU model/enrollment,
   versioned contract and authorized test environment; provider acceptance and
   authoritative lookup/recovery pass.
5. **Workflow/recovery gate:** policy owners approve mapping, taxes, payments,
   ordering and uncertain-outcome action; code tests and controlled acceptance
   establish these cases without blind replay.
6. **Deployment/restore gate:** customer IT and DBA verify service identity,
   network, monitoring, backup restore, upgrade/rollback and incident response.
7. **Transaction/customer gate:** transaction-specific written approval,
   designated operator and stop authority, approved invoice/device, witnessed
   external results and reconciliation; customer and compliance acceptance in
   writing.

Do not call the system production-ready for fiscal issuance while any critical
contract, sender, sequence, recovery, authorization or compliance gate is
open. If an external party cannot supply evidence, leave the status blocked
and continue only independent local work.

## 12. Troubleshooting decision trees

Use the decision paths as “check, classify, then act.” Do not repeat external
operations to see whether an intermittent error disappears.

### Application or health failure

1. **Does the process start?** If no, capture sanitized startup error and
   revision; check `src/config/env.ts`, required setting names, paired Zoho
   credential rules and local DB URL shape. Fix only a named invalid setting.
   If configuration validates but startup fails, inspect `src/server.ts` and
   the first initialization error; do not print `.env`.
2. **Does `/health/live` return 200?** If no, inspect listener host/port,
   process exit and startup logs. This is application/process reachability,
   not dependency health.
3. **Does `/health/ready` return 503?** Verify DB host/database alias, DNS,
   credentials provisioned through secure channel, TLS and pool timeout. If
   connect succeeds but schema is wrong, inspect migration status read-only and
   involve DBA; do not auto-migrate/reset.
4. **Does `/health/integrations` show blocked/unconfigured?** This reports
   configuration and code gates, not an external test. Follow the relevant
   Zoho, Tremol or eTIMS playbook. Do not change a gate simply to clear the
   status.
5. **Does `/health/dependencies` or `/health/device` fail?** Confirm the read
   diagnostic was approved, then separate endpoint reachability, LabServer
   response and device response with administrator/vendor evidence. The
   endpoint does not prove fiscal readiness.

### Database connection or migration failure

1. Re-identify host/database safely. If not a confirmed isolated local target,
   stop. 2. Check PostgreSQL process, network/TLS and role access with DBA. 3.
   Use `migrate status` to inspect; do not reset. 4. If a migration is
   partially applied, preserve migration name and catalog evidence and ask
   DBA/developer to review a forward repair. 5. Use a fresh separately named
   empty DB only for fresh-install verification. Relevant files:
   `prisma/postgresql/schema.prisma`, migration SQL,
   `src/infrastructure/database/postgresql-fiscalization-repository.ts`,
   `tests/integration/postgresql-migrations.integration.test.ts` and
   `docs/database-migrations.md`.

### Zoho authentication, 404, throttle, or malformed response

1. If OAuth fails, compare Accounts data center, exact registered callback,
   OAuth app owner, token validity and READ scope. Only the Zoho admin should
   change grants; never ask for the token. Inspect
   `src/application/zoho/zoho-oauth-service.ts` and unit OAuth tests.
2. If invoice GET is 404, follow §11.3: verify organization and exact invoice
   with the tenant admin before changing region or ID. Capture whether this is
   an upstream status, documented provider code, or application classification.
3. For 401/403 investigate token vs permissions; for 429 inspect bounded
   retry/`Retry-After` result and pause scheduled import if needed; for 5xx or
   network timeout preserve the correlation/time and wait for owner decision.
   Do not manually repeat through a different tenant or client.
4. For malformed data, keep a minimized fixture with sensitive values
   replaced; test response validation and mapper. Relevant tests:
   `zoho-books-client.test.ts`, `zoho-books-routes.test.ts`,
   `zoho-invoice-mapper.test.ts`, and OAuth tests. No live requests are needed
   to correct deterministic parser defects.

### LabServer and CU diagnostics

1. If the endpoint cannot be reached, verify configured origin and actual
   listener with Windows/network admin; diagnose DNS, route, firewall, proxy,
   TLS and service account context. Do not guess port or restart service
   without approval.
2. If HTTP responds but device check is unavailable, inspect LabServer logs,
   CU power/connection, driver/serial/network settings and device operator
   display. Escalate vendor-specific codes; do not treat HTTP 200 as device
   communication.
3. If a bounded read times out or XML/result is unexpected, stop after the
   single attempt. Preserve timestamp, command, HTTP/result category and
   correlation ID; ask vendor to compare with installed-version contract. Do
   not switch GET to POST, use generic SDK dispatch, or retry automatically.
4. If device output indicates busy/not-ready, the authorized operator decides
   whether normal business use is active. Do not clear, close, or alter device
   state as a diagnostic.

### eTIMS/provider error

1. Determine selected OSCU/VSCU model from approved customer evidence; do not
   infer from URL. 2. Confirm current adapter still reports non-operational and
   submission closed. 3. Classify config/auth/schema/provider rejection versus
   timeout after possible send; for the latter, mark unknown and do not resubmit. 4. Obtain provider reference/lookup through the verified official process;
   current reconciliation is not verified. Escalate schema/enrollment to KRA
   support/compliance and protocol defects to the developer. Use
   `kra-protocol-clients.test.ts`, mapping tests and `etims-reporting.test.ts`
   for local fixture cases only.

### Pending request or possible receipt

1. Read durable request, attempts, claim time, current status and correlation
   evidence using the authorized read route. 2. If `OutcomeUnknown`, stale
   `InProgress`, or a response persistence error follows a possible send,
   suspend any new submission for that invoice per policy. 3. Ask device or
   provider owner to perform the authoritative lookup defined in §11.5. 4.
   Record external evidence and a manual-review decision. Do not create a
   second request or reset state to `Pending` to force processing.

### Local tests pass but office acceptance fails

1. Freeze the exact build/revision and test case. 2. Compare environment,
   tenant/device/provider versions, identity, network, clock and configuration
   without exposing secrets. 3. Classify the first boundary that diverges:
   authentication, mapping, transport, server response, device state, provider
   acceptance, persistence or business policy. 4. Preserve a sanitized fixture
   and ask the owning admin/vendor to confirm the external contract. 5. Make a
   minimal source change only if evidence identifies a software defect; add a
   regression test and rerun focused and release checks. If evidence is
   insufficient, mark blocked rather than guessing.

## 13. Evidence register: what closes a claim

Use a dated, revision-linked register. The current state is summarized in §9;
this table defines the minimum evidence for changing that state.

| Capability                     | Sufficient evidence                                                                                                                     | Insufficient evidence                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Local source/build             | Revision identifier, exact successful command output, tool versions, reviewed diff.                                                     | Historical report without current command output.         |
| Unit/contract behavior         | Test names/counts and fixtures tied to reviewed source.                                                                                 | Mock success described as provider compatibility.         |
| PostgreSQL integration         | Safe target alias, preflight target proof, test command/result, cleanup outcome.                                                        | Client generation/schema validation alone.                |
| Fresh-install migrations       | Newly approved empty DB alias, preflight existence check, applied migration count/history and schema assertion.                         | Reusing dev/test DB or merely `db:validate`.              |
| Zoho retrieval                 | Intended organization/region, exact approved invoice alias, current successful GET, sanitized provider category and mapping outcome.    | OAuth success, previous reported 404, or mocked response. |
| LabServer                      | Installed build and actual endpoint/path, approved request, bounded result and server logs correlated by time.                          | Open TCP port or HTTP root response.                      |
| Physical CU compatibility      | Device identity/firmware/configuration, vendor-supported contract, authorized read result from that device.                             | SDK source or simulator.                                  |
| KRA/eTIMS                      | Confirmed model/enrollment, contract version, authorized sandbox result, provider reference and reconciliation evidence.                | Unit tests or configured URL.                             |
| Receipt sender                 | Reviewed implementation, contract fixtures, identified device acceptance and authoritative receipt metadata.                            | “Command sent,” HTTP 200, or a proposal plan.             |
| Uncertain outcome recovery     | Vendor/provider-authored lookup semantics plus witnessed success/failure/timeout/restart/reconciliation cases.                          | Receipt counter movement or manual operator note alone.   |
| Customer deployment            | Approved service identity, startup/readiness, network, restart/rollback and monitoring evidence.                                        | Developer shell works.                                    |
| Backup/restore                 | DBA-owned isolated restore rehearsal with time, target, integrity checks and application read check.                                    | Backup job success alone.                                 |
| Authorization                  | Dated written scope, named approver/operator, action, environment and time window.                                                      | General “finish integration” request.                     |
| End-to-end/customer acceptance | Same transaction trace across Books, middleware, CU and applicable eTIMS, reconciled by responsible parties, written customer decision. | Any partial subsystem result or simulated workflow.       |

Keep evidence in the customer-approved location. Sanitize tokens, secrets,
device passwords, invoice/customer personal data, raw payloads and connection
strings before any report leaves the customer environment.

## 14. Office visit agenda and interview prompts

The [office acceptance runbook](customer-office-acceptance-runbook.md) is the
offline printable checklist and detailed phase procedure. Use this section as
the technical agenda; record answers in its worksheet/action register.

| Role / ask exactly                                                                                                                                                                | Why and evidence to request                                                                                                        | If unresolved                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Sponsor/finance: “Which invoice/payment/tax scenarios are in scope, and who can authorize and stop a specific test?”                                                              | Obtain signed scope, approved invoice alias, expected result, finance policy for tax/discount/payment/currency and stop authority. | Do no provider mutation or fiscal work; finance/compliance owner must decide policy.                                                |
| Zoho admin: “What are the exact organization ID, Books data center, authorized integration user, granted read scope, and invoice ID you verified in that organization?”           | Confirms tenant/API domain/user/visibility without secrets; ask admin to inspect the invoice rather than send full contents.       | Hold read verification; resolve with Zoho admin before any invoice GET.                                                             |
| Windows/network admin: “Which host runs the middleware and LabServer, and from which service identity can the configured route be reached?”                                       | Collect host/build, process/version, account alias, actual listener, DNS/firewall/proxy/TLS route and log owner.                   | No guessed endpoint or firewall change; admin supplies topology and approved access.                                                |
| DBA: “Which PostgreSQL database belongs to ZohoAmarco, what role is assigned, and when was this backup last restored in isolation?”                                               | Establish target separation from Syspro, least privilege, migrations, backup and restore evidence.                                 | No migration or integration test until target and recovery owner are confirmed.                                                     |
| Device operator/Tremol: “What exact G03/LabServer versions are installed, which read commands are approved, and how do you authoritatively find a receipt after a lost response?” | Obtain version-matched transport/command/result/repeat and recovery contract.                                                      | Do not issue device commands beyond approved read-only acceptance; receipt mutation remains blocked.                                |
| Compliance/KRA contact: “Which eTIMS model and enrollment apply, what official test environment and contract version are approved, and who confirms legal acceptance?”            | Establish OSCU/VSCU applicability, schema, ordering, reconciliation and acceptance authority.                                      | Keep reporting disabled; request documented answer from responsible authority.                                                      |
| Change approver: “For this build, which exact read-only actions are approved today, for what window, and who can stop them?”                                                      | Dated transaction-specific boundary and escalation.                                                                                | Observe only; written authorization is required for live reads where customer policy requires it, and separately for each mutation. |

### Required visit order

1. **Pre-arrival:** pass local release checks; review B-01–B-09; confirm
   appointments, roles, read-only scope, known invoice alias, host access,
   rollback owner and evidence location. Bring offline runbook. Keep all
   fiscal/eTIMS/writeback actions disabled.
2. **Arrival/authorization:** confirm each person’s role and stop authority;
   obtain written scope and maintenance window; write down prohibited actions.
   If scope is only observation, make no live calls.
3. **Host baseline:** verify Windows/build, service context, network route,
   database target alias and migration status, logs and clock. Do not change
   firewall, service or DB without named approval. Verify process/DB health
   using health checks; distinguish those from integrations.
4. **Zoho read:** confirm tenant/data center/org/integration user/read scope and
   exact invoice in that tenant; only then, and only if explicitly approved,
   use the guarded verifier against its dedicated DB. Diagnose the historical
   404 using §11.3. Do not write back or enumerate invoices.
5. **LabServer/CU identification:** collect versions/configuration and confirm
   topology with admins. Compare against vendor contract. A reachable listener
   does not pass the device gate.
6. **One approved device read:** if the exact GET contract and operation are
   approved, call `/health/device` at most once. It reports connected or
   unavailable and does not disclose version. Correlate server logs. Stop on
   timeout/unexpected response; no automatic retry and no transport switch.
7. **eTIMS review:** inspect enrollment/model/contract evidence only. No
   production submission. Use sandbox only if the implementation supports it
   and the customer has explicitly authorized the environment and test.
8. **Closeout:** review each evidence row with owner, label pass/fail/blocked/
   not tested, assign action and due date, record customer decision. Do not
   leave any uncertain receipt as “failed” merely to close the ticket.

No physical fiscal test is currently executable through the production
Tremol adapter. The customer visit can collect the missing contract and
environment evidence, but cannot make the current `RECEIPT_ISSUANCE_BLOCKED`
path pass by configuration alone.

## 15. Remediation decision table

| Symptom                                 | First responsible boundary                           | Evidence and source/tests                                                                       | Stop/escalate when                                                                  |
| --------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Environment/startup error               | Developer/config owner                               | Sanitized invalid key/category; `src/config/env.ts`; `env.test.ts`.                             | Required secret unavailable or target ambiguous: stop and use secure provisioning.  |
| PostgreSQL unavailable/schema mismatch  | DBA + developer                                      | Safe host/database alias; readiness result; migration status; PostgreSQL repository tests.      | Target might be Syspro/customer DB or migration partially applied.                  |
| Zoho OAuth fails                        | Zoho admin + developer                               | Accounts/API region, callback, READ grant; OAuth route/service tests.                           | Token/secret requested in insecure channel or tenant unknown.                       |
| Zoho organization/data center mismatch  | Zoho admin                                           | Organization ID alias, Accounts domain, token API domain; `accounts-domain`/`api-domain` tests. | No authorized tenant confirmation.                                                  |
| Zoho invoice 404                        | Zoho admin + developer                               | Exact approved ID/org; upstream status/code category; `books-client` and route tests.           | Bare 404 or no tenant access; cause remains unresolved.                             |
| Zoho 401/403, 429, 5xx                  | Zoho admin for auth/permission; developer for client | Sanitized status/code/time/correlation; `zoho-books-client.test.ts`.                            | Persistent provider failure or retry bound exhausted. Do not expand scopes blindly. |
| Invoice mapping rejection               | Finance + developer                                  | Field-level presence/value comparison with minimization; mapper and preparation tests.          | Tax/payment/customer policy ambiguous. Never invent default fiscal values.          |
| Duplicate registration/concurrent claim | Developer/DBA                                        | Organization+invoice key, request ID/status/attempts; registration/repository/workflow tests.   | Existing request may be external/unknown; do not create alternate ID.               |
| `OutcomeUnknown`                        | Operator + vendor/compliance                         | Attempt timeline, external authoritative lookup; recovery/manual-review tests.                  | No reliable lookup: prohibit replay and escalate.                                   |
| LabServer unreachable                   | Windows/network admin                                | Actual endpoint, DNS, TCP route, service logs; client/transport tests.                          | Port or firewall unknown; do not guess/change.                                      |
| HTTP/XML parse error                    | Developer + Tremol                                   | Sanitized status/result/root/field shape; transport/client tests.                               | Installed response contract not version-confirmed.                                  |
| CU unavailable/busy/unexpected status   | Operator + Tremol                                    | Device state, connection/driver facts, sanitized server logs; diagnostic tests.                 | Device is in active use or code semantics unknown. Stop.                            |
| Device timeout                          | Operator + Tremol                                    | Single command/time/correlation and uncertainty; transport tests.                               | Any possible mutation: no retry, invoke authoritative recovery.                     |
| Unexpected receipt result               | Developer + Tremol + finance                         | Sanitized response metadata and transaction trace.                                              | Receipt outcome cannot be authoritatively reconciled.                               |
| eTIMS auth/schema/timeout               | Compliance/KRA + developer                           | Selected model, contract version, response category; KRA mapping/client tests.                  | Timeout after possible send or enrollment unknown: no resubmission.                 |
| Windows service-only network failure    | Windows/network admin                                | Compare service vs interactive identity, proxy/cert/DNS/firewall; startup/shutdown tests.       | Elevation/access policy unclear; do not bypass.                                     |
| Health says blocked/unconfigured        | Developer + integration owner                        | `/health/integrations`, sanitized config status, adapter readiness source.                      | Do not toggle gate; follow the matching blocker playbook.                           |

## 16. Targeted code-change procedure for a future verified defect

When the visit produces an actionable discrepancy, use this sequence. It is
not authorization to change production during an acceptance window.

1. Preserve the pre-existing branch/worktree and identify the exact revision.
2. Reproduce with the smallest local test or sanitized provider/device fixture.
3. Identify the responsible boundary from the lifecycle table in §1; check
   adjacent contract and evidence documents.
4. For provider-specific behavior, obtain authoritative version-matched
   evidence before changing serialization or semantics. If absent, stop at a
   documented blocker.
5. Make a focused source edit using the repository's ordinary reviewed editor
   workflow. Never generate/overwrite source with a shell script. Do not edit
   production gates to exercise a path.
6. Add a regression test that fails before the fix. Preserve decimal lexemes,
   immutable snapshots, uniqueness and atomic claims, durable attempt
   history, redaction, bounded timeouts, serialized device access, and
   `OutcomeUnknown` no-replay behavior.
7. Run the narrow test, then the appropriate typechecks/lint/format/build and
   complete suite. Use only confirmed isolated databases for DB tests. Review
   scripts for external effects before running them.
8. Review `git status --short --branch`, staged/unstaged diff and all untracked
   files. Confirm no secrets, generated output, unrelated work, relaxed tests,
   or altered safety gates were introduced.
9. Record source evidence, change rationale, test output, external limitations,
   rollback/forward-fix plan, approver and deployment revision.
10. If a possible fiscal operation occurred during any later authorized
    acceptance, stop implementation/testing actions on that transaction until
    the external outcome is authoritatively reconciled.

Focused commands are in §4 and names are verified against the current test
tree. A test passing proves the covered application branch only; it never
promotes a mocked provider, installed device, or compliance status.

## 17. Readiness decision

Readiness is staged, not a single green build:

- **Ready for local development:** required toolchain and local environment
  validate; tests/build work; no external effects are configured accidentally.
- **Ready for customer read-only visit:** local release checks pass, host and
  database target are known, written visit scope exists, the intended Zoho
  invoice and LabServer endpoint are confirmed, and the operator approves any
  exact read probe. This status authorizes only those reads.
- **Ready for controlled fiscal acceptance:** additionally, receipt command
  contract/sender, applicable eTIMS contract, mapping/policy, external outcome
  lookup, recovery procedure, test invoice/device, transaction-specific
  authorization and compliance acceptance criteria are all established and
  reviewed. The current receipt path is blocked, so this stage is not
  available from the present build.
- **Ready for production fiscal use:** controlled acceptance evidence is
  signed by the customer and responsible compliance authority; deployment,
  restore, monitoring, support and rollback owners are active; release gates
  are reviewed. This guide does not establish that status.

If a required criterion is unknown, label it `BLOCKED` or `NOT TESTED`, name
the decision owner and the next evidence-bearing action. Do not use a
percentage or a successful lower-stage check to imply readiness for a higher
stage.
