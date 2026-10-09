import { Type } from "@sinclair/typebox";
import type { PolpoTool } from "@polpo-ai/core";
import { DataError, type DataClient } from "@polpo-ai/core/data";

export const ALL_DATA_TOOL_NAMES = [
  "database_list",
  "database_describe",
  "database_read",
  "database_insert",
  "database_update",
  "database_delete",
  "database_upsert",
  "database_transaction",
  "database_query",
] as const;
export type DataToolName = (typeof ALL_DATA_TOOL_NAMES)[number];
const resource = Type.String({
  description: "Database name or immutable ID",
});
const table = Type.String({ description: "Table name from database_describe" });
const values = Type.Record(Type.String(), Type.Unknown());
const idempotencyKey = Type.Optional(
  Type.String({
    maxLength: 200,
    description: "Reuse this key when retrying the same write",
  }),
);
const schemas = {
  database_query: Type.Object({
    resource,
    sql: Type.String({
      maxLength: 65536,
      description:
        "One PostgreSQL SELECT, INSERT, UPDATE or DELETE using logical table names and $1 parameters. No DDL or cross-database access.",
    }),
    params: Type.Optional(
      Type.Array(
        Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
        { maxItems: 1000 },
      ),
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("read"), Type.Literal("write")], {
        description:
          "Defaults to read. Mutations require write mode and write grants.",
      }),
    ),
    maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    idempotencyKey,
  }),
  database_list: Type.Object({}),
  database_describe: Type.Object({ resource }),
  database_read: Type.Object({
    resource,
    table,
    filter: Type.Optional(values),
    orderBy: Type.Optional(
      Type.Array(
        Type.Object({
          column: Type.String(),
          direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
        }),
      ),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  }),
  database_insert: Type.Object({ resource, table, values, idempotencyKey }),
  database_upsert: Type.Object({
    resource,
    table,
    values,
    onConflict: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
    idempotencyKey,
  }),
  database_update: Type.Object({
    resource,
    table,
    id: Type.String(),
    expectedVersion: Type.Integer({ minimum: 1 }),
    values,
    idempotencyKey,
  }),
  database_delete: Type.Object({
    resource,
    table,
    id: Type.String(),
    expectedVersion: Type.Integer({ minimum: 1 }),
    idempotencyKey,
  }),
  database_transaction: Type.Object({
    resource,
    operations: Type.Array(values, { minItems: 1, maxItems: 100 }),
    idempotencyKey,
  }),
};
const descriptions: Record<DataToolName, string> = {
  database_query:
    "Execute parameterized SQL within one granted database, including joins and aggregates. Read is the default. Explicit write mode supports record mutations; use idempotencyKey for retries and WHERE _version = ... for optimistic updates. Returns bounded rows and affected rowCount. Schema migrations remain administrative.",
  database_list: "List the databases granted to this agent.",
  database_describe:
    "Read the table definitions, column types and schema version of a granted database.",
  database_read:
    "Read typed records from one table with filters, ordering and pagination; no arbitrary SQL, joins or aggregations. Filters combine with AND; each column accepts eq, ne, gt, gte, lt, lte, in or isNull. Results include row IDs and revisions.",
  database_insert:
    "Insert a record into a table in a granted database. Use an idempotency key for retry safety.",
  database_update:
    "Update one record using its _id and expected _version. Refresh on conflict before deciding how to retry.",
  database_delete:
    "Delete one record using its _id and expected _version. Requires write access.",
  database_upsert:
    "Insert or update a record identified by a declared unique key. Use an idempotency key for retry safety.",
  database_transaction:
    "Execute an atomic batch of list/insert/update/delete/upsert operations within one database; every operation commits or all roll back. Accepts structured operations, not SQL.",
};

export function createDataTools(
  client: DataClient,
  allowedTools: readonly string[],
): PolpoTool<any>[] {
  return ALL_DATA_TOOL_NAMES.filter((name) => allowedTools.includes(name)).map(
    (name) => ({
      name,
      label: name.replaceAll("_", " "),
      description: descriptions[name],
      parameters: schemas[name],
      requiresSandbox: false,
      async execute(_id: string, args: any) {
        let result: unknown;
        if (name === "database_list") result = await client.list();
        else if (name === "database_describe")
          result = await client.describe(args.resource);
        else if (name === "database_query") {
          if (!client.query)
            throw new DataError(
              "data_invalid",
              "SQL queries are not supported by this provider",
            );
          const { resource: ref, ...input } = args;
          result = await client.query(ref, {
            ...input,
            maxRows: input.maxRows ?? 20,
          });
        } else {
          const { resource: ref, idempotencyKey: key, ...input } = args;
          const operations =
            name === "database_transaction"
              ? input.operations
              : [
                  {
                    ...input,
                    op:
                      name === "database_read"
                        ? "list"
                        : name.slice("database_".length),
                    ...(name === "database_read"
                      ? { limit: input.limit ?? 20 }
                      : {}),
                  },
                ];
          result = await client.execute(ref, {
            operations,
            ...(key ? { idempotencyKey: key } : {}),
          });
        }
        const text = JSON.stringify(result);
        if (
          text.length > 30000 &&
          name === "database_query" &&
          args.mode === "write"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  committed: true,
                  rowCount: (result as any).rowCount,
                  rowsOmitted: true,
                }),
              },
            ],
            details: { resource: args.resource },
          };
        }
        // Writes have already committed: never report failure merely because their
        // response is large. Return identities/revisions so a caller can read later.
        if (
          text.length > 30000 &&
          name !== "database_read" &&
          name !== "database_describe" &&
          name !== "database_list" &&
          name !== "database_query"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  committed: true,
                  results: (result as any[]).map((r) => ({
                    rows: r.rows.map((row: any) => ({
                      _id: row._id,
                      _version: row._version,
                    })),
                  })),
                }),
              },
            ],
            details: { resource: args.resource },
          };
        }
        if (text.length > 30000)
          throw new DataError(
            "data_limit",
            "Tool response is too large; narrow the query or lower the limit",
          );
        return {
          content: [{ type: "text" as const, text }],
          details: { resource: args.resource },
        };
      },
    }),
  );
}
