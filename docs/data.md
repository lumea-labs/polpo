# Application Data

Data stores structured application records independently from Polpo runtime
storage and file Volumes. It does not implement application user authentication.
Use the normal server-side Polpo API key; an application's backend owns user access
rules. The key provides Data access, including schema administration, within its
host-authorized scope. Agent grants are configured independently.

The product calls each logical Data resource a **database**. Each database owns
its tables and grants; a provider may implement it as a PostgreSQL schema.
The HTTP `/data`, SDK `data()` and custom-tool `ctx.data` interfaces retain their
generic Data namespace. Agent tools use `database_*`.

## Self-hosting

Provision a separate PostgreSQL application database. Its owner must be able to
create schemas and non-login roles (`CREATEROLE`); superuser is not required.
Set `POLPO_DATA_DATABASE_URL` on the trusted Polpo server/runner. Data remains
unavailable when the variable is absent. Existing runtime `databaseUrl` is not used.
The standard Node server exposes Data under its authenticated `/api/v1/data` API.

`POLPO_DATA_AGENT_GRANTS` is host-owned JSON keyed by agent name:

```json
{"leo":[{"resource":"<immutable-data-uuid>","actions":["read","write"]}]}
```

Grants may additionally restrict `tables`. `manage` grants schema administration;
only a global resource grant (`resource: "*"`) with unrestricted `manage` can
create resources. Assign built-in tools using `allowedTools: ["database_*"]`.
Custom tools receive `ctx.data.list()`, `.describe(resource)` and
`.execute(resource, {operations, idempotencyKey})` and optional `.query(resource, input)`
with the same agent grants.
Local custom tools run as trusted Node code; these capabilities do not sandbox
arbitrary in-process code. Managed hosts must use an isolated capability gateway.

Programmatic hosts can use `createNodeDataRuntime` from `@polpo-ai/node` and supply
`AppOptions.data`; other hosts compose `DataService` from `@polpo-ai/core/data`,
`PostgresDataProvider` from `@polpo-ai/drizzle/data` and `dataRoutes` from
`@polpo-ai/server`. Always authenticate before resolving a scoped service.
Call the runtime's `close()` during shutdown when managing it programmatically.

## Self-hosted dashboard

Open **Databases** at `/data` in `apps/dashboard`. Select a database with **Schema**,
then select its table in the side navigation. The page supports database creation,
renaming and deletion, additive schema editing, record CRUD, SQL queries and
mutations, and SQL migrations with history. Destructive operations use the current
resource or row version to detect conflicts.

The dashboard uses the configured runtime backend. Its server proxy keeps
`POLPO_API_KEY` out of browser code. Hosts embedding `@polpo-ai/dashboard` can use
`V2DataView` and the `DashboardProvider` Data capability. The runtime must still be
configured and authenticated; UI visibility does not enable a backend.

The self-hosted view has no managed environment or provisioning controls. Configure
agent grants through `POLPO_DATA_AGENT_GRANTS` or the host's grant resolver. Cloud
provides its own Live/Test selection, managed backend status and agent access UI.

## SDK

```ts
const crm = await polpo.createData({
  name: "crm",
  schema: { tables: { customers: { columns: {
    name: { type: "text" },
    email: { type: "text", unique: true },
    profile: { type: "json", nullable: true },
  } } } },
});
const customers = polpo.data(crm.id).table("customers");
const row = await customers.insert(
  { name: "Mario", email: "mario@example.com" },
  { idempotencyKey: "customer-import-42" },
);
const page = await customers.list({ filter: { email: { eq: "mario@example.com" } } });
await customers.update(row._id, { name: "Maria" }, row._version);
```

Column types are text, integer (signed 32-bit), number (finite double), boolean,
timestamp (ISO 8601 with timezone), uuid and JSON. Rows have immutable `_id`,
monotonic `_version`, `_created_at` and `_updated_at`. User column identifiers
start with a lowercase letter and contain lowercase letters, digits or underscores.
Tables support indexes and foreign keys to unique columns in the same resource.

