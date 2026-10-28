# Operations and deployment guide

This repository can build and run the API in a customer-managed Node.js
environment. It does not include a production installer, device SDK, Windows
service wrapper, backup agent, or customer-specific secret manager. Provision
those through the customer's approved IT process.

## Configuration reference

Values are parsed at startup by `src/config/env.ts`. Secrets must be supplied
through a protected environment/secret store and must never be placed in source
control or support bundles.

Startup validation reports setting names with sanitized guidance; rejected
environment values and secrets are not included in the error text. Production
requires distinct invoice and operator bearer tokens. Zoho and fiscal providers
remain optional when their features are disabled. Configuring Zoho writeback
fields requires the Zoho client ID/secret, OAuth encryption key, and organization
ID; OAuth requests then include the locally represented invoice `READ` and
`UPDATE` scopes. Zoho custom-field IDs are tenant-specific and must be supplied
from that tenant's configuration.

| Variable                                    | Default / allowed values    | Purpose and validation                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                  | `development`               | `development`, `test`, or `production`.                                                                                                                                                                            |
| `HOST`                                      | `127.0.0.1`                 | HTTP bind host. Keep loopback unless an approved local proxy/network boundary is configured.                                                                                                                       |
| `PORT`                                      | `3000`                      | TCP port, 1–65535.                                                                                                                                                                                                 |
| `API_RATE_LIMIT_WINDOW_MS`                  | `60000`                     | Fixed-window limit duration on `/integrations/zoho`, 1,000–3,600,000 ms.                                                                                                                                           |
| `API_RATE_LIMIT_MAX_REQUESTS`               | `120`                       | Maximum integration requests per client IP and window, 1–100,000.                                                                                                                                                  |
| `DEPENDENCY_HEALTH_TIMEOUT_MS`              | `2000`                      | 100–30,000 ms deadline for dependency diagnostics. A timeout reports unavailable; it does not imply an external operation failed.                                                                                  |
| `SHUTDOWN_TIMEOUT_MS`                       | `30000`                     | 1,000–120,000 ms graceful HTTP drain deadline. Expiry closes remaining HTTP connections and allows uncertainty-safe recovery to persist.                                                                           |
| `LOG_LEVEL`                                 | `info`                      | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. Do not enable verbose logging around customer data without review.                                                                                   |
| `DATABASE_PROVIDER`                         | `postgresql`                | Must be `postgresql`; middleware persistence uses PostgreSQL.                                                                                                                                                      |
| `DATABASE_URL`                              | none                        | Required PostgreSQL connection URL.                                                                                                                                                                                |
| `POSTGRES_CONNECT_TIMEOUT_MS`               | `5000`                      | PostgreSQL `pg` pool connection/acquire bound, 100–120,000 ms. Applies when creating a database connection; independent of HTTP readiness timeout.                                                                 |
| `POSTGRES_STATEMENT_TIMEOUT_MS`             | `30000`                     | PostgreSQL server-side statement timeout, 100–120,000 ms. PostgreSQL cancels a statement that exceeds this bound; this does not bound application work outside SQL or guarantee transaction outcome.               |
| `INVOICE_API_BEARER_TOKEN`                  | none                        | At least 32 characters; required in production. Use a cryptographically random secret and rotate via a controlled process.                                                                                         |
| `OPERATOR_API_BEARER_TOKEN`                 | none                        | Legacy shared operator identity; at least 32 characters. Use either this or `OPERATOR_API_CREDENTIALS_JSON`.                                                                                                       |
| `OPERATOR_API_CREDENTIALS_JSON`             | none                        | Optional JSON array of named operator credentials. Production requires this or the legacy token. Subjects become audit labels; tokens must be unique, at least 32 characters, and distinct from the service token. |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`      | unset                       | Configure together. Secret is protected as a secret.                                                                                                                                                               |
| `ZOHO_OAUTH_ENCRYPTION_KEY`                 | unset                       | Required with OAuth credentials; exactly 32 random bytes encoded as 64 hexadecimal characters. Protect and back up through an approved key process: loss makes persisted Zoho tokens unreadable.                   |
| `ZOHO_ORGANIZATION_ID`                      | unset                       | Required to enable invoice retrieval/import; must match the connected tenant.                                                                                                                                      |
| `ZOHO_REDIRECT_URI`                         | loopback HTTP callback      | Must exactly match the OAuth app registration. Production requires HTTPS except loopback testing.                                                                                                                  |
| `ZOHO_ACCOUNTS_URL`                         | `https://accounts.zoho.com` | HTTPS origin on the supported Zoho Accounts domain allowlist. Select the tenant's data center.                                                                                                                     |
| `ZOHO_SYNC_ENABLED`                         | `false`                     | Enables scheduled invoice import only when credentials and organization are configured.                                                                                                                            |
| `ZOHO_SYNC_INTERVAL_MS`                     | `900000`                    | 60,000–86,400,000 ms. This is a full-catalog scan, not an incremental change feed.                                                                                                                                 |
| `ZOHO_SYNC_PAGE_SIZE`                       | `200`                       | 1–200 invoices requested per Zoho Books page. Applies to manual and scheduled full scans.                                                                                                                          |
| `ZOHO_SYNC_MAX_PAGES`                       | `1000`                      | 1–1,000 pages per full scan. Hitting the bound marks pagination incomplete and prevents a successful full-scan checkpoint.                                                                                         |
| `ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON`  | unset                       | Optional strict mapping to numeric Zoho invoice custom-field IDs created in the tenant. Enables only operator-triggered writeback and requires `ZohoBooks.invoices.UPDATE`; it does not enable fiscalization.      |
| `TREMOL_ADAPTER`                            | `disabled`                  | `disabled` or `zfplabserver_readonly`. The latter opts in to the ZFP Lab Server read-only diagnostic path only; it never enables receipt issuance.                                                                 |
| `TREMOL_TRANSPORT`                          | `http`                      | Only `http` is implemented, using the ZFP Lab Server HTTP interface. Unsupported values fail configuration validation.                                                                                             |
| `TREMOL_BASE_URL`                           | `http://127.0.0.1:4444`     | ZFP Lab Server origin; no credentials/path/query/hash allowed. Remote production endpoints must use HTTPS. The endpoint is contacted only when the adapter is explicitly selected.                                 |
| `TREMOL_TIMEOUT_MS`                         | `5000`                      | 100–120,000 ms request timeout. Timeout aborts the client request but cannot establish whether a remote command was received; the transport makes no retries.                                                      |
| `ETIMS_REPORTING_ENABLED`                   | `false`                     | Must remain false in production until provider, enrollment, payload, lifecycle, and legal sequence are verified. When enabled outside production, one selected adapter and its matching settings are required.     |
| `ETIMS_RECONCILIATION_ENABLED`              | `false`                     | Explicit scheduler opt-in; also requires reporting, an explicit adapter, a 32-byte payload key, and a verified operational reconciliation capability.                                                              |
| `ETIMS_PAYLOAD_ENCRYPTION_KEY`              | unset                       | Single-key compatibility setting; inject 32 random bytes as 64 hex characters from a secret manager. Do not combine with the keyring setting.                                                                      |
| `ETIMS_PAYLOAD_ENCRYPTION_KEY_ID`           | `legacy-v1`                 | Identifier for the single-key setting; key IDs are authenticated for new records.                                                                                                                                  |
| `ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON`     | unset                       | Optional JSON map of retained key IDs to 64-character hex keys from a secret manager. Maximum 20 keys; never put real keys in files or logs.                                                                       |
| `ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID`    | `legacy-v1`                 | Required map member when a keyring is configured; new ciphertext uses it while retained IDs decrypt older payloads.                                                                                                |
| `ETIMS_ADAPTER`                             | unset                       | Optional explicit model: `vscu` or `oscu`; selection does not enable or verify it.                                                                                                                                 |
| `ETIMS_OSCU_ENVIRONMENT`                    | unset                       | `sandbox` or `production`; required with enabled `ETIMS_ADAPTER=oscu`. The client pins the selected official origin and never fails over between environments.                                                     |
| `ETIMS_VSCU_BASE_URL`                       | unset                       | Local installed KRA VSCU service URL; required with enabled `ETIMS_ADAPTER=vscu`. It configures a client only; the application does not install or start the VSCU JAR.                                             |
| `ETIMS_PROVIDER_TIMEOUT_MS`                 | `15000`                     | 100–120,000 ms bound for provider requests. A timeout after possible transmission is an uncertain outcome; it does not authorize resubmission.                                                                     |
| `ETIMS_RECONCILIATION_INTERVAL_MS`          | `300000`                    | 10,000–86,400,000 ms polling interval for a configured reconciliation worker.                                                                                                                                      |
| `ETIMS_RECONCILIATION_BATCH_SIZE`           | `10`                        | 1–100 durable outstanding operations considered per poll.                                                                                                                                                          |
| `ETIMS_RECONCILIATION_MAX_ATTEMPTS`         | `5`                         | 1–20 provider reconciliation lookups per operation; submissions are never retried by this worker.                                                                                                                  |
| `ETIMS_RECONCILIATION_OPERATION_TIMEOUT_MS` | `15000`                     | 1,000–120,000 ms per provider lookup; a timeout remains uncertain and is eligible only for later reconciliation.                                                                                                   |
| `ETIMS_RECONCILIATION_MAX_RUNTIME_MS`       | `120000`                    | 10,000–1,800,000 ms maximum batch runtime; shutdown and this deadline abort active lookups into an uncertain recorded result.                                                                                      |
| `ETIMS_RECONCILIATION_STALE_AGE_MS`         | `1800000`                   | 30,000–86,400,000 ms before an abandoned reconciliation claim is recovered as unresolved.                                                                                                                          |
| `FISCALIZATION_RECOVERY_ENABLED`            | `false`                     | Marks stale in-progress device requests unknown; never retries them.                                                                                                                                               |
| `FISCALIZATION_RECOVERY_INTERVAL_MS`        | `300000`                    | Positive integer interval.                                                                                                                                                                                         |
| `FISCALIZATION_RECOVERY_STALE_AGE_MS`       | `1800000`                   | Positive integer age. Choose above normal operation duration.                                                                                                                                                      |
| `FISCALIZATION_SIMULATION_ENABLED`          | `false`                     | Explicit local-only mode; rejected in production. Requires encrypted eTIMS payload storage. It does not represent real device or KRA acceptance.                                                                   |
| `FISCALIZATION_SIMULATED_DEVICE_SCENARIO`   | `success`                   | Deterministic `success`, `failure`, `timeout`, `uncertain`, `exception`, or `unavailable` result; only read when simulation is enabled.                                                                            |
| `FISCALIZATION_SIMULATED_ETIMS_SCENARIO`    | `accepted`                  | Deterministic `accepted`, `rejected`, `timeout`, `uncertain`, `exception`, or `unavailable` result; accepted responses have no provider reference.                                                                 |
| `FISCALIZATION_SIMULATED_SEQUENCE`          | `device_then_etims`         | Explicit local-only stage order: `device_then_etims` or `etims_then_device`. No production sequence is selected by this setting.                                                                                   |

