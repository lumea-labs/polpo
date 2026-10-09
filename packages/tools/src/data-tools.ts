import { Type } from "@sinclair/typebox";
import type { PolpoTool } from "@polpo-ai/core";
import { DataError, type DataClient } from "@polpo-ai/core/data";

export const ALL_DATA_TOOL_NAMES = [
  "data_list",
  "data_describe",
  "data_read",
  "data_insert",
  "data_update",
  "data_delete",
  "data_upsert",
  "data_transaction",
] as const;
export type DataToolName = (typeof ALL_DATA_TOOL_NAMES)[number];
const resource = Type.String({
  description: "Data resource name or immutable ID",
});
const table = Type.String({ description: "Table name from data_describe" });
const values = Type.Record(Type.String(), Type.Unknown());
const idempotencyKey = Type.Optional(
  Type.String({
    maxLength: 200,
    description: "Reuse this key when retrying the same write",
  }),
);
const schemas = {
  data_list: Type.Object({}),
  data_describe: Type.Object({ resource }),
  data_read: Type.Object({
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
  data_insert: Type.Object({ resource, table, values, idempotencyKey }),
  data_upsert: Type.Object({
    resource,
    table,
    values,
    onConflict: Type.Array(Type.String(), { minItems: 1, maxItems: 4 }),
    idempotencyKey,
  }),
  data_update: Type.Object({
    resource,
    table,
    id: Type.String(),
    expectedVersion: Type.Integer({ minimum: 1 }),
    values,
    idempotencyKey,
  }),
  data_delete: Type.Object({
    resource,
    table,
    id: Type.String(),
    expectedVersion: Type.Integer({ minimum: 1 }),
    idempotencyKey,
  }),
  data_transaction: Type.Object({
    resource,
    operations: Type.Array(values, { minItems: 1, maxItems: 100 }),
    idempotencyKey,
  }),
};
const descriptions: Record<DataToolName, string> = {
  data_list: "List the Data resources granted to this agent.",
  data_describe:
    "Read the table definitions, column types and schema version of a granted Data resource.",
  data_read:
    "Read typed records. Filters combine with AND; each column accepts eq, ne, gt, gte, lt, lte, in or isNull. Results include row IDs and revisions.",
  data_insert:
    "Insert a record into a granted Data table. Use an idempotency key for retry safety.",
  data_update:
    "Update one record using its _id and expected _version. Refresh on conflict before deciding how to retry.",
  data_delete:
    "Delete one record using its _id and expected _version. Requires write access.",
  data_upsert:
    "Insert or update a record identified by a declared unique key. Use an idempotency key for retry safety.",
  data_transaction:
    "Execute an atomic batch of list/insert/update/delete/upsert operations within one Data resource; every operation commits or all roll back.",
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
        if (name === "data_list") result = await client.list();
        else if (name === "data_describe")
          result = await client.describe(args.resource);
        else {
          const { resource: ref, idempotencyKey: key, ...input } = args;
          const operations =
            name === "data_transaction"
              ? input.operations
              : [
                  {
                    ...input,
                    op: name === "data_read" ? "list" : name.slice(5),
                    ...(name === "data_read"
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
        // Writes have already committed: never report failure merely because their
        // response is large. Return identities/revisions so a caller can read later.
        if (
          text.length > 30000 &&
          name !== "data_read" &&
          name !== "data_describe" &&
          name !== "data_list"
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