Filters combine with AND; operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`
and `isNull`. Use `orderBy: [{column: "name", direction: "asc"}]`. A unique `_id`
tie-breaker makes ordering deterministic. `limit` defaults to 50 (maximum 200);
continue with `offset: page.nextOffset`. Offset pagination is bounded to 10,000
and does not promise a snapshot while other callers write.

`polpo.data(id).transaction(operations, {idempotencyKey})` executes up to 100
operations atomically. Reuse a key only for the same logical request; keys are
scoped to caller and resource. `update` and `delete` require an expected row
version. On conflict, reload and resolve the conflict; do not blindly overwrite.
Upsert requires a declared populated unique key. API requests are limited to
256 KiB and transaction results to 1 MiB. A result-size failure rolls back writes.

## Schema lifecycle

`data.describe()` returns `schemaVersion`. `data.migrate({expectedVersion, schema})`
adds tables, nullable columns, indexes and references transactionally. Existing
columns/indexes cannot be changed or removed. `data.rename({expectedVersion,name})`
keeps resource identity and grants. `data.remove(expectedVersion)` explicitly
deletes the resource and its records. Neither schema changes nor deletion are
available through ordinary Data record tools.

## Agent reads and transactions

`database_list` lists accessible databases; `database_describe` inspects their
table schemas. `database_read` reads records from one table using typed filters,
ordering and pagination. `database_insert`, `database_update`, `database_delete`
and `database_upsert` operate on records; `database_delete` never drops a database.

`database_transaction` submits multiple structured record operations in one
database as a single atomic batch: all commit or all roll back. It is not a SQL
query tool. Use `database_query` for scoped SQL reads, joins, aggregates and explicit
record mutations. It defaults to 20 returned rows, capped at 50. Database creation,
schema changes and removal are available through the administrative HTTP API, SDK,
CLI and dashboard, not agent tools or `ctx.data`.

## SQL queries and mutations

`data.query()` executes one parameterized statement within one logical database.
The PostgreSQL provider supports `SELECT` with joins, aggregates, subqueries,
`UNION` and `VALUES`; `INSERT`, `UPDATE`, `DELETE` and `ON CONFLICT` require
explicit `mode: "write"`. Every referenced table must be granted for its operation.
Use unqualified logical table names and `$1`, `$2`, … parameters for values.

```ts
const database = polpo.data("crm");
const counts = await database.query({
  sql: "SELECT count(*) AS total FROM customers WHERE name = $1",
  params: ["Maria"],
});
await database.query({
  sql: "UPDATE customers SET name = $1 WHERE _id = $2 AND _version = $3 RETURNING *",
  params: ["Mario", row._id, row._version],
  mode: "write",
  idempotencyKey: "rename-customer-42",
});
```

SQL writes generate IDs and advance `_version` and `_updated_at` automatically.
Unlike typed updates, SQL requires the caller to include a version predicate when
optimistic concurrency is needed; zero affected rows means the predicate did not
match. The result contains `rows`, `rowCount` and `truncated`. Read `rowCount` is
the returned row count, not a full-table count. Write `rowCount` includes all
affected rows even when the returned page is truncated. `maxRows` defaults to 200
and cannot exceed 200. Result-size failures roll back mutations. Text columns
hold at most 64 KiB of UTF-8 text; numbers and timestamps must be finite.

This is a bounded PostgreSQL subset, not an unrestricted PostgreSQL connection.
Cross-database/schema access, catalogs, role/session changes, procedural SQL,
CTEs, table functions, arbitrary functions and server extensions are rejected.
Only supported column types and an explicit function allowlist are accepted.
Provider capabilities declare the SQL dialect and migration support; a provider
without SQL returns `data_invalid`. Use typed operations for portable record access.

## SQL migrations

Administrators can apply ordered DDL and data backfills atomically:

```ts
const current = await database.describe();
await database.migrateSql({
  id: "customer_source",
  expectedVersion: current.schemaVersion,
  statements: [
    { sql: "ALTER TABLE customers ADD COLUMN source text" },
    { sql: "UPDATE customers SET source = $1", params: ["import"] },
    { sql: "ALTER TABLE customers ALTER COLUMN source SET NOT NULL" },
    { sql: "CREATE INDEX customer_source ON customers(source)" },
  ],
});
const history = await database.migrations();
```

Each item contains exactly one statement. Supported DDL is `CREATE TABLE`,
`ALTER TABLE` (add/drop/rename column, rename table, set/drop not-null, supported
type changes) and ordinary `CREATE/DROP INDEX` and `DROP TABLE`. Column constraints
support `NOT NULL`, `UNIQUE` and same-database `REFERENCES`; Polpo adds system columns.
Defaults, triggers, custom types and arbitrary ORM migration SQL are not supported.
Drops and type changes require `allowDestructive: true`; cascading drops are rejected.
A failure rolls back schema, backfills, catalog version and migration history.

A migration ID is immutable: retrying an identical request returns its original
result, while changing a recorded request is a conflict. History includes ID,
checksum, applied schema version and timestamp. Keep the original expectedVersion
when retrying the same migration. Each new migration uses the current version.
Migrations require `manage`; agent tools and `ctx.data` do not expose administration.

## CLI and HTTP

`polpo data list`, `describe`, `create`, `migrate`, `execute`, `query`,
`migrate-sql`, `migrations`, `rename` and `delete`
use the same API and canonical validators. `create` accepts a JSON file containing
`{name,schema}`; `execute` accepts `{operations,idempotencyKey?}`.
`query <resource> <file>` reads `{sql,params?,mode?,maxRows?,idempotencyKey?}`;
`migrate-sql <resource> <file>` reads the migration object above;
`migrations <resource>` shows applied SQL migrations. For self-hosting,
set `POLPO_API_KEY` and use `--url http://localhost:3890/api`.

