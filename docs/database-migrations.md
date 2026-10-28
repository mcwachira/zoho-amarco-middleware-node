# Database migrations and integration tests

## Supported provider

ZohoAmarco persistence uses PostgreSQL. The customer Syspro database is external business-system storage and is not a ZohoAmarco persistence target; this repository has no Syspro connector. Prisma schema and migration selection are fixed to `prisma/postgresql/` in `prisma.config.ts`.

## PostgreSQL integration tests

Fresh-install migration verification is separate from the repository tests.
It requires `RUN_POSTGRES_MIGRATION_INTEGRATION=1` and
`ZOHO_POSTGRES_MIGRATION_TEST_DATABASE_URL` pointing to an explicitly
provisioned empty database at `localhost:5438` named
`zoho_amarco_migration_test` or a lowercase alphanumeric suffix with optional
underscore-separated segments.
The test checks the target contains no base tables before running the full
PostgreSQL migration chain, then verifies the expected fiscalization, eTIMS,
manual-review, and Zoho tables exist. It does not drop the database or remove
migration history. Use a new empty dedicated database for each fresh-install
migration run.

Fresh-install verification completed locally on 2026-10-28 against the newly
created database `zoho_amarco_migration_test_fresh_20261028` on the existing
loopback PostgreSQL server. All 18 migrations applied; the migration integration
assertions passed and `prisma migrate status` reported the schema up to date.
The existing `zoho_amarco_dev`, `zoho_amarco_test`, and pre-existing
`zoho_amarco_migration_test` databases were not reset or migrated for this
fresh-install run. This is local migration evidence, not customer deployment
verification.

Fiscalization repository integration tests require
`RUN_POSTGRES_INTEGRATION=1` and the explicitly configured
`ZOHO_FISCALIZATION_TEST_DATABASE_URL`. It must point to `zoho_amarco_test` on
localhost port `5438`. OAuth integration tests use
`RUN_POSTGRES_OAUTH_INTEGRATION=1` and
`ZOHO_OAUTH_TEST_DATABASE_URL`, also restricted to that local test database.
These tests delete only rows they created. Neither integration suite falls
back to the application `DATABASE_URL`.

Run the repository integration tests from PowerShell after the two explicit
test URLs have been provisioned in the approved local environment and checked
to point to `zoho_amarco_test` on loopback port `5438`:

```powershell
$env:RUN_POSTGRES_INTEGRATION = "1"
$env:RUN_POSTGRES_OAUTH_INTEGRATION = "1"
pnpm exec vitest run tests/integration/postgresql-fiscalization-repository.integration.test.ts tests/integration/postgresql-zoho-token-repository.integration.test.ts tests/integration/postgresql-zoho-oauth-attempt.integration.test.ts
Remove-Item Env:RUN_POSTGRES_INTEGRATION
Remove-Item Env:RUN_POSTGRES_OAUTH_INTEGRATION
```

The flag names are run controls, not secrets. The database URLs must be
provisioned as `ZOHO_FISCALIZATION_TEST_DATABASE_URL` and
`ZOHO_OAUTH_TEST_DATABASE_URL` in the process environment or local `.env`; do
not paste their values into commands or logs. The tests are scoped to their
designated test database and clean up only rows they create.

For a **newly provisioned empty** migration-test database, configure
`ZOHO_POSTGRES_MIGRATION_TEST_DATABASE_URL` in the protected local environment
and run:

```powershell
$env:RUN_POSTGRES_MIGRATION_INTEGRATION = "1"
pnpm exec vitest run tests/integration/postgresql-migrations.integration.test.ts
Remove-Item Env:RUN_POSTGRES_MIGRATION_INTEGRATION
```

This test applies migrations and creates the schema in the supplied database.
It refuses non-loopback hosts, port `5438`, names outside
`zoho_amarco_migration_test` plus its allowed suffixes, and databases with
public base tables. Use a new suffix for each fresh-install run; the existing
development, repository-test, and already-populated migration-test databases
are not fresh-install targets. Never use `migrate reset`.

