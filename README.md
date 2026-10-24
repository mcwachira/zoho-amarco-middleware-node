# Zoho Amarco Middleware

**A fiscalization middleware connecting Zoho Books with a Tremol G03 fiscal device and Kenya's KRA/eTIMS ecosystem.**

> **Project status: Foundation implemented; external integrations are in progress.**
>
> The current codebase includes the fiscalization domain and application service, PostgreSQL and SQL Server persistence implementations, a Tremol ZFP Lab Server client foundation, and automated tests. Zoho Books OAuth and invoice retrieval, verified device command execution, and KRA/eTIMS integration are not yet complete.

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

The middleware is designed to run on a customer's Windows or Linux server, depending on the final deployment and device connectivity requirements. It will provide a controlled integration layer between cloud-based accounting software, local fiscal hardware, and the persistence needed to track processing outcomes.

### Goals

- Retrieve and validate invoice information from Zoho Books.
- Prevent duplicate fiscalization of the same Zoho invoice.
- Track fiscalization requests and their processing states.
- Coordinate invoice processing with a locally accessible fiscal device.
- Persist receipt identifiers and processing outcomes.
- Support PostgreSQL and Microsoft SQL Server as database options.
- Handle device failures and uncertain outcomes without blindly repeating receipt issuance.
- Provide logging, health checks, automated tests, and a maintainable foundation for production deployment.

## Project Status

| Capability                                      | Status                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| TypeScript application foundation               | Implemented                                                            |
| Express API and health endpoints                | Implemented                                                            |
| Fiscalization domain and application service    | Implemented                                                            |
| PostgreSQL repository                           | Implemented and integration-tested                                     |
| SQL Server repository                           | Implemented; automated repository tests exist                          |
| Prisma schemas for both database providers      | Implemented                                                            |
| PostgreSQL Docker Compose configuration         | Implemented                                                            |
| Tremol ZFP Lab Server client foundation         | Implemented; hardware protocol still requires verification             |
| Zoho Books OAuth 2.0                            | Planned                                                                |
| Zoho Books invoice retrieval                    | Planned                                                                |
| Verified G03 receipt issuance                   | Pending device/SDK/protocol verification                               |
| KRA/eTIMS integration                           | Pending verification of the applicable API and compliance requirements |
| Production deployment and operational hardening | Pending                                                                |

These statuses describe the current repository, not a claim of certification or successful live fiscalization.

## Architecture

The project separates business rules from database and device implementations.

```text
Zoho Books
    |
    | OAuth 2.0 / Invoice API (planned)
    v
Express API
    |
    v
Application Layer
    |
    +---- Fiscalization Service
    |         |
    |         +---- Fiscalization Repository
    |         |          |
    |         |          +---- PostgreSQL
    |         |          |
    |         |          +---- SQL Server
    |         |
    |         +---- Fiscal Device Interface
    |                    |
    |                    +---- Tremol ZFP Lab Server client
    |
    v
Fiscalization Record and Processing Outcome

KRA/eTIMS integration: planned, subject to verified requirements.
```

### Source layout

```text
src/
├── app.ts
├── server.ts
├── config/
│   └── env.ts
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
│   └── fiscalization/
│       ├── fiscal-device.ts
│       ├── fiscalization-errors.ts
│       ├── fiscalization-repository.ts
│       └── fiscalization-service.ts
└── infrastructure/
    ├── database/
    │   ├── fiscalization-record-mapper.ts
    │   ├── fiscalization-repository-provider.ts
    │   ├── postgresql-client.ts
    │   ├── postgresql-fiscalization-repository.ts
    │   ├── sqlserver-client.ts
    │   └── sqlserver-fiscalization-repository.ts
    └── device/
        └── tremol-zfplabserver-client.ts

prisma/
├── postgresql/
│   ├── schema.prisma
│   └── migrations/
└── sqlserver/
    └── schema.prisma

tests/
├── integration/
└── unit/
```

### Layer responsibilities

**Domain**

Defines fiscalization records, statuses, allowed state transitions, and domain operations. It should not depend on Express, Prisma, Zoho SDKs, or device-specific implementations.

**Application**

Coordinates the fiscalization use case through interfaces for persistence and device operations. It determines how requests progress and how failures or uncertain outcomes are represented.

**Infrastructure**

Implements persistence and external-system adapters, including the PostgreSQL and SQL Server repositories and the current Tremol client foundation.

**API and server**

`src/app.ts` configures the Express application and HTTP middleware. `src/server.ts` initializes runtime dependencies and manages server startup and shutdown.

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

