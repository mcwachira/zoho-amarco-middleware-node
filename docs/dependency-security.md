# Dependency security findings

## Azure Identity and MSAL Node advisory

The SQL Server persistence provider was removed because PostgreSQL is the only
required middleware database. Removing `@prisma/adapter-mssql` and the unused
`@types/mssql` development package also removed their dependency chain:

`@prisma/adapter-mssql -> mssql -> tedious -> @azure/identity -> @azure/msal-node`

and

`@types/mssql -> tedious -> @azure/identity -> @azure/msal-node`.

The previous audit reported GHSA-xcx6-jx8p-x3h5 against `@azure/msal-node@6.0.1`
(the affected range was `>=5.0.0-beta.0 <7.1.0`; patched releases start at
7.1.0). No override was used. Tedious required `@azure/identity`, whose
published dependency range constrained MSAL to major version 6. The packages
were removed by removing the optional SQL Server middleware database provider,
not by changing the transitive version range.

The application does not directly import Azure Identity or MSAL. The previous
SQL Server client used SQL login settings and the application had no MSAL
authorization-code flow. That narrowed the app's current use of the affected
flow, but did not make package presence harmless. After removal,
`pnpm install --frozen-lockfile` passed and `pnpm audit:deps` exited 0 with
`No known vulnerabilities found`. The active dependency graph no longer
includes the packages in those paths. Re-run the audit for every release; this
result is time-specific and does not replace ongoing dependency review.

The middleware's database is separate from the customer's Syspro database. The
repository has no Syspro connector or queries. It now supports PostgreSQL only
for ZohoAmarco persistence; this does not remove or alter the customer's Syspro
system.