The PostgreSQL fiscalization integration suite does not apply migrations. It
requires the dedicated database to be at the migration state being tested.
For upgrade verification, provision a disposable database from the documented
prior migration state, set the test URL only after checking its host, port, and
database name, then run `pnpm exec prisma migrate deploy --schema
prisma/postgresql/schema.prisma` with `PRISMA_MIGRATIONS_PATH` pointed at the
PostgreSQL migration directory before enabling the integration flag. Never
configure `DATABASE_URL` as a fallback for this test suite.

The PostgreSQL suite includes synthetic eTIMS persistence/restart assertions
in addition to device claim/recovery checks. Its synthetic adapters are local to
the tests and do not call KRA.

Migration `20261027190000_add_history_indexes` adds `(createdAt, id)` and
`(status, createdAt, id)` indexes for stable descending history pages. It is
additive and does not rewrite fiscalization rows. eTIMS status/correlation
filters use the existing unique request relationship and operation indexes.

Migration `20261027200000_add_manual_review_audit` adds durable review cases and
append-only sequenced decisions with unique request/operation and case/sequence
constraints. Its foreign keys restrict deletion of requests with review history.
The database stores review outcomes separately and does not alter the original
device or eTIMS state. Confirmations are explicitly operator-attested and
require a bounded external evidence reference; they do not claim provider
verification.

Migration `20261027210000_add_etims_submission_payload` adds a versioned,
encrypted payload table with restrictive relationships to its eTIMS operation,
fiscalization request, and exact submission attempt. The application persists
the ciphertext atomically with the submission claim. The row contains ciphertext
and a SHA-256 digest; the encryption key is configured separately through the
deployment secret manager. Legacy operations have no payload row and remain
blocked from scheduled reconciliation. Never reconstruct payloads from a
digest or delete payload rows as migration cleanup.

Migration `20261027220000_version_etims_payload_protection` adds key ID and
protection-format metadata. Existing ciphertext receives protection version 1
and key ID `legacy-v1`, preserving its original AES-GCM additional-authenticated
data format. New writes use version 2 and bind the key ID and protection version
in AAD. The migration is additive; do not edit or squash it after deployment.

Migration `20261027230000_add_zoho_refresh_lease` adds a nullable lease owner
and expiration to the singleton Zoho token row, plus a constraint requiring
both fields to be null or both populated. OAuth refresh claims use a single
conditional update; refreshed credentials are saved only if the saving process
still owns that lease. Expired leases can be claimed after a process crash.
The migration does not alter encrypted token values.

Migration `20261027240000_add_kra_reference_sync_state` adds one durable
diagnostic row per KRA provider, adapter identity, taxpayer, branch, and
reference category. It records the latest attempt and correlation ID. Provider
timestamps/cursors, active version, and successful-sync time remain nullable;
current OSCU/VSCU specifications do not establish safe cursor advancement or
complete-result semantics for all reference categories. No migration is run
automatically by application startup.

Migration `20261027250000_add_zoho_fiscalization_writeback` adds persisted
outcome provenance, the simulated marker on eTIMS operations, and one durable
Zoho writeback operation per fiscalization request. It records only target
invoice/organization identity, a payload digest, correlation ID, custom-field
progress, status, and lease timestamps; it does not archive OAuth credentials
or invoice contents. PostgreSQL uses a unique request key to
arbitrate concurrent starts. Uncertain writes remain recoverable by Zoho invoice
readback and are not replayed. Apply through the PostgreSQL migration process; application startup does not run migrations automatically.
Migration `20261027260000_extend_operator_reconciliation` expands the bounded
operator decision vocabulary for investigation notes and escalation and stores
evidence-backed decisions as `operator_attested`. Reconciliation history remains
separate from the fiscalization outcome. Apply it to the PostgreSQL database
before enabling the operator endpoints.