| Method | Path (relative to the normal API prefix) |
|---|---|
| GET / POST | `/data` |
| GET / PATCH / DELETE | `/data/:resource` (DELETE requires `?expectedVersion=N`) |
| PUT | `/data/:resource/schema` |
| POST | `/data/:resource/transactions` |
| POST | `/data/:resource/query` |
| GET / POST | `/data/:resource/migrations` |

Errors use stable `data_*` codes and never return SQL or connection strings.
Provider credentials and physical schemas are absent from public resource data.

## Validation

Set `DATA_TEST_DATABASE_URL` to a dedicated PostgreSQL database and run the Data
tests in core, drizzle, server, tools and node. The PostgreSQL suite covers real
privilege denial, transactions, retries, concurrent mutations and schema changes.
The Node integration suite drives the SDK through HTTP and exercises an agent tool
and `defineTool` custom tool with grant revocation.

## Isolated runners

`createRemoteDataClient` from `@polpo-ai/core/data` (also exported by
`@polpo-ai/tools`) implements the same four-method capability over an
authenticated host gateway. It never retries writes automatically. The host owns
capability lifetime, identity binding and grant revalidation; the API has no DDL
or arbitrary server SQL operation. The `query` operation uses the same scoped validator.

A managed Node subprocess accepts `POLPO_DATA_CAPABILITY`, a base64 JSON envelope
with `url`, `token`, `sandboxId` and `agentName`. The runner consumes and removes it
before loading tools and refuses to reuse it for a different agent. This is a
host-only configuration surface, never an agent argument or persisted run field.
The ordinary local database adapter remains available for self-hosted runners.
Resource names cannot be UUID-shaped; UUID references always identify the resource,
even after renaming.

## Agent directories and deployment

In `.polpo/agents/<name>/agent.json`, select `allowedTools: ["database_*"]` or exact
tool names. There is no `data` field or `data/` directory in an agent definition.
Database resources and grants are managed by the trusted host, independently of
agent directories. `polpo deploy` and `polpo pull` do not synchronize database
schemas, migrations, records or grants. Apply checked-in migration JSON through
the administrative API, SDK or CLI as an explicit deployment step.
