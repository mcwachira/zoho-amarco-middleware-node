# Database migrations and integration tests

## SQL Server

The SQL Server migration sequence now starts with
`prisma/sqlserver/migrations/20261024081742_init`, which creates the
fiscalization request, OAuth attempt, and Zoho token tables. Later migrations
add fiscal customer/item profiles and fiscalization snapshots. The initial
migration uses conditional table and index creation so it can fill in missing
baseline objects when a database already has a later migration recorded; it
does not drop or rewrite existing tables.
The forward migration `20261027110000_align_sqlserver_datetime_precision`
aligns timestamps to the `DATETIME2` precision implied by the Prisma schema,
including profile timestamps that the original SQL Server profile migration
created at millisecond precision.

For a fresh installation, provision an empty database, configure the
application's SQL Server connection settings, and run:

```sh
PRISMA_SCHEMA=prisma/sqlserver/schema.prisma \
PRISMA_MIGRATIONS_PATH=prisma/sqlserver/migrations \
DATABASE_URL='sqlserver://localhost:1433;database=YOUR_DATABASE;user=YOUR_USER;password=YOUR_PASSWORD;encrypt=true;trustServerCertificate=true' \
pnpm exec prisma migrate deploy
```

Use the customer's approved certificate settings rather than trusting a
certificate in production. Never point migration commands at a production or
customer database without the normal deployment approval and backup process.

SQL Server integration tests are opt-in. They require
`RUN_SQLSERVER_INTEGRATION=1`, `SQLSERVER_TEST_SERVER=localhost` (or loopback),
`SQLSERVER_TEST_DATABASE=zoho_amarco_sqlserver_test` (or a lowercase
alphanumeric-suffixed variant),
`SQLSERVER_TEST_USER`, and `SQLSERVER_TEST_PASSWORD`. The test verifies that
the target database has no user tables before applying migrations. It then
tests the created schema and removes only rows associated with its generated
test identifiers. It does not drop the database or migration history. Provision
a new empty dedicated test database with a new suffix before repeating the
fresh-install test.

## Provider-specific behavior

Prisma models currently have no SQL Server `rowversion` field. Processing
claims instead use an atomic conditional update from `Pending` to `InProgress`;
the affected-row count is the concurrency decision. `updatedAt` is an
application-managed `DATETIME2` timestamp, not a rowversion token.

PostgreSQL uses its normal case-sensitive text comparison by default. SQL
Server string uniqueness and equality follow the database/column collation,
which is commonly case-insensitive. The Prisma schema does not declare a
cross-provider collation, so Zoho identifiers that differ only by letter case
may have different uniqueness behavior between installations. Choose and
document the SQL Server database collation for the deployment; do not assume
case-sensitive equivalence.

## PostgreSQL integration tests

Fiscalization repository integration tests require
`RUN_POSTGRES_INTEGRATION=1` and the explicitly configured
`ZOHO_FISCALIZATION_TEST_DATABASE_URL`. It must point to `zoho_amarco_test` on
localhost port `5438`. OAuth integration tests use
`RUN_POSTGRES_OAUTH_INTEGRATION=1` and
`ZOHO_OAUTH_TEST_DATABASE_URL`, also restricted to that local test database.
These tests delete only rows they created. Neither integration suite falls
back to the application `DATABASE_URL`.