- Node.js version compatible with the project's TypeScript configuration
- pnpm version specified by `package.json`
- Git
- Docker Engine and the Docker Compose plugin, for the PostgreSQL development setup
- Access to a PostgreSQL instance, or an appropriately configured SQL Server instance
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

### 3. Install dependencies

```bash
pnpm install --frozen-lockfile
```

### 4. Configure environment variables

Create a local `.env` file in the project root. Use the configuration section below as a starting point and provide your own local database credentials.

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
pnpm lint
pnpm test
pnpm dev
```

## Environment Configuration

The application validates its environment through `src/config/env.ts`.

The following variables are currently defined by the application and database configuration.

### General settings

| Variable            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `NODE_ENV`          | Runtime environment: `development`, `test`, or `production`   |
| `PORT`              | HTTP port; defaults to `3000`                                 |
| `LOG_LEVEL`         | Logging threshold; defaults to `info`                         |
| `DATABASE_PROVIDER` | Selects `postgresql` or `sqlserver`; defaults to `postgresql` |
| `DATABASE_URL`      | PostgreSQL connection URL and Prisma datasource URL           |

### PostgreSQL settings

The Compose configuration uses:

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

### Local `.env` example

This is a template, not a production credential set:

```dotenv
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

DATABASE_PROVIDER=postgresql

POSTGRES_USER=zoho_amarco
POSTGRES_PASSWORD=replace_with_a_local_password
POSTGRES_DB=zoho_amarco_dev

DATABASE_URL=postgresql://zoho_amarco:replace_with_a_local_password@localhost:5438/zoho_amarco_dev
```

Replace the placeholder password with a URL-encoded value if it contains reserved URL characters. Keep the Compose variables and connection URL consistent.

Zoho credentials are not part of the current configuration schema. They should be added when the OAuth implementation is designed, with secrets stored outside source control.

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

Check the configured port and application logs if startup fails. Environment validation can prevent the application from starting when required database configuration is missing.

## API and Health Checks

The current Express application exposes these health endpoints:

| Endpoint            | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `GET /health/live`  | Indicates that the application process is alive                            |
| `GET /health/ready` | Checks application readiness, including the configured database dependency |

With the default port, test them using:

```bash
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
```

The readiness endpoint may report failure when the database is unavailable. That is intentional: a running process is not necessarily ready to process fiscalization requests.

The public Zoho callback, invoice lookup, and fiscalization endpoints have not yet been established as a complete external integration contract. Consult the implemented routes and tests before relying on any additional endpoint.

## Fiscalization Workflow

The application foundation models a fiscalization request as a durable process.

At a high level:

1. A request is created or retrieved using the Zoho invoice identifier.
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
RUN_POSTGRES_INTEGRATION=1 pnpm exec vitest run tests/integration/postgresql-fiscalization-repository.integration.test.ts
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

Unit tests should not require a live Zoho account or physical fiscal device. External integrations should use controlled test doubles or explicitly configured integration environments.

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

The integration should be developed incrementally.

### Phase 1: OAuth and configuration

- Define Zoho Books OAuth configuration using validated environment variables.
- Determine the applicable Zoho data center and API domain.
- Implement authorization and callback handling.
- Exchange authorization codes for tokens using the documented OAuth flow.
- Refresh access tokens securely.
- Store refresh tokens securely, never in source control or ordinary logs.
- Request only the scopes required by the implemented operations.

### Phase 2: Read-only invoice retrieval

- Retrieve an invoice using the documented Zoho Books API.
- Validate the organization and invoice identifiers.
- Map the API response into an internal invoice representation.
- Handle pagination, rate limits, timeouts, and documented API errors.
- Add unit and integration tests without issuing fiscal receipts.

### Phase 3: Invoice-to-fiscalization mapping

- Define the mapping between invoice lines, quantities, prices, taxes, currency, and the fiscal device's verified requirements.
- Establish validation rules and a traceable record of the source invoice.
- Verify the mapping against authoritative requirements before any device execution.

### Phase 4: Verified device execution

- Complete and verify the G03 adapter.
- Test successful issuance, explicit device rejection, timeout, and uncertain outcomes.
- Persist confirmed receipt identifiers and relevant response data.
- Ensure recovery procedures never blindly reissue a potentially completed receipt.

### Phase 5: KRA/eTIMS and production readiness

- Verify the current KRA/eTIMS requirements and applicable integration route.
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

Never commit directly to `main` for routine feature development.

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