For the local PostgreSQL setup, authenticated intake, profile preparation, the
mapped execute request, deterministic scenarios, response fields, and status
checks, follow the [simulated vertical workflow runbook](fiscalization-orchestration.md#local-simulated-vertical-workflow).

### Zoho Books fiscalization result writeback

Read-only invoice intake needs `ZohoBooks.invoices.READ`. Optional writeback is separate: it requires tenant-created invoice custom fields, the explicit `ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON` mapping above, and an OAuth grant with `ZohoBooks.invoices.READ` and `ZohoBooks.invoices.UPDATE`. Do not deploy sample IDs: obtain each ID from the target organization's Zoho Books custom-field configuration. When the mapping is absent, the writeback routes are unavailable and OAuth remains read-only. Code support does not authorize writeback; include the UPDATE permission only when the customer explicitly approves writeback in scope.

An operator with `invoice:writeback` may POST `/integrations/zoho/fiscalization-requests/{requestId}/zoho-writeback`; no request body is accepted. An identity with `request:read` may GET the same path for durable status. The service derives values only from persisted successful, authoritative, non-simulated device and eTIMS outcomes. It updates configured custom fields only; it does not change invoice totals, taxes, payment state, or customer identity and does not call KRA or Tremol. The Zoho update uses a bounded 10-second request and at most two bounded retries for explicit HTTP 429 responses, respecting `Retry-After` only within the configured delay limit. Network, 5xx, malformed-response, and other outcomes are not automatically retried.

If a PUT response is lost or times out, the operation remains uncertain. Following lease expiry, recovery reads the invoice and compares all configured field IDs and expected string values. A complete match marks writeback successful; missing or unreadable values remain in `manual_review`. The service never blindly replays an uncertain update. This does not change the original fiscalization outcome or establish exclusive ownership of fields against edits by another actor. A definitive error with no prior custom-field write is terminal `failed`; partially completed updates become uncertain for review. The success status marker is written last.

### Read-only Zoho tenant verification

`pnpm verify:zoho:live` runs an opt-in compatibility check using the existing encrypted OAuth token, OAuth refresh lifecycle, Books v3 client, and invoice mapper. It is disabled unless `ZOHO_LIVE_VERIFY=1` and also requires `NODE_ENV` other than production. It uses the isolated PostgreSQL database named `zoho_amarco_zoho_live_test`; set `ZOHO_LIVE_VERIFY_DATABASE_URL` explicitly when needed, or it derives that database URL from a loopback PostgreSQL `DATABASE_URL` by replacing only its database name. It never falls back to the application database. The dedicated database must have current migrations and an authorized Zoho token. The explicit opt-in authorizes GET-only inspection of the configured invoice; it does not establish that the organization or invoice is non-production. Verify tenant and invoice safety separately. A due refresh may update that token row through the normal lease-protected OAuth refresh implementation.

The opt-in authorizes **read-only inspection of the exact invoice ID configured in `ZOHO_LIVE_TEST_INVOICE_ID`**. It does not establish that the Zoho organization or invoice is non-production. Verify the tenant and invoice designation separately before opting in. The verifier requires configured `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_OAUTH_ENCRYPTION_KEY`, `ZOHO_ORGANIZATION_ID`, and a supported `ZOHO_ACCOUNTS_URL` (the existing environment default applies when unset). It requires the existing invoice ID but does not require or create a custom marker field. The ID uses the same bounded opaque identifier format accepted by the Zoho Books client. The token API domain must match the configured Accounts data center, and the grant must contain `ZohoBooks.invoices.READ`; no update scope is needed for this GET-only check. If writeback mappings are configured, their custom-field IDs and values are inspected when present in the invoice response.

The verifier performs OAuth token retrieval/normal refresh, one invoice GET, response/custom-field shape checks when fields are returned, and local mapper validation. It does not enumerate pages or perform invoice PUT, create, delete, or organization-setting operations. Output contains operation names, a random correlation ID, data-center host, and safe result categories only. It never prints provider response bodies, invoice content, tokens, or customer data. This is not a fiscalization or writeback test: live invoice mutation and fiscalization-result writeback remain outside this verifier and require the existing separately guarded workflow.

The repository contains no primary response artifact for the historical Zoho
invoice request. A prior written report says the configured invoice GET
returned HTTP 404 after OAuth decryption, read-scope, and data-center checks;
the underlying response/log is not retained, so the event is reported rather
than independently verifiable here. It does not prove which organization was
intended, that the invoice is absent, or why the request returned 404.

### Database timeout behavior

The checked-out lockfile installs Prisma ORM and the PostgreSQL driver adapter
at 7.10.1. PostgreSQL uses `@prisma/adapter-pg` 7.10.1 over `pg` 8.23.1. Its
`connectionTimeoutMillis` bounds pool connection acquisition/creation; its
`statement_timeout` is a PostgreSQL server setting, so the server cancels an
individual statement exceeding the configured duration. This is different from
the `pg` client-side `query_timeout`, which is not used here. A cancelled
statement can leave an enclosing transaction needing rollback; callers must
handle the resulting error normally.

These options follow the [Prisma v7 connection-pool documentation](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/connection-pool) and [node-postgres client options](https://node-postgres.com/apis/client).

All four settings are positive integer milliseconds bounded to 100–120,000 at
startup. Values over 120 seconds or below 100 ms are rejected. These driver
limits complement rather than replace the five-second HTTP readiness-response
bound. That HTTP timeout still does not abort an in-flight Prisma operation.
Database timeout behavior has not been runtime-tested against PostgreSQL in this documentation update.

Receipt issuance has no production environment toggle and is not wired into
production configuration. The adapter's safe default remains disabled. The
simulator is imported only by tests.

### Zoho token refresh across instances

Access-token refreshes use a conditional database lease on the singleton
`ZohoToken` row. The lease expires after 30 seconds if a process exits; a
competing request waits and rereads the token for up to 35 seconds. The refresh
response is persisted only if the caller still owns the lease. If ownership is
lost, the caller uses a newer valid stored token when available or returns a
safe retryable error. This coordinates processes using the same database; it
does not replace monitoring of database availability or external Zoho
credentials.

## Build and controlled installation

1. Install the repository-pinned Node.js 24+ and pnpm version using the
   organization's approved software distribution process.
2. Check out the reviewed release source and run `pnpm install --frozen-lockfile`.
3. Supply PostgreSQL settings for the application's own database. This is
   separate from the customer's Syspro database; ZohoAmarco does not connect
   to Syspro. Provision a new
   database and apply migrations using the reviewed procedure in
   [database-migrations.md](database-migrations.md). Back up existing data
   before upgrades and verify migration history first.
4. Run `pnpm db:generate`, `pnpm db:validate`, and `pnpm build`.
5. Validate production config in a protected deployment environment. Confirm
   `ETIMS_REPORTING_ENABLED=false`, no device issuer is injected, and the API
   bind/proxy/firewall boundary is approved.
6. Start with `pnpm start` under an unprivileged service account with read/write
   access only to the application database and required logs.
7. Configure the service supervisor to restart on failure and forward graceful
   termination. The app handles SIGINT/SIGTERM, stops workers, closes HTTP, and
   disconnects the database on orderly shutdown.

### Linux

Use the customer's systemd or equivalent process supervisor. Set `WorkingDirectory`
to the versioned release directory, run `node dist/server.js` as a dedicated
unprivileged user, and load secrets from a root-readable environment file or
secret manager. Keep the API bound to loopback behind an approved TLS reverse
proxy. Do not run the API as root or expose the ZFP Lab Server port to untrusted
networks.

### Windows

Run the service on the Windows host that has the vendor-approved ZFP Lab Server
and drivers installed. Use the customer's approved Windows service supervisor
or Task Scheduler configuration to launch `node dist/server.js` from the
release directory under a dedicated service account. Confirm that stop events
are delivered gracefully, the account can reach the local server, and Windows
Firewall restricts the API and Lab Server to approved local callers. Do not
copy, redistribute, or install vendor SDK binaries from this repository; their
license and supported versions must come from the vendor/customer.

For KRA eTIMS, OSCU and VSCU are separate transports. The optional
`ETIMS_VSCU_BASE_URL` only identifies a locally installed KRA VSCU service;
this application does not start or install the official JAR. `ETIMS_ADAPTER`
does not enable reporting by itself. If reporting is explicitly enabled outside
production, startup requires the selected adapter's own settings and rejects
settings for the other mode. The current clients remain unverified/blocked. See
[KRA protocol client setup](kra-protocol-clients.md)
for environment selection, route evidence, and sandbox prerequisites.

## Startup and health verification

- `/health/live` reports only that the HTTP process responds.
- `/health/ready` checks database connectivity and returns `not_ready` after a
  bounded 5-second probe rather than leaving the readiness request open. A
  timeout fails readiness closed; the HTTP timeout itself does not cancel the
  underlying database driver operation. Database connection and command bounds
  are separately configured by the settings above. Liveness remains independent
  of database state.
- `/health/dependencies` performs bounded database and read-only device checks.
  Optional Zoho/eTIMS providers are reported as configured but unverified; no
  health request retrieves or modifies invoices or submits fiscal data.
- `/health/integrations` reports configured, blocked, and disabled integrations
  without secrets or fiscal payloads. A configured or connected status is not
  a contract or hardware verification result. Its eTIMS section distinguishes
  provider health from scheduler enabled/started/reason state; job health
  reports last execution, last confirmed reconciliation, consecutive failures,
  and active batch count.
- The current HTTP contract is documented in [openapi.yaml](openapi.yaml).
- `/health/device` performs the configured read-only connection diagnostic; a
  connected status does not establish fiscal readiness or receipt support. The
  probe is bounded by `DEPENDENCY_HEALTH_TIMEOUT_MS`.
- Inspect startup logs for environment, bind host, port, and database provider.
  The application does not log secrets or complete database URLs.
- Request correlation IDs accept 1–128 ASCII letters, digits, `.`, `_`, `:`, or
  `-`. Missing, malformed, duplicated, and oversized values are replaced with a
  cryptographically random UUID. The accepted/generated value is returned in
  `X-Correlation-ID` and included in structured request/application logs.
  HTTP clients forward the same header on outbound Zoho, KRA/eTIMS, and
  read-only Tremol diagnostic requests; providers may ignore it.
- Shutdown stops accepting new HTTP requests and stops background scheduling
  immediately. In-flight work has up to `SHUTDOWN_TIMEOUT_MS` to drain; pending
  external outcomes remain subject to the existing uncertain-outcome recovery.
- Configure distinct `INVOICE_API_BEARER_TOKEN` (service identity) and
  `OPERATOR_API_BEARER_TOKEN` (legacy shared operator identity) or
  `OPERATOR_API_CREDENTIALS_JSON` (named identities with explicit permissions).
  Prefer one credential per operator and grant only needed permissions. Current
  Zoho routes require `invoice:read` at their shared router boundary. Named
  subjects are persisted in reconciliation audit records; caller-supplied headers
  cannot change identity. The service
  token can read invoice/request status and register requests; the operator
  token additionally manages fiscal profiles and can request device processing
  or eTIMS reconciliation. Role headers are ignored. Rotate these shared
  secrets through the deployment secret store; this is a static local identity
  boundary, not an identity provider or per-user authorization system.
- `/integrations/zoho/operations/metrics` requires operator authorization.
- Metrics are in-process, bounded, and low-cardinality: HTTP status and latency
  buckets, fiscal/device/eTIMS outcomes, Zoho writeback, manual-review actions,
  database/dependency checks, adapter timeouts, and worker health. They contain
  no invoice/customer/receipt identifiers and reset on process restart. Export
  or scrape them through an approved deployment layer if durable monitoring is
  required.
- Confirm protected routes reject missing/invalid credentials and return 403
  when an authenticated identity lacks permission.

### eTIMS reconciliation operations

The scheduler is off by default. To request it outside production, set
`ETIMS_REPORTING_ENABLED=true`, `ETIMS_RECONCILIATION_ENABLED=true`, select an
explicit `ETIMS_ADAPTER`, and inject `ETIMS_PAYLOAD_ENCRYPTION_KEY` from the
deployment secret manager. Startup starts the existing worker only if the
selected provider reports an operational, contract-verified reconciliation
capability and the encrypted payload store is available. With the current
unverified adapters it reports an unavailable reason and makes no provider
calls. Production eTIMS reporting remains rejected by startup configuration
until the legal and provider gates are reviewed in code.

The first poll occurs after the configured interval. Each batch is bounded to
100 records and `ETIMS_RECONCILIATION_MAX_RUNTIME_MS`; each provider lookup has
its own bounded timeout. Attempts use
exponential backoff from 30 seconds up to 30 minutes, capped by
`ETIMS_RECONCILIATION_MAX_ATTEMPTS`. Shutdown aborts an active lookup and waits
for its uncertain result to be recorded before database disconnect. The worker
does not submit invoices or issue fiscal receipts. Durable compare-and-set
claims coordinate replicas; a process-local guard prevents duplicate schedulers
inside one process.

The original canonical JSON supplied to a verified submission adapter is
limited to 256 KiB and encrypted with AES-256-GCM. A cryptographically random
96-bit nonce is generated for each encryption. New protection-version 2
ciphertexts authenticate payload schema version, operation, request, digest,
submission attempt, protection version, and key ID as additional authenticated
data. Protection-version 1 rows retain their original AAD interpretation and
default to key ID `legacy-v1`, preserving decryption across the additive schema
change. Payload insertion and attempt claim share one database transaction.
Reconciliation checks the GCM tag, strict UTF-8, version, association, size, and
SHA-256 digest before calling the provider. No automatic deletion or redaction
occurs because that would discard audit/recovery evidence.

For rotation, inject a keyring containing old and new keys through
`ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON`, set
`ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID` to the new ID, and deploy. New writes
use that key; old IDs remain available to decrypt existing rows. Keep each old
key until its rows pass approved retention and reconciliation requirements.
There is no KMS, automatic re-encryption, or managed rotation in this
application. Remove old keys only after a separately approved migration or
retention decision. A missing key leaves the row safely blocked. Back up keys
securely and enforce an operational volume limit per key because random GCM
nonce uniqueness is probabilistic.

For a missing or corrupt payload, do not reconstruct from its digest or
resubmit the invoice. Check the operation ID, attempt, migration state, and
secret-manager key version, preserve the row, and route it to authorized manual
review. `/health/integrations` and operator metrics distinguish scheduler state
from actual provider health. A successful scheduler run does not prove KRA was
queried or accepted an invoice.

During rollback, retain the new table and encrypted payloads. The previous
application can ignore the additive table; do not delete payload or attempt
evidence. Restore application and database from a coordinated backup if the
previous binary cannot tolerate the deployed schema.

ZohoAmarco now uses PostgreSQL as its only persistence provider. Removing the SQL Server adapter also removes the Tedious, Azure Identity, and MSAL dependency chain that introduced the advisory; see [dependency security](dependency-security.md) for the fresh audit result.

- Integration API requests are limited per client IP in-process. For multiple
  service replicas, enforce an equivalent or stricter limit at the trusted
  reverse proxy; Express proxy trust is not enabled by default, so arbitrary
  `Forwarded` and `X-Forwarded-For` headers are not used to determine the client.
  The limiter keys the address string returned by Express/Node without explicit
  IPv4-mapped-IPv6 canonicalization, so equivalent address spellings can receive
  separate buckets. It applies one shared quota to all Zoho integration routes
  and emits `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and
  `Retry-After` on throttling.
  The fixed-window map is bounded at 10,000 active keys, removes expired entries
  when capacity is reached, and returns 503 if still full. All Zoho integration
  The limiter runs before JSON parsing. It does not
  coordinate across multiple application processes.
- Confirm device issuance and eTIMS reporting remain blocked and that no live
  test fiscal record was sent.

## Backup, restore, and upgrade

- Use database-native, customer-approved backups with encryption and retention
  controls. No automatic backup utility is included.
- The examples below use PostgreSQL's `pg_dump`, `pg_restore`, and `createdb`
  tools. They are run by the authorized DBA from an approved management host,
  not by the middleware. Replace every bracketed value. Provision credentials
  through the approved PostgreSQL password file/secret process so no password
  appears in a command line, shell history, or report.

  ```powershell
  pg_dump --format=custom --no-owner --file <protected-backup-file> `
    --host <approved-postgresql-host> --port <approved-port> `
    --username <backup-role> --dbname <zohoamarco-database>
  pg_restore --list <protected-backup-file>
  ```

  `pg_dump` reads the named database and writes a custom-format backup;
  `pg_restore --list` inspects the archive without changing a database. Before
  a real restore drill, have the DBA create a new isolated empty database and
  restore there. Never use `--clean` or restore over development, integration,
  production, or customer data as a test. Record the archive checksum, storage
  location, encryption/retention reference, restore target alias, and result in
  the approved change record. The repository has no provisioning or backup
  script and these examples do not certify a customer's restore readiness.

- Protect `ZOHO_OAUTH_ENCRYPTION_KEY` with the same recovery rigor as the
  database backup; restoring encrypted tokens without the key is not sufficient.
- Test database restore and application restart in an isolated environment.
  Verify request IDs, snapshots, device attempts, eTIMS operations, and attempt
  histories after restoration.
- Apply only additive migrations after reviewing the exact target and migration
  history. The relational-constraint migration aborts when it detects orphaned
  eTIMS references. Stop for data review; do not drop tables or delete rows as a
  shortcut.
- Roll back application binaries only when their schema compatibility has been
  confirmed. There is no automatic down migration; prepare a tested restore plan
  before applying schema changes.

## Troubleshooting and diagnostic handling

Collect release version, Node version, database provider, health responses,
request correlation IDs, operation/request IDs, stage statuses, sanitized
attempt error categories, and timestamps. Do not collect bearer tokens, OAuth
tokens, secrets, connection strings, raw invoice payloads, PINs, or full provider
responses. No automated support-bundle generator is included.

If a device or eTIMS operation is uncertain, preserve its attempt history and
operation identifier. Use the external provider's verified reconciliation
procedure and record an operator decision; never retry because a response was
lost or the service restarted.

## Deployment limitations

`pnpm audit:deps` is a release gate. The optional SQL Server persistence provider and its driver dependency chain were removed because PostgreSQL is the documented middleware database. Check the current audit output before release; removing these packages does not substitute for reviewing any other dependency advisories.

The included `compose.yaml` is for local development database services, not a
production topology. There is no production Docker image, Windows installer,
external metrics exporter, automated backup, or shared multi-process rate-limit
store. In-process metrics are low-cardinality and volatile across restarts.
The privileged operator uses a configured shared token rather than a per-user
identity provider. Manual-review cases and decisions are persisted with an
append-only sequence and atomic decision-number compare-and-set. Production does
not configure an evidence verifier, so a claimed success/failure is stored as
invalid evidence and the case remains open. Verified review decisions do not
alter the device/eTIMS operation state or trigger another external call; any
state change beyond the case audit requires a separately reviewed invariant.
Complete
customer infrastructure, security review, hardware, legal, and provider
acceptance before production use.

# Operator reconciliation

Use the `manual-review:decide` permission (configured operator bearer token)
for reconciliation endpoints. Open a case only for a persisted uncertain device
or eTIMS operation. `GET /integrations/zoho/manual-review?limit=50&offset=0`
lists unresolved cases; `GET /integrations/zoho/fiscalization-requests/{id}/manual-review`
and `GET /integrations/zoho/manual-review/{caseId}` return case history.
`POST /integrations/zoho/manual-review/{caseId}/decisions` accepts
`confirmed_success`, `confirmed_failure`, `still_unknown`, `escalated`, and
`investigation_note`, each with a reason and optional evidence reference.

Success/failure requires a reference in a safe HTTPS URL form (without user
info, query, or fragment) or a bounded external record identifier. Those
outcomes are explicitly operator-attested. Notes, escalation, unknown results,
and malformed evidence leave the case unresolved. Reconciliation never
reissues a device receipt, submits to KRA/eTIMS, changes the original
fiscalization result, or establishes Zoho writeback eligibility. Never put
credentials, access tokens, or sensitive provider payloads in evidence
references or notes.
