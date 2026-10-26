# Zoho Amarco Middleware

**A fiscalization middleware connecting Zoho Books with a Tremol G03 fiscal device and Kenya's KRA/eTIMS ecosystem.**

> **Project status: Core foundation and initial Zoho Books integration implemented; device and regulatory integrations remain in progress.**
>
> The current codebase includes the fiscalization domain and application service, PostgreSQL and SQL Server persistence implementations, automated tests, Zoho OAuth authorization and callback handling, Zoho Books invoice retrieval, and read-only invoice-to-fiscal-candidate mapping. Live Zoho integration still requires environment configuration and verification. Verified Tremol G03 receipt issuance and KRA/eTIMS integration remain pending confirmation of the applicable device protocols, APIs, and compliance requirements.

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
- [Zoho Books Integration Roadmap](#zoho-books-integration-roadmap)
- [Security and Reliability](#security-and-reliability)
- [Git Workflow](#git-workflow)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Overview

Zoho Amarco Middleware is a TypeScript and Node.js service intended to bridge Zoho Books invoicing with fiscal receipt issuance through a Tremol G03 fiscal control unit, while supporting the applicable Kenyan KRA/eTIMS requirements.

The middleware is designed to run on a customer's Windows or Linux server, depending on the final deployment and device connectivity requirements. It provides an integration foundation between cloud-based accounting software, locally accessible fiscal hardware, and persistent records of processing outcomes.

### Goals

- Retrieve and validate invoice information from Zoho Books.
- Prevent duplicate fiscalization of the same Zoho invoice.
- Track fiscalization requests and their processing states.
- Coordinate invoice processing with a locally accessible fiscal device.
- Persist receipt identifiers and processing outcomes.
- Support PostgreSQL and Microsoft SQL Server as database options.
- Handle device failures and uncertain outcomes without blindly repeating receipt issuance.
- Provide structured logging, health checks, automated tests, and a maintainable foundation for production deployment.
- Integrate with the applicable KRA/eTIMS requirements after the required APIs and compliance obligations have been verified.

## Project Status

| Capability                                        | Status                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| TypeScript application foundation and Express API | Implemented                                                                         |
| Health and readiness endpoints                    | Implemented                                                                         |
| Fiscalization domain and application service      | Implemented; live fiscalization is not yet verified                                 |
| PostgreSQL repository and integration tests       | Implemented                                                                         |
| SQL Server repository and automated tests         | Implemented; validate against the target SQL Server environment                     |
| Prisma schemas for PostgreSQL and SQL Server      | Implemented                                                                         |
| PostgreSQL Docker Compose development setup       | Implemented                                                                         |
| Zoho OAuth authorization and callback flow        | Implemented; requires configuration and live-environment verification               |
| OAuth state handling and PKCE verifier protection | Implemented                                                                         |
| OAuth token exchange and persistence              | Implemented; production security and recovery still require validation              |
| Zoho Books invoice retrieval                      | Implemented; requires valid credentials, organization configuration, and API access |
| Read-only invoice-to-fiscal-candidate mapping     | Implemented and unit-tested                                                         |
| Verified Tremol G03 receipt issuance              | Pending device, SDK, firmware, and Kenya-specific protocol verification             |
| KRA/eTIMS integration                             | Pending verification of the applicable API and compliance requirements              |
| Production deployment and operational hardening   | Pending                                                                             |

**Important:** Implemented application code does not automatically mean that an external integration has been verified against a live service or physical device. The Zoho integration requires live testing. Real fiscal receipt issuance and KRA/eTIMS submission are not yet confirmed.

## Architecture

The project separates business rules from database and external-system implementations.

The current Zoho integration is a read-only path. The fiscalization domain and application service provide a foundation for later processing, but the invoice endpoints do not currently trigger the complete fiscalization workflow.

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
              |          +---- SQL Server
              |
              +---- Fiscal Device Interface
                         |
                         +---- Tremol ZFP Lab Server Client Foundation

KRA/eTIMS Integration
    |
    +---- Pending verified API contracts and compliance requirements
```

### Current integration boundary

The Zoho invoice endpoints currently stop at invoice retrieval or read-only fiscal-candidate mapping. They do not issue fiscal receipts, send device commands, create fiscalization requests as part of mapping, or submit invoice data to KRA/eTIMS.

The intended end-to-end workflow will only be connected after the invoice mapping, device protocol, receipt reconciliation, and applicable regulatory requirements have been verified.

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
    │   ├── sqlserver-client.ts
    │   └── sqlserver-fiscalization-repository.ts
    ├── device/
    │   └── tremol-zfplabserver-client.ts
    └── integrations/
        └── zoho/
            └── books-client.ts

prisma/
├── postgresql/
│   ├── schema.prisma
│   └── migrations/
└── sqlserver/
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

Implements persistence and external-system adapters, including PostgreSQL and SQL Server repositories, Zoho Books API access, and the current Tremol client foundation.

**API and server**

`src/app.ts` configures the Express application and HTTP middleware. `src/server.ts` initializes runtime dependencies and manages server startup and shutdown. Route modules expose the available HTTP endpoints.

## Technology Stack

- Node.js and TypeScript
- pnpm
- Express
- Zod for environment validation
- Prisma ORM
- PostgreSQL and Microsoft SQL Server adapters
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
- Access to a PostgreSQL instance or an appropriately configured SQL Server instance
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

The application validates its environment through `src/config/env.ts`.

### General settings

| Variable            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `NODE_ENV`          | Runtime environment: `development`, `test`, or `production`   |
| `PORT`              | HTTP port; defaults to `3000`                                 |
| `LOG_LEVEL`         | Logging threshold; defaults to `info`                         |
| `DATABASE_PROVIDER` | Selects `postgresql` or `sqlserver`; defaults to `postgresql` |
| `DATABASE_URL`      | PostgreSQL connection URL and Prisma datasource URL           |

### PostgreSQL settings

The Docker Compose configuration uses the following variables:

| Variable            | Purpose                        |
| ------------------- | ------------------------------ |
| `POSTGRES_USER`     | Local PostgreSQL username      |
| `POSTGRES_PASSWORD` | Local PostgreSQL password      |
| `POSTGRES_DB`       | Local PostgreSQL database name |

`DATABASE_URL` must also be set for the application and Prisma commands that need to connect to PostgreSQL.

### SQL Server settings

| Variable                             | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `SQLSERVER_SERVER`                   | SQL Server hostname or address                                |
| `SQLSERVER_DATABASE`                 | Database name                                                 |
| `SQLSERVER_USER`                     | Database login                                                |
| `SQLSERVER_PASSWORD`                 | Database password                                             |
| `SQLSERVER_PORT`                     | Port; defaults to `1433`                                      |
| `SQLSERVER_ENCRYPT`                  | Enables or disables connection encryption; defaults to `true` |
| `SQLSERVER_TRUST_SERVER_CERTIFICATE` | Controls certificate trust behavior; defaults to `false`      |

The SQL Server connection settings are used by the SQL Server adapter. When selecting SQL Server, configure the Prisma schema and migration path for SQL Server as well; the root Prisma configuration defaults to PostgreSQL.

### Zoho Books OAuth settings

The application supports a Zoho Books OAuth authorization flow and read-only invoice retrieval.

| Variable                    | Purpose                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZOHO_CLIENT_ID`            | Client ID from the Zoho API Console. Must be configured with the client secret to enable OAuth.                                                            |
| `ZOHO_CLIENT_SECRET`        | Client secret from the Zoho API Console. Must be supplied together with the client ID.                                                                     |
| `ZOHO_OAUTH_ENCRYPTION_KEY` | A 32-byte encryption key represented as exactly 64 hexadecimal characters. Required to initialize the OAuth service and protect stored PKCE verifier data. |
| `ZOHO_ORGANIZATION_ID`      | Zoho Books organization ID. Required for invoice retrieval and invoice mapping.                                                                            |
| `ZOHO_REDIRECT_URI`         | OAuth callback URI registered in the Zoho API Console. Defaults to `http://localhost:3000/integrations/zoho/callback`.                                     |
| `ZOHO_ACCOUNTS_URL`         | Zoho Accounts authorization server URL for the organization's data center. Defaults to `https://accounts.zoho.com`.                                        |

The OAuth service is initialized only when `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_OAUTH_ENCRYPTION_KEY` are configured. The client ID and client secret must be supplied together.

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

Provider-specific commands:

```bash
pnpm db:validate:postgresql
pnpm db:generate:postgresql

pnpm db:validate:sqlserver
pnpm db:generate:sqlserver
```

The default Prisma configuration uses:

```text
Schema:      prisma/postgresql/schema.prisma
Migrations:  prisma/postgresql/migrations/
```

It can be configured with `PRISMA_SCHEMA` and `PRISMA_MIGRATIONS_PATH`.

The initial PostgreSQL migration is under `prisma/postgresql/migrations/`. Apply migrations using the Prisma workflow appropriate to the configured schema and installed Prisma version. Before applying migrations to any shared or production database, review the generated SQL and take an appropriate backup.

The existence of a SQL Server schema does not by itself prove that SQL Server migrations have been created or applied in a real SQL Server environment.

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

### Health endpoints

| Method | Endpoint        | Purpose                                                         |
| ------ | --------------- | --------------------------------------------------------------- |
| `GET`  | `/health/live`  | Indicates that the application process is alive.                |
| `GET`  | `/health/ready` | Checks whether the configured database dependency is reachable. |

Test the endpoints using the default port:

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
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

| Method | Endpoint                                                  | Purpose                                                                      |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`  | `/integrations/zoho/invoices/:invoiceId`                  | Retrieves the requested Zoho Books invoice.                                  |
| `GET`  | `/integrations/zoho/invoices/:invoiceId/fiscal-candidate` | Retrieves the invoice and maps it into the internal fiscal-candidate format. |

Invoice retrieval requires a configured OAuth service and `ZOHO_ORGANIZATION_ID`. The mapping endpoint additionally requires the invoice mapping service, which is initialized when invoice retrieval is configured.

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

Both invoice endpoints are read-only. The fiscal-candidate endpoint validates and maps invoice data; it does not:

- Issue a fiscal receipt.
- Send commands to a Tremol G03 device.
- Persist a new fiscalization request as part of the mapping operation.
- Submit invoice data to KRA/eTIMS.

A successful mapping is not proof that an invoice meets all fiscal-device or Kenyan tax requirements. Those requirements must be verified before device execution is implemented.

## Fiscalization Workflow

The application foundation models a fiscalization request as a durable process. The workflow below describes the intended domain and application behavior; it is **not yet an end-to-end workflow wired to the Zoho HTTP endpoints**.

At a high level:

1. A fiscalization request is created or retrieved using the Zoho invoice identifier.
2. The repository attempts to claim the pending request atomically.
3. The application service invokes the fiscal device abstraction.
4. The result is persisted as a success, failure, or uncertain outcome.
5. The persisted record supports operational diagnosis and duplicate prevention.

### Why atomic claiming matters

Two workers may receive the same invoice concurrently. A conditional state transition helps ensure that only one worker claims a pending record for processing.

Database uniqueness constraints also help prevent duplicate records for the same Zoho invoice.

These mechanisms protect the middleware's internal processing state. They do not, by themselves, guarantee exactly-once receipt issuance at a physical fiscal device.

### Uncertain outcomes

A device can issue a receipt while the application loses the response or encounters a network failure. In that situation, the application may not know whether the fiscal operation succeeded.

The middleware must preserve that uncertainty, investigate device status or authoritative records, and avoid blindly issuing the same receipt again. A failed database save after device execution also requires careful reconciliation rather than automatic device retry.

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
RUN_POSTGRES_INTEGRATION=1 pnpm exec vitest run tests/integrations/postgresql-fiscalization-repository.integrations.test.ts
```

The integration test requires a reachable test PostgreSQL database configured through `DATABASE_URL`. Use a dedicated test database, not a production database or a database containing irreplaceable data.

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
pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm format:check && pnpm build && pnpm vitest run
```

Unit tests should not require a live Zoho account or physical fiscal device. External integrations should use controlled test doubles or explicitly configured integration environments.

A passing unit test suite does not prove that Zoho OAuth, SQL Server deployment, device receipt issuance, or KRA/eTIMS submission has been verified against live external systems.

## Device Integration

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

Review the error and validate the PostgreSQL and SQL Server schemas separately. Provider-specific schemas and migration histories must not be mixed.

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
