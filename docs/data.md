# Application Data

Data stores structured application records independently from Polpo runtime
storage and file Volumes. It does not implement application user authentication.
Use server-side Polpo credentials; an application's backend owns user access rules.

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
create resources. Assign built-in tools using `allowedTools: ["data_*"]`.
Custom tools receive `ctx.data.list()`, `.describe(resource)` and
`.execute(resource, {operations, idempotencyKey})` with the same agent grants.
Local custom tools run as trusted Node code; these capabilities do not sandbox
arbitrary in-process code. Managed hosts must use an isolated capability gateway.

Programmatic hosts can use `createNodeDataRuntime` from `@polpo-ai/node` and supply
`AppOptions.data`; other hosts compose `DataService` from `@polpo-ai/core/data`,
`PostgresDataProvider` from `@polpo-ai/drizzle/data` and `dataRoutes` from
`@polpo-ai/server`. Always authenticate before resolving a scoped service.
Call the runtime's `close()` during shutdown when managing it programmatically.

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

## CLI and HTTP

`polpo data list`, `describe`, `create`, `migrate`, `execute`, `rename` and `delete`
use the same API and canonical validators. `create` accepts a JSON file containing
`{name,schema}`; `execute` accepts `{operations,idempotencyKey?}`. For self-hosting,
set `POLPO_DATA_API_KEY` and use `--url http://localhost:3890/api`.

| Method | Path (relative to the normal API prefix) |
|---|---|
| GET / POST | `/data` |
| GET / PATCH / DELETE | `/data/:resource` (DELETE requires `?expectedVersion=N`) |
| PUT | `/data/:resource/schema` |
| POST | `/data/:resource/transactions` |

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
`@polpo-ai/tools`) implements the same three-method capability over an
authenticated host gateway. It never retries writes automatically. The host owns
capability lifetime, identity binding and grant revalidation; the API has no DDL
or arbitrary SQL operation.

A managed Node subprocess accepts `POLPO_DATA_CAPABILITY`, a base64 JSON envelope
with `url`, `token`, `sandboxId` and `agentName`. The runner consumes and removes it
before loading tools and refuses to reuse it for a different agent. This is a
host-only configuration surface, never an agent argument or persisted run field.
The ordinary local database adapter remains available for self-hosted runners.
Resource names cannot be UUID-shaped; UUID references always identify the resource,
even after renaming.
