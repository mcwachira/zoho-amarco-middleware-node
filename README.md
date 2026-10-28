# Zoho Amarco Middleware

**A fiscalization middleware connecting Zoho Books with a Tremol G03 fiscal device and Kenya's KRA/eTIMS ecosystem.**

> **Project status: Hardware-independent application and persistence foundations are implemented; live receipt issuance and KRA submission remain blocked pending verified contracts and acceptance.**
>
> The current codebase includes fiscalization preparation and orchestration services, separate device/eTIMS state machines and attempt histories, PostgreSQL schema/migrations, Zoho OAuth and read-only Books retrieval, profile management, and health diagnostics. The combined workflow remains fail-closed. See the [implementation inventory](docs/implementation-inventory.md), [orchestration notes](docs/fiscalization-orchestration.md), and [external acceptance checklist](docs/external-acceptance.md) for verified software behavior and remaining contract work.

## Table of Contents

- [Overview](#overview)
- [Project Status](#project-status)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Environment Configuration](#environment-configuration)
- [Database Setup](#database-setup)
- [Running the Application](#running-the-application)
- [API and Health Checks](#api-and-health-checks)
- [Fiscalization Workflow](#fiscalization-workflow)
- [Testing and Quality Checks](#testing-and-quality-checks)
- [Device Integration](#device-integration)
- [Tremol G03 Kenya Protocol Status](docs/tremol-g03-kenya-protocol-status.md)
- [Implementation Inventory](docs/implementation-inventory.md)
- [Integration Contract Evidence](docs/integration-contract-evidence.md)
- [OpenAPI Reference](docs/openapi.yaml)
- [External Acceptance Checklist](docs/external-acceptance.md)
- [eTIMS Integration Status](docs/etims-integration-status.md)
- [KRA OSCU/VSCU Protocol Clients](docs/kra-protocol-clients.md)
- [Database Migrations](docs/database-migrations.md)
- [Operations and Deployment](docs/operations-and-deployment.md)
- [Developer Handover and Customer Acceptance](docs/developer-handover.md)
- [Customer Access Request Checklist](docs/customer-access-request-checklist.md)
- [Customer Office Acceptance Runbook](docs/customer-office-acceptance-runbook.md)
- [Zoho Books Integration Roadmap](#zoho-books-integration-roadmap)
- [Security and Reliability](#security-and-reliability)
- [Git Workflow](#git-workflow)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Overview

Preparing for an installation or customer visit? Start with the
[developer handover](docs/developer-handover.md), collect approvals using the
[customer access checklist](docs/customer-access-request-checklist.md), then
follow the [offline office acceptance runbook](docs/customer-office-acceptance-runbook.md).
The current verified and unverified boundaries are listed in the
[implementation inventory](docs/implementation-inventory.md).

Zoho Amarco Middleware is a TypeScript and Node.js service intended to bridge Zoho Books invoicing with fiscal receipt issuance through a Tremol G03 fiscal control unit, while supporting the applicable Kenyan KRA/eTIMS requirements.

The middleware is designed to run on a customer's Windows or Linux server, depending on the final deployment and device connectivity requirements. It provides an integration foundation between cloud-based accounting software, locally accessible fiscal hardware, and persistent records of processing outcomes.

### Goals

- Retrieve and validate invoice information from Zoho Books.
- Prevent duplicate fiscalization of the same Zoho invoice.
- Track fiscalization requests and their processing states.
- Coordinate invoice processing with a locally accessible fiscal device.
- Persist receipt identifiers and processing outcomes.
- Use PostgreSQL for ZohoAmarco persistence.
- Handle device failures and uncertain outcomes without blindly repeating receipt issuance.
- Provide structured logging, health checks, automated tests, and a maintainable foundation for production deployment.
- Integrate with the applicable KRA/eTIMS requirements after the required APIs and compliance obligations have been verified.

## Project Status

| Capability                                        | Status                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| TypeScript application foundation and Express API | Implemented                                                                         |
| Health and readiness endpoints                    | Implemented                                                                         |
| Fiscalization domain and application service      | Implemented; receipt issuance remains disabled and live fiscalization unverified    |
| PostgreSQL repository and integration tests       | Implemented; runtime integration tests require an isolated local test database      |
| PostgreSQL Prisma schema and migrations           | Implemented                                                                         |
| PostgreSQL Docker Compose development setup       | Implemented                                                                         |
| Zoho OAuth authorization and callback flow        | Implemented; requires configuration and live-environment verification               |
| OAuth state handling and PKCE verifier protection | Implemented                                                                         |
| OAuth token exchange and persistence              | Implemented; production security and recovery still require validation              |
| Zoho Books invoice retrieval                      | Implemented; requires valid credentials, organization configuration, and API access |
| Paginated Zoho invoice import into pending queue  | Implemented; mock-tested, requires isolated live Zoho verification                  |
| Read-only invoice-to-fiscal-candidate mapping     | Implemented and unit-tested                                                         |
| Invoice/payment evidence and fiscal preparation   | Implemented; payment lookup failure blocks registration; eligibility policy pending |
| Device/eTIMS attempt and recovery state           | Implemented; provider runtime tests not yet verified                                |
| Combined device/eTIMS production workflow         | Deliberately blocked until legal sequence and provider contracts are verified       |
| Verified Tremol G03 receipt issuance              | Pending device, SDK, firmware, and Kenya-specific protocol verification             |
| KRA/eTIMS integration                             | Pending verification of the applicable API and compliance requirements              |
| Production deployment and operational hardening   | Pending                                                                             |

**Important:** Implemented application code does not automatically mean that an external integration has been verified against a live service or physical device. The Zoho integration requires live testing. Real fiscal receipt issuance and KRA/eTIMS submission are not yet confirmed.

## Architecture

The project separates business rules from database and external-system implementations.

The Zoho integration is read-only. The API can prepare and register fiscalization requests, expose their separate device/eTIMS histories, and invoke the device stage through the existing service; production issuance is blocked because no device is injected. The orchestration can coordinate both stages only when a verified legal sequence policy is provided, and the production server does not provide one.

```text
Zoho Books
    |
    | OAuth 2.0 and read-only Invoice API
    v
Express API
    |
    +---- Zoho OAuth Routes
    |         |
    |         +---- OAuth Service
    |                    |
    |                    +---- Token Exchange
    |                    +---- Protected OAuth State / PKCE Data
    |
    +---- Zoho Books Invoice Routes
              |
              +---- Zoho Invoice Service
                        |
                        +---- Invoice Mapper
                                  |
                                  +---- Read-only Fiscal Candidate

Fiscalization Application Foundation
    |
    +---- Fiscalization Service
              |
              +---- Fiscalization Repository
              |          |
              |          +---- PostgreSQL
              |          |
              |
              +---- Fiscal Device Interface
                         |
                         +---- Tremol ZFP Lab Server Client Foundation

KRA/eTIMS Integration
    |
    +---- Pending verified API contracts and compliance requirements
```

### Current integration boundary

The Zoho invoice endpoints support individual retrieval, read-only fiscal-candidate mapping, and paginated import into the pending fiscalization-request queue. Preparation and registration persist snapshots and independent device/eTIMS state. The service layer also has stage-level orchestration and reconciliation paths; production issuance remains blocked because the server does not inject a device, and combined production processing remains blocked pending the verified legal sequence and external contracts. Neither a simulated device result nor a mock eTIMS result is production fiscal evidence.

### Source layout

The following is a high-level layout of the main modules. Individual files and test names may evolve as development continues.

```text
src/
├── app.ts
├── server.ts
├── config/
│   └── env.ts
├── routes/
│   ├── zoho-oauth-routes.ts
│   └── zoho-books-routes.ts
├── observability/
│   └── logger.ts
├── domain/
│   └── fiscalization/
│       ├── fiscalization-errors.ts
│       ├── fiscalization-operations.ts
│       ├── fiscalization-record.ts
│       ├── status-transitions.ts
│       └── status.ts
├── application/
│   ├── fiscalization/
│   │   ├── fiscal-device.ts
│   │   ├── fiscalization-errors.ts
│   │   ├── fiscalization-repository.ts
│   │   └── fiscalization-service.ts
│   └── zoho/
│       ├── zoho-oauth-service.ts
│       ├── zoho-invoice-service.ts
│       └── zoho-invoice-mapper.ts
└── infrastructure/
    ├── database/
    │   ├── fiscalization-record-mapper.ts
    │   ├── fiscalization-repository-provider.ts
    │   ├── postgresql-client.ts
    │   ├── postgresql-fiscalization-repository.ts
    ├── device/
    │   └── tremol-zfplabserver-client.ts
    └── integrations/
        └── zoho/
            └── books-client.ts

prisma/
├── postgresql/
│   ├── schema.prisma
│   └── migrations/
    └── schema.prisma

tests/
├── integrations/
└── unit/
```

Treat this as a guide to the module organization, not an exhaustive inventory of every file. Check the repository when looking for a specific module or test.

### Layer responsibilities

**Domain**

Defines fiscalization records, statuses, allowed state transitions, and domain operations. It should not depend on Express, Prisma, Zoho SDKs, or device-specific implementations.

**Application**

Coordinates application use cases through interfaces for persistence and device operations. It determines how fiscalization requests progress and how failures or uncertain outcomes are represented.

**Infrastructure**

Implements persistence and external-system adapters, including PostgreSQL repositories, Zoho Books API access, and the current Tremol client foundation.

**API and server**

`src/app.ts` configures the Express application and HTTP middleware. `src/server.ts` initializes runtime dependencies and manages server startup and shutdown. Route modules expose the available HTTP endpoints.

## Technology Stack

- Node.js and TypeScript
- pnpm
- Express
- Zod for environment validation
- Prisma ORM
- PostgreSQL adapter
- Docker Compose for local PostgreSQL
- Vitest and Supertest for automated testing
- ESLint and Prettier
- Pino and Pino HTTP for structured logging

## Prerequisites

Install the following before starting development:

- Node.js compatible with the project's TypeScript configuration
- The pnpm version specified by `package.json`
- Git
- Docker Engine and the Docker Compose plugin for the PostgreSQL development setup
- Access to a PostgreSQL instance
- A code editor such as Zed or JetBrains Rider

Check your installed tools:

```bash
node --version
pnpm --version
git --version
docker --version
docker compose version
```

Use the `packageManager` field in `package.json` as the source of truth for the intended pnpm version.

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/mcwachira/zoho-amarco-middleware-node.git
cd zoho-amarco-middleware-node
```

### 2. Select the development branch

```bash
git switch dev
git pull --ff-only origin dev
```

Create a feature branch for your work rather than committing integration changes directly to `dev` or `main`.

If your local clone does not yet have a `dev` branch or the remote branch is unavailable, inspect the repository's actual branches before proceeding.

### 3. Install dependencies

```bash
pnpm install --frozen-lockfile
```

### 4. Configure environment variables

Create a local `.env` file in the project root. Use the [Environment Configuration](#environment-configuration) section as a starting point and provide your own local database credentials.

Never commit `.env` or paste its contents into issues, pull requests, or logs.

### 5. Start the database

For PostgreSQL, follow the [Database Setup](#database-setup) section.

### 6. Validate and generate the Prisma client

```bash
pnpm db:validate
pnpm db:generate
```

### 7. Run checks and start development

```bash
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm format:check
pnpm build
pnpm vitest run
pnpm dev
```

These commands assume the corresponding scripts exist in the current `package.json`. Use the project's actual scripts if they change.

## Environment Configuration

The application validates its environment through `src/config/env.ts` at startup.
Validation failures identify the setting and a safe explanation without echoing
the rejected value. Production requires distinct invoice and operator bearer
tokens; optional providers may remain unconfigured while disabled.

### General settings

| Variable                    | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `NODE_ENV`                  | Runtime environment: `development`, `test`, or `production`    |
| `HOST`                      | HTTP bind host; defaults to loopback `127.0.0.1`               |
| `PORT`                      | HTTP port; defaults to `3000`                                  |
| `LOG_LEVEL`                 | Logging threshold; defaults to `info`                          |
| `INVOICE_API_BEARER_TOKEN`  | Shared bearer token for protected APIs; required in production |
| `OPERATOR_API_BEARER_TOKEN` | Distinct operator bearer token; required in production         |
| `DATABASE_PROVIDER`         | Must be `postgresql`; defaults to `postgresql`                 |
| `DATABASE_URL`              | PostgreSQL connection URL and Prisma datasource URL            |

### PostgreSQL settings

The Docker Compose configuration uses the following variables:

| Variable            | Purpose                        |
| ------------------- | ------------------------------ |
| `POSTGRES_USER`     | Local PostgreSQL username      |
| `POSTGRES_PASSWORD` | Local PostgreSQL password      |
| `POSTGRES_DB`       | Local PostgreSQL database name |

`DATABASE_URL` must also be set for the application and Prisma commands that need to connect to PostgreSQL.

### Zoho Books OAuth settings

The application supports a Zoho Books OAuth authorization flow and invoice retrieval. Invoice updates are disabled unless explicit custom-field mappings are configured.

| Variable                                   | Purpose                                                                                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZOHO_CLIENT_ID`                           | Client ID from the Zoho API Console. Must be configured with the client secret to enable OAuth.                                                                                                         |
| `ZOHO_CLIENT_SECRET`                       | Client secret from the Zoho API Console. Must be supplied together with the client ID.                                                                                                                  |
| `ZOHO_OAUTH_ENCRYPTION_KEY`                | A 32-byte encryption key represented as exactly 64 hexadecimal characters. Required to initialize the OAuth service and protect stored PKCE verifier data.                                              |
| `ZOHO_ORGANIZATION_ID`                     | Zoho Books organization ID. Required for invoice retrieval and invoice mapping.                                                                                                                         |
| `ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON` | Optional strict JSON mapping from fiscalization values to custom-field IDs created in the configured Zoho organization. Requires OAuth credentials, organization ID, and the Zoho invoice UPDATE scope. |
| `ZOHO_SYNC_ENABLED`                        | Enables scheduled full-catalog invoice synchronization; defaults to `false`.                                                                                                                            |
| `ZOHO_SYNC_INTERVAL_MS`                    | Schedule interval in milliseconds, from 60,000 to 86,400,000; defaults to 900,000.                                                                                                                      |
| `ZOHO_SYNC_PAGE_SIZE`                      | Invoices per page, from 1 to 200; defaults to 200.                                                                                                                                                      |
| `ZOHO_SYNC_MAX_PAGES`                      | Maximum pages per full scan, from 1 to 1,000; defaults to 1,000.                                                                                                                                        |
| `ZOHO_REDIRECT_URI`                        | OAuth callback URI registered in the Zoho API Console. Defaults to `http://localhost:3000/integrations/zoho/callback`.                                                                                  |
| `ZOHO_ACCOUNTS_URL`                        | Zoho Accounts authorization server URL for the organization's data center. Defaults to `https://accounts.zoho.com`.                                                                                     |

The OAuth service is initialized only when `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_OAUTH_ENCRYPTION_KEY` are configured. The client ID and client secret must be supplied together. Invoice retrieval requires `ZohoBooks.invoices.READ`. When writeback mappings are configured, new authorization requests include `ZohoBooks.invoices.UPDATE`; an existing grant must be reauthorized if it lacks that scope. Configure the IDs from the target organization's custom-field setup; the application does not create fields or assume standard field IDs.

Invoice retrieval and fiscal-candidate mapping are initialized only when OAuth is available and `ZOHO_ORGANIZATION_ID` is configured.

Generate a development encryption key with:

```bash
openssl rand -hex 32
```

This produces a 64-character hexadecimal value. Store it in your local `.env` file and never commit it or print it in logs.

If you rotate the key, account for existing encrypted OAuth data before doing so. Do not assume that existing encrypted data will remain decryptable after a key change.

The redirect URI must exactly match the URI registered in the Zoho API Console. The localhost default is for local development; deployed environments should use the appropriate registered HTTPS callback.

Set `ZOHO_ACCOUNTS_URL` to the correct Zoho Accounts domain for your organization's data center. The default is not appropriate for every Zoho region.

Configuring these variables does not by itself establish successful live authorization. Verify the authorization flow, token persistence, permissions, and invoice access against the intended Zoho organization.

### Local `.env` example

The following is a development template, not a production credential set:

```dotenv
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

DATABASE_PROVIDER=postgresql

POSTGRES_USER=zoho_amarco
POSTGRES_PASSWORD=replace_with_a_local_password
POSTGRES_DB=zoho_amarco_dev

DATABASE_URL=postgresql://zoho_amarco:replace_with_a_local_password@localhost:5438/zoho_amarco_dev

# Configure these together to enable Zoho OAuth.
ZOHO_CLIENT_ID=replace_with_your_client_id
ZOHO_CLIENT_SECRET=replace_with_your_client_secret

# Generate with: openssl rand -hex 32
ZOHO_OAUTH_ENCRYPTION_KEY=replace_with_a_64_character_hex_key

# Required for invoice retrieval and fiscal-candidate mapping.
ZOHO_ORGANIZATION_ID=replace_with_your_organization_id

ZOHO_REDIRECT_URI=http://localhost:3000/integrations/zoho/callback
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
```

Replace all placeholder values with the appropriate local configuration. The encryption key placeholder is not valid until replaced with a generated 64-character hexadecimal key.

URL-encode reserved characters when placing a password in `DATABASE_URL`, and keep the Compose variables consistent with the connection URL.

The Zoho credentials in this example are intentionally shown as placeholders, not as real credentials. If you do not want to enable OAuth yet, omit the Zoho settings where the environment schema permits it. Do not leave blank credential values if the schema rejects them.

Use the Accounts URL appropriate to your Zoho organization's data center. The default shown above does not guarantee that every Zoho organization should use the US data center.

## Database Setup

### PostgreSQL with Docker Compose

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Check container health:

```bash
docker compose ps
docker compose logs --tail=100 postgres
```

The Compose configuration binds PostgreSQL to `127.0.0.1:5438`, avoiding a conflict with a default PostgreSQL service on port `5432`.

The persistent volume is named `zoho_amarco_postgres_data`.

Stop the service without deleting data:

```bash
docker compose stop postgres
```

To remove the container and network while retaining the named volume:

```bash
docker compose down
```

**Warning:** `docker compose down -v` deletes the Compose-managed database volume and its data. Do not use it unless you intentionally want to destroy the local database.

### Prisma commands

Validate both database schemas:

```bash
pnpm db:validate
```

Generate the configured Prisma client:

```bash
pnpm db:generate
```

PostgreSQL schema commands:

```bash
pnpm db:validate:postgresql
pnpm db:generate:postgresql
```

The default Prisma configuration uses:

```text
Schema:      prisma/postgresql/schema.prisma
Migrations:  prisma/postgresql/migrations/
```

The schema and migration path are fixed to PostgreSQL in `prisma.config.ts`.

The initial PostgreSQL migration is under `prisma/postgresql/migrations/`. Apply migrations using the Prisma workflow appropriate to the configured schema and installed Prisma version. Before applying migrations to any shared or production database, review the generated SQL and take an appropriate backup.

Fiscal customer and item profile tables are included in the PostgreSQL migration history. Apply migrations using the supported PostgreSQL schema:

```bash
pnpm exec prisma migrate deploy --schema prisma/postgresql/schema.prisma
```

Set `DATABASE_URL` to the intended database URL before running Prisma migration commands. Review the migration SQL and confirm the target is a dedicated development/test database before applying it; no migration is run automatically by the application.

The fiscal profile repositories currently identify records by Zoho customer/item ID within the single Zoho organization configured for the installation. They do not provide multi-organization isolation. Persistence validates required fields, storage lengths, and the decimal-string shape of the configured VAT rate; it does not establish that customer details, HS codes, VAT classes, or rates comply with Kenyan tax rules. Profile data must not be treated as authorization to issue a receipt.

## Running the Application

Start the development server:

```bash
pnpm dev
```

Build the TypeScript project:

```bash
pnpm build
```

Run the compiled application:

```bash
pnpm start
```

Check the configured port and application logs if startup fails. Environment validation can prevent the application from starting when required configuration is missing.

## API and Health Checks

The Express API exposes health endpoints and read-only Zoho Books integration endpoints.

The Zoho endpoints are mounted under `/integrations/zoho`. Their availability depends on runtime configuration and the required Zoho credentials.

Fiscalization routes use the existing bearer-token authentication. The status endpoint
`GET /integrations/zoho/fiscalization-requests/:requestId` returns request and invoice
identifiers, state, registration/last-update timestamps, snapshot presence and validity,
confirmed receipt metadata only for a succeeded record, and sanitized failure information
only for a failed record. It does not expose invoice snapshots, customer details, or raw
device diagnostics. `OutcomeUnknown` remains unresolved and requires operator reconciliation.
In-progress requests are flagged for operator inspection, but that status is not proof that
processing is stuck because the record does not contain a dedicated processing-start
timestamp. A pending legacy request
without a valid snapshot (and any other non-terminal request with an invalid/missing
snapshot) is flagged for operator review and will not be processed from current Zoho or
profile data. This status endpoint is read-only; it cannot force an outcome.

### Health endpoints

| Method | Endpoint               | Purpose                                                                                                         |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health/live`         | Indicates that the application process is alive.                                                                |
| `GET`  | `/health/ready`        | Checks whether the configured database dependency is reachable.                                                 |
| `GET`  | `/health/dependencies` | Runs bounded database and read-only device diagnostics; optional remote providers remain explicitly unverified. |

Test the endpoints using the default port:

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
curl -i http://localhost:3000/health/dependencies
```

A successful liveness check returns HTTP `200` with:

```json
{
  "status": "ok"
}
```

A successful readiness check returns HTTP `200` with:

```json
{
  "status": "ready"
}
```

If the database readiness check fails or is not configured, the readiness endpoint returns HTTP `503` with:

```json
{
  "status": "not_ready"
}
```

A running process is not necessarily ready to serve requests that depend on the database.

### Zoho OAuth endpoints

| Method | Endpoint                       | Purpose                                                                               |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| `GET`  | `/integrations/zoho/authorize` | Starts OAuth authorization and redirects the browser to Zoho.                         |
| `GET`  | `/integrations/zoho/callback`  | Processes the authorization callback and exchanges the authorization code for tokens. |

OAuth requires `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_OAUTH_ENCRYPTION_KEY`. The encryption key must contain exactly 64 hexadecimal characters. OAuth state and PKCE verifier handling depend on the configured database-backed repositories.

If OAuth is not configured, these endpoints return HTTP `503` with the error code `ZOHO_OAUTH_UNAVAILABLE`.

The callback validates and consumes the OAuth state before processing the result. Invalid or expired state returns HTTP `400` with `INVALID_OAUTH_STATE`. A denied authorization returns `ZOHO_AUTHORIZATION_DENIED`, and a callback without an authorization code returns `INVALID_OAUTH_CALLBACK`.

After a successful code exchange, the callback returns HTTP `200` with a success message. Access and refresh tokens are not included in the response.

These responses describe the implemented application behavior; successful live authorization and production token recovery still require verification.

### Zoho Books invoice endpoints

| Method | Endpoint                                                        | Purpose                                                                                                |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET`  | `/integrations/zoho/invoices/:invoiceId`                        | Retrieves the requested Zoho Books invoice.                                                            |
| `GET`  | `/integrations/zoho/invoices/:invoiceId/fiscal-candidate`       | Retrieves the invoice and maps it into the internal fiscal-candidate format.                           |
| `POST` | `/integrations/zoho/invoices/:invoiceId/fiscalization-requests` | Retrieves, validates, and idempotently registers a pending fiscalization request without executing it. |
| `POST` | `/integrations/zoho/invoices/import`                            | Imports all invoice pages and registers valid invoices as pending requests.                            |
| `GET`  | `/integrations/zoho/invoices/sync/status`                       | Returns sanitized last-run, lease, count, and full-scan checkpoint metadata.                           |

These invoice endpoints require the configured invoice API bearer token. Invoice retrieval requires a configured OAuth service and `ZOHO_ORGANIZATION_ID`. Mapping and import also require the existing fiscal profile and fiscalization-request services.

Synchronize one invoice into the pending fiscalization queue without executing device or eTIMS stages:

```bash
curl -i -X POST \
  -H "Authorization: Bearer YOUR_INVOICE_API_BEARER_TOKEN" \
  http://localhost:3000/integrations/zoho/invoices/YOUR_ZOHO_INVOICE_ID/fiscalization-requests
```

A new request returns `201` with `alreadyExisted: false` and a `request` containing `id`, `zohoInvoiceId`, `status`, and `snapshotId`. A repeated request returns `200`, `alreadyExisted: true`, and the original request. It does not refetch the invoice or replace the archived snapshot. Use `GET /integrations/zoho/fiscalization-requests/:requestId` with the same bearer token to retrieve its status. A successful intake never invokes KRA or the device; execution requires the separate operator-authorized workflow route.

The single-invoice route accepts no request body and reports safe errors: invalid IDs or body fields return `400`, a Zoho `404` with documented API error code `1002` returns `404`, and a bare or unclassified `404` is treated as an upstream error (`502`), not proof that the invoice is absent. Invalid invoice/profile data returns `422`, other bounded upstream transport/server errors return `502`, and missing Zoho authorization, rate limiting, or request persistence failures return `503`. The response does not include the raw Zoho invoice or upstream error text. Operational logs include the invoice ID and bounded upstream status/category only; never include tokens or invoice bodies.

### Fiscalization result writeback

Zoho invoice writeback is disabled unless `ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON` is configured with unique custom-field IDs created in the configured organization. The strict JSON shape is:

```json
{
  "statusFieldId": "TENANT_CREATED_NUMERIC_FIELD_ID",
  "successStatusValue": "Fiscalized",
  "deviceReceiptNumberFieldId": "OPTIONAL_TENANT_CREATED_FIELD_ID",
  "etimsReferenceFieldId": "OPTIONAL_TENANT_CREATED_FIELD_ID",
  "fiscalizedAtFieldId": "OPTIONAL_TENANT_CREATED_FIELD_ID",
  "requestIdFieldId": "OPTIONAL_TENANT_CREATED_FIELD_ID"
}
```

Omit optional keys you do not map. Replace every example identifier with an existing field ID in the target Zoho organization. The middleware does not create custom fields. Configure OAuth with `ZohoBooks.invoices.UPDATE` and reauthorize if the stored grant lacks it. Zoho documents the custom-field update operation in its [Books v3 invoice API](https://www.zoho.com/books/api/v3/invoices/) and the scope in its [OAuth documentation](https://www.zoho.com/books/api/v3/oauth/). The client uses `PUT /books/v3/invoice/{invoice_id}/customfields` and makes no automatic PUT retries except bounded retry of explicit HTTP 429 responses.

An operator can request writeback for an existing request, without executing fiscalization, and inspect its durable state:

```bash
curl -i -X POST -H "Authorization: Bearer YOUR_OPERATOR_API_BEARER_TOKEN" http://localhost:3000/integrations/zoho/fiscalization-requests/YOUR_REQUEST_ID/zoho-writeback

curl -i -H "Authorization: Bearer YOUR_INVOICE_API_BEARER_TOKEN" http://localhost:3000/integrations/zoho/fiscalization-requests/YOUR_REQUEST_ID/zoho-writeback
```

The POST requires `invoice:writeback`; GET requires `request:read`. POST accepts no body and derives every value from persisted outcomes. Eligibility requires a fully successful authoritative real device outcome and accepted non-simulated eTIMS outcome for the same invoice and organization. Simulated, unverified, rejected, failed, uncertain, or partial results return `409` and are not written. Success returns `200` with `status`, `requestId`, `correlationId`, and `fieldsWritten`; an active operation returns `202`. GET returns the safe persisted status, or `not_eligible` if no operation exists. Neither route returns invoice contents or fiscal credentials.

Example success response:

```json
{
  "status": "succeeded",
  "requestId": "YOUR_REQUEST_ID",
  "correlationId": "GENERATED_WRITEBACK_CORRELATION_ID",
  "fieldsWritten": 5,
  "errorCategory": null
}
```

An ineligible result has `status: "not_eligible"`, `requestId`, and a safe `reason`. An uncertain result is returned as `manual_review` with its correlation ID and error category; GET continues to show that persisted state. Missing requests return `404`, invalid/untrusted outcomes return `409`, unavailable configuration or unexpected infrastructure errors return `503`, and missing/invalid permissions return `401`/`403`.

Each custom field is updated individually, evidence fields first and the configured success marker last. An operation record and per-field progress make interruption visible. If a PUT outcome is uncertain, the service does not resend it: after the lease expires, it reads the invoice and marks success only if every configured target value is present; otherwise it returns `manual_review`. A Zoho GET failure also remains uncertain. This read-after-write comparison is not proof against a separate actor changing those fields concurrently. A definitive update failure is stored independently from the fiscalization outcome. This workflow is unit tested with mocked transport; no live Zoho account behavior is established here.

Run mocked retrieval, mapping, synchronization-service, and route tests with:

```bash
LOG_LEVEL=silent pnpm exec vitest run tests/unit/zoho-books-client.test.ts tests/unit/zoho-invoice-mapper.test.ts tests/unit/prepare-fiscalization-request.test.ts tests/unit/zoho-books-routes.test.ts --reporter=dot
```

The import endpoint uses Zoho Books `page`, `per_page`, and `page_context.has_more_page` pagination, fetches each listed invoice's full detail, then reuses the existing mapping, fiscal-profile validation, immutable snapshot, and registration services. `ZOHO_SYNC_PAGE_SIZE` and `ZOHO_SYNC_MAX_PAGES` bound the maximum work per run. Hitting the page limit records an incomplete scan, not a successful checkpoint. The current installation supports one configured Zoho organization. Database uniqueness on the Zoho invoice ID arbitrates concurrent imports; a duplicate is skipped without changing an existing request or snapshot.

Automatic synchronization is disabled by default. When enabled, the application performs a full invoice-catalog scan on the configured interval; the existing verified client contract does not establish a safe modification-time filter, so the service does not invent an incremental query or advance an incremental checkpoint. `lastSuccessfulFullSyncAt` means that every page in a full catalog scan completed and valid invoices were registered or rejected; it does not mean invoices were fiscalized. Durable run history and an expiring database lease prevent overlapping scheduled/manual runs across application instances. An expired lease causes an interrupted run to be marked failed during recovery. The scheduler waits one interval before its first run and stops scheduling new work during graceful shutdown.

This deployment still has one primary OAuth token, one configured organization, and invoice-ID uniqueness that is not organization-scoped. The synchronization lock is keyed per organization, but application-level multi-organization synchronization is not enabled until token storage, fiscal profiles, and fiscalization identity constraints are made organization-aware.

The response reports `discovered`, `imported`, `duplicatesSkipped`, `rejected`, `failed`, `pagesRetrieved`, and `paginationComplete`. HTTP `200` means all pages were read and no invoice was rejected or failed; `207` means the import was partial; `502` means the first page could not be retrieved. Retryable transport and HTTP `429`/`5xx` failures receive bounded retries; `Retry-After` is respected when it fits the configured retry-delay bound. Authentication failures are not retried.

Retrieve an invoice:

```bash
curl -i \
  http://localhost:3000/integrations/zoho/invoices/YOUR_INVOICE_ID
```

Retrieve a fiscal candidate:

```bash
curl -i \
  http://localhost:3000/integrations/zoho/invoices/YOUR_INVOICE_ID/fiscal-candidate
```

Replace `YOUR_INVOICE_ID` with a real Zoho Books invoice ID accessible to the configured Zoho organization.

A successful invoice retrieval returns HTTP `200` with an `invoice` object. A successful mapping returns HTTP `200` with a `candidate` object.

Possible error responses include:

| HTTP status | Error code                         | Meaning                                                             |
| ----------- | ---------------------------------- | ------------------------------------------------------------------- |
| `400`       | `INVALID_INVOICE_ID`               | The invoice ID is missing or invalid.                               |
| `502`       | `ZOHO_BOOKS_UPSTREAM_ERROR`        | Zoho Books could not complete the invoice request.                  |
| `502`       | `ZOHO_INVOICE_MAPPING_FAILED`      | The retrieved invoice could not be mapped into the internal format. |
| `503`       | `ZOHO_BOOKS_UNAVAILABLE`           | Invoice retrieval is not configured.                                |
| `503`       | `ZOHO_INVOICE_SERVICE_UNAVAILABLE` | Invoice mapping is not configured.                                  |
| `500`       | `INTERNAL_SERVER_ERROR`            | An unexpected server error occurred.                                |

Mapping failures include a `details` array describing the fields that failed validation. Upstream API errors use a generic response rather than exposing internal exception details.

Confirm exact response formats and error behavior against the route implementation when updating this documentation.

### Important safety boundary

Invoice retrieval and fiscal-candidate mapping are read-only. Import persists validated invoices as `Pending` fiscalization requests but does not:

- Issue a fiscal receipt.
- Send commands to a Tremol G03 device.
- Submit invoice data to KRA/eTIMS.

A successful mapping or pending request is not proof that an invoice meets all fiscal-device or Kenyan tax requirements. Importing never implies payment, authorizes receipt issuance, or invokes the fiscalization processing route.

### Fiscal customer and item profile management

These endpoints manage explicit profile data for the single Zoho organization configured for this installation. Every endpoint requires the same configured `INVOICE_API_BEARER_TOKEN` used by the invoice API, passed as `Authorization: Bearer YOUR_CONFIGURED_BEARER_TOKEN`. This shared token does not distinguish read and write privileges; anyone holding it can create, read, and update profiles. No separate role or permission system is currently implemented. If the token is not configured, protected routes return HTTP `503`; missing or invalid credentials return HTTP `401`.

| Method   | Endpoint                                                      | Purpose                                                       |
| -------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST`   | `/integrations/zoho/fiscal-customer-profiles`                 | Create a fiscal customer profile.                             |
| `GET`    | `/integrations/zoho/fiscal-customer-profiles/:zohoCustomerId` | Retrieve a profile by Zoho customer ID.                       |
| `PUT`    | `/integrations/zoho/fiscal-customer-profiles/:zohoCustomerId` | Replace mutable fields without changing the Zoho customer ID. |
| `DELETE` | `/integrations/zoho/fiscal-customer-profiles/:zohoCustomerId` | Delete a profile without modifying existing snapshots.        |
| `POST`   | `/integrations/zoho/fiscal-item-profiles`                     | Create a fiscal item profile.                                 |
| `GET`    | `/integrations/zoho/fiscal-item-profiles/:zohoItemId`         | Retrieve a profile by Zoho item ID.                           |
| `PUT`    | `/integrations/zoho/fiscal-item-profiles/:zohoItemId`         | Replace mutable fields without changing the Zoho item ID.     |
| `DELETE` | `/integrations/zoho/fiscal-item-profiles/:zohoItemId`         | Delete a profile without modifying existing snapshots.        |

Customer creation request:

```json
{
  "zohoCustomerId": "YOUR_ZOHO_CUSTOMER_ID",
  "companyName": "Example Ltd",
  "clientPin": "CONFIGURED_PIN",
  "headquarters": "Nairobi",
  "address": "Example Road",
  "postalCodeAndCity": "00100 Nairobi",
  "exemptionNumber": null
}
```

Customer updates use the same fields except `zohoCustomerId`, which is supplied only in the URL. Item creation request:

```json
{
  "zohoItemId": "YOUR_ZOHO_ITEM_ID",
  "measureUnit": "EA",
  "hsCode": "CONFIGURED_CODE",
  "hsName": "Example item",
  "vatClass": "CONFIGURED_CLASS",
  "vatGroupRate": "CONFIGURED_RATE"
}
```

Item updates use the same fields except `zohoItemId`, which is supplied only in the URL. Create requests return HTTP `201`; retrieval and updates return HTTP `200`; deletes return HTTP `204` with no body. Successful create, read, and update responses contain the persisted profile as `{ "profile": { ... } }`. Deleting a profile changes future snapshot preparation only and does not modify existing immutable fiscalization snapshots. All delete routes use the same bearer authentication as the other profile routes. Unknown fields (including IDs and timestamps) and missing or wrongly typed fields are rejected. Repository validation also rejects empty required values and strings exceeding the schema limits: customer ID 255, company name/headquarters/address/postal city/exemption number 30, PIN 14; item ID 255, unit 3, HS code 10, HS name 20, VAT class 1, and VAT-rate string 20 characters. `exemptionNumber` must be a string or `null`. `vatGroupRate` must be represented as a decimal string; this shape check does **not** establish Kenyan tax or VAT compliance, confirm an HS code, or validate a fiscal classification.

Example successful response:

```json
{
  "profile": {
    "id": "server-generated-id",
    "zohoCustomerId": "YOUR_ZOHO_CUSTOMER_ID",
    "companyName": "Example Ltd",
    "clientPin": "CONFIGURED_PIN",
    "headquarters": "Nairobi",
    "address": "Example Road",
    "postalCodeAndCity": "00100 Nairobi",
    "exemptionNumber": null,
    "createdAt": "2026-10-27T00:00:00.000Z",
    "updatedAt": "2026-10-27T00:00:00.000Z"
  }
}
```

Example local request (use a locally configured token; do not put real credentials in source or documentation):

```bash
curl -i \
  -H "Authorization: Bearer YOUR_CONFIGURED_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"zohoCustomerId":"YOUR_ZOHO_CUSTOMER_ID","companyName":"Example Ltd","clientPin":"CONFIGURED_PIN","headquarters":"Nairobi","address":"Example Road","postalCodeAndCity":"00100 Nairobi","exemptionNumber":null}' \
  http://localhost:3000/integrations/zoho/fiscal-customer-profiles
```

Run the mocked HTTP tests locally with:

```bash
LOG_LEVEL=silent pnpm exec vitest run tests/unit/fiscal-profile-routes.test.ts --reporter=dot
```

| HTTP status | Error code                                                               | Meaning                                                                      |
| ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `400`       | `INVALID_JSON` / `INVALID_PROFILE_REQUEST` / `INVALID_FISCAL_PROFILE`    | JSON syntax, body shape, or profile field validation failed.                 |
| `401`       | `UNAUTHORIZED`                                                           | Bearer token is missing or invalid.                                          |
| `404`       | `FISCAL_PROFILE_NOT_FOUND`                                               | No profile exists for the requested Zoho identity.                           |
| `409`       | `FISCAL_PROFILE_ALREADY_EXISTS`                                          | A profile already exists for that identity.                                  |
| `500`       | `INTERNAL_SERVER_ERROR`                                                  | An unexpected persistence error occurred; internal details are not returned. |
| `503`       | `FISCAL_PROFILE_REPOSITORY_UNAVAILABLE` / `INVOICE_API_AUTH_UNAVAILABLE` | Profile persistence or authentication configuration is unavailable.          |

There is no `403` response because the current bearer-token authentication has no separate read/write authorization model. The configured Zoho organization is installation-wide; clients cannot choose an organization in the request. Profile values are configuration inputs only and do not authorize or guarantee a fiscal receipt.

## Fiscalization Workflow

The authenticated fiscalization-request endpoint retrieves the invoice from the configured Zoho organization, resolves the configured customer and item profiles, validates the current non-executable receipt-plan constraints, and persists the resulting request and immutable source snapshot together. Processing uses that stored snapshot; it does not fetch current invoice or profile data again. The fiscal-device adapter remains unverified and is not enabled for real receipt issuance.

At a high level:

1. `POST /integrations/zoho/invoices/:invoiceId/fiscalization-requests` retrieves the invoice in the installation's configured organization. It returns `201` with `alreadyExisted: false` for a new pending request, or `200` with `alreadyExisted: true` and the existing request for a repeat; existing snapshots are not replaced.
2. The service validates invoice fields and resolves the required customer and item profiles.
3. One database insert stores the Pending request and versioned snapshot atomically. The repository's unique Zoho invoice identity arbitrates concurrent calls; a losing caller reads and returns the winner's request when available. Registration never replaces the existing snapshot.
4. Processing validates the persisted snapshot, then attempts an atomic Pending-to-InProgress claim.
5. Only the successful claimant passes the stored snapshot to the device abstraction. An outcome is saved as success, failure, or uncertain.

The snapshot records its schema version, integrity identifier, registration timestamp, configured Zoho organization, mapped invoice values (including decimal strings), and the customer and per-line item profile values used at registration. This is a reproducibility record, not proof that any tax classification or profile is legally correct. Current VAT-rate validation checks data shape and the existing non-executable command-plan constraints only; it does **not** establish Kenyan tax or eTIMS compliance.

The configured organization is installation-wide and supplied by the server; request clients cannot choose an organization or submit a trusted snapshot. Monetary JSON number lexemes received from Zoho are retained as decimal strings before mapping so JavaScript floating-point conversion does not silently alter them.

Legacy records without a snapshot are not reconstructed from current Zoho or profile data. Processing rejects them with `409 FISCALIZATION_SNAPSHOT_REQUIRED` for operator review. Malformed or unsupported snapshots are rejected without reaching the device. The PostgreSQL migration adds nullable snapshot columns so historical rows remain representable; migrations have not been applied by this development change.

`GET /integrations/zoho/fiscalization-requests/:requestId` provides authenticated, read-only status visibility. It does not resolve an uncertain device outcome or offer success/failure overrides. No authoritative device evidence currently exists for final receipt-outcome reconciliation.

### Why atomic claiming matters

Two workers may receive the same invoice concurrently. A conditional state transition helps ensure that only one worker claims a pending record for processing.

Database uniqueness constraints also help prevent duplicate records for the same Zoho invoice.

These mechanisms protect the middleware's internal processing state. They do not, by themselves, guarantee exactly-once receipt issuance at a physical fiscal device.

### Uncertain outcomes

A device can issue a receipt while the application loses the response or encounters a network failure. In that situation, the application may not know whether the fiscal operation succeeded.

The middleware must preserve that uncertainty, investigate device status or authoritative records, and avoid blindly issuing the same receipt again. A failed database save after device execution also requires careful reconciliation rather than automatic device retry.

### Snapshot verification and local tests

The snapshot schema and mocked persistence mappings can be checked locally without connecting to a live database or fiscal device:

```bash
pnpm exec vitest run tests/unit/fiscalization-snapshot.test.ts tests/unit/register-fiscalization-request.test.ts tests/unit/fiscalization-service.test.ts
pnpm db:validate
```

These checks do not prove live PostgreSQL compatibility. Do not apply migrations to production or customer databases without the normal reviewed deployment process and a verified backup/recovery plan.

The migration is `prisma/postgresql/migrations/20261027103000_add_fiscalization_snapshot/migration.sql`; this implementation does not apply them.

## Testing and Quality Checks

Run the unit test suite:

```bash
pnpm test
```

Run tests in watch mode:

```bash
pnpm test:watch
```

Run the PostgreSQL repository integration tests explicitly:

```bash
RUN_POSTGRES_INTEGRATION=1 ZOHO_FISCALIZATION_TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5438/zoho_amarco_test' pnpm exec vitest run tests/integration/postgresql-fiscalization-repository.integration.test.ts
```

The PostgreSQL suite requires the dedicated test URL above, checks that it is restricted to the documented local test database, and does not fall back to application `DATABASE_URL`. The database must already have the intended migrations applied. See [database-migrations.md](docs/database-migrations.md) for the PostgreSQL migration test and safety requirements.

Run TypeScript checks:

```bash
pnpm typecheck
pnpm typecheck:tests
```

Run linting and formatting checks:

```bash
pnpm lint
pnpm format:check
```

Validate the Prisma schemas:

```bash
pnpm db:validate
```

Run the production build:

```bash
pnpm build
```

Before pushing changes, run the relevant checks and inspect the working tree:

```bash
git diff --check
git status
```

The project's full quality gate can be run with:

```bash
pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm format:check && pnpm db:validate && pnpm test && pnpm build
```

Unit tests should not require a live Zoho account or physical fiscal device. External integrations should use controlled test doubles or explicitly configured integration environments.

A passing unit test suite does not prove that Zoho OAuth, device receipt issuance, or KRA/eTIMS submission has been verified against live external systems.

## Device Integration

The current evidence inventory and per-capability verification matrix are in
[Tremol G03 Kenya protocol verification status](docs/tremol-g03-kenya-protocol-status.md).
The repository includes a Kenya protocol PDF, a ZFP Lab Server manual, and an
XML command catalogue. Those sources establish some command names and field
definitions, but do not verify the installed server's command-specific
serialization or physical behavior. Receipt issuance remains blocked.

The current device adapter foundation is located at:

```text
src/infrastructure/device/tremol-zfplabserver-client.ts
```

The application-facing interface is located at:

```text
src/application/fiscalization/fiscal-device.ts
```

The eventual integration must be based on the actual Tremol G03 model, firmware, SDK, configured ZFP Lab Server version, and Kenya-specific protocol documentation.

Before enabling real receipt issuance, verify:

- Device identity, firmware, and supported command set.
- The official command and response formats.
- Character encoding, framing, checksums, timeouts, and error handling where applicable.
- The behavior when a connection fails after a command has been sent.
- How to determine whether a receipt was already issued.
- Required receipt fields and fiscal data for the target jurisdiction.
- Safe device initialization, concurrency, and operational recovery.

Do not assume that a generic Tremol example establishes the correct Kenya-specific fiscalization protocol. Hardware testing must use a controlled environment and must not create unplanned live fiscal receipts.

## Zoho Books Integration Roadmap

The initial OAuth flow, invoice retrieval, and read-only mapping are implemented. The remaining work is validation, hardening, and connecting these capabilities to a verified fiscalization workflow.

### Phase 1: OAuth verification and hardening

- Verify the implemented authorization and callback flow against the intended Zoho organization.
- Confirm the applicable Zoho data center and API domain.
- Verify authorization-code exchange, state validation, and PKCE handling.
- Validate token persistence, refresh-token behavior, and recovery after restarts.
- Store tokens securely and protect them from source control, logs, and unauthorized access.
- Request only the scopes required by the implemented operations.
- Test authorization denial, expired state, missing configuration, token errors, and upstream failures.

### Phase 2: Read-only invoice retrieval verification

- Verify invoice retrieval using the documented Zoho Books API.
- Validate the organization and invoice identifiers.
- Confirm that the API response is mapped into the expected internal invoice representation.
- Handle documented API errors, rate limits, timeouts, and any relevant pagination requirements.
- Test against a controlled Zoho organization without issuing fiscal receipts.

### Phase 3: Invoice-to-fiscalization mapping

- Define the mapping between invoice lines, quantities, prices, taxes, currency, and the fiscal device's verified requirements.
- Establish validation rules and a traceable record of the source invoice.
- Confirm how discounts, rounding, tax categories, credit notes, and unsupported invoice states should be handled.
- Verify the mapping against authoritative requirements before any device execution.
- Add tests for invalid, incomplete, and unsupported invoice data.

### Phase 4: Verified device execution

- Complete and verify the G03 adapter.
- Establish device readiness checks and safe command sequencing.
- Test successful issuance, explicit device rejection, timeout, and uncertain outcomes.
- Persist confirmed receipt identifiers and relevant response data.
- Ensure recovery procedures never blindly reissue a potentially completed receipt.
- Integrate the device adapter with the fiscalization application service only after its contract is verified.

### Phase 5: KRA/eTIMS and production readiness

- Verify current KRA/eTIMS requirements and the applicable integration route.
- Confirm whether additional registration, authentication, device, or compliance requirements apply.
- Implement the required interface only after the API contracts and compliance obligations are confirmed.
- Add operational monitoring, secure deployment, backup and recovery procedures, and audit logging.
- Validate the complete workflow in an authorized test environment before production use.

## Security and Reliability

The following practices are required for production readiness:

- Never commit `.env`, OAuth tokens, database passwords, private keys, or other credentials.
- Use least-privilege database accounts.
- Use encrypted database connections and properly validated certificates.
- Keep OAuth scopes minimal and tokens protected at rest.
- Redact authorization headers, tokens, and sensitive invoice data from logs.
- Validate and normalize external API data before using it in fiscalization.
- Preserve a traceable relationship between the Zoho invoice, fiscalization record, and confirmed receipt.
- Treat device timeouts and lost responses as potentially uncertain outcomes.
- Avoid retry policies that can duplicate fiscal operations.
- Back up the database and test recovery procedures.
- Use authenticated and authorized access for any future fiscalization endpoints.
- Keep dependencies updated and review security advisories.
- Verify token refresh, revocation, key rotation, and failure recovery before production deployment.
- Ensure that health endpoints do not expose credentials or other sensitive configuration.

## Git Workflow

The repository uses the following branch model:

| Branch      | Purpose                            |
| ----------- | ---------------------------------- |
| `main`      | Stable release baseline            |
| `dev`       | Integration branch for tested work |
| `feature/*` | Isolated feature development       |

Create a feature branch from `dev`:

```bash
git switch dev
git pull --ff-only origin dev
git switch -c feature/your-feature-name
```

Commit focused changes:

```bash
git add <specific-files>
git diff --cached
git diff --cached --check
git commit -m "feat: describe the change"
```

Push the branch:

```bash
git push -u origin feature/your-feature-name
```

Open a pull request into `dev`. Merge into `main` only through the project's release process after the required checks and reviews have passed.

Never commit directly to `main` for routine feature development. Review the staged diff before committing to ensure it contains only the intended changes and no secrets or unrelated files.

## Troubleshooting

### PostgreSQL does not start

```bash
docker compose ps
docker compose logs --tail=100 postgres
```

Check whether port `5438` is already in use and verify the PostgreSQL variables in your local `.env`.

### Database connection fails

Confirm that:

- The configured database service is running.
- `DATABASE_URL` points to the correct host, port, and database.
- The username and password match the running database.
- The selected `DATABASE_PROVIDER` matches the intended adapter.
- The correct Prisma schema is selected for the provider.

### Prisma validation fails

```bash
pnpm db:validate
```

Review the error and validate the PostgreSQL schema.

### Integration tests fail

Confirm that the test database is reachable and that the integration test is using the intended test connection string. Do not point integration tests at production data.

### Zoho OAuth is unavailable

Confirm that:

- `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` are both configured.
- `ZOHO_OAUTH_ENCRYPTION_KEY` contains exactly 64 hexadecimal characters.
- The callback URI matches the URI registered in the Zoho API Console.
- The configured Accounts URL matches your organization's data center.
- Required database-backed OAuth repositories are available.

Do not print client secrets, access tokens, refresh tokens, or encryption keys while troubleshooting.

### Zoho invoice retrieval fails

Confirm that:

- OAuth has been completed successfully for the intended Zoho organization.
- `ZOHO_ORGANIZATION_ID` is correct.
- The authorized connection has the required permissions.
- The invoice ID belongs to the configured organization.
- The application logs contain no exposed tokens or sensitive invoice information.

Distinguish configuration errors from upstream Zoho API errors before changing the implementation.

### GitHub credential-helper warnings

If Git operations display a missing `gh auth git-credential` executable path, inspect the configured Git credential helper and the installed GitHub CLI location. Repair the configuration only after confirming the actual executable path. Do not remove working authentication settings blindly.

## Contributing

1. Start from an up-to-date `dev` branch.
2. Create a focused feature branch.
3. Make incremental changes with clear separation of concerns.
4. Add or update tests for behavior changes.
5. Run the relevant quality checks.
6. Review the staged diff for credentials, generated artifacts, and unrelated changes.
7. Push the branch and open a pull request into `dev`.
8. Document any assumptions or external protocol requirements that remain unverified.

---

**Project principle:** Never assume a fiscal operation succeeded merely because a command was sent, and never repeat an uncertain fiscal operation without first establishing its actual outcome.

# Operator reconciliation

Uncertain device and eTIMS outcomes can be reviewed through the authenticated
`manual-review:decide` operator API. Cases and decisions are durable and
append-only; investigation notes and escalation keep a case open. Success or
failure is recorded as an operator attestation with an external evidence
reference and does not change fiscalization status, create fiscal fields, retry
device/KRA operations, or qualify the request for Zoho writeback.

See [operator and deployment operations](docs/operations-and-deployment.md) for
the endpoints and evidence handling rules.
