import { OpenAPIHono, z } from "@hono/zod-openapi";
import {
  CreateDataSchema,
  DataBatchSchema,
  DataValueSchema,
  DataQuerySchema,
  DataSchema,
  DataSqlMigrationSchema,
  MigrateDataSchema,
  RenameDataSchema,
} from "@polpo-ai/core/data";

/** Register the schemas used by DataService without adding a second validator. */
export function registerDataOpenApi(app: OpenAPIHono) {
  // JSON is recursive, but any JSON value is represented by these six types.
  // Explicit metadata avoids both infinite lazy expansion and a nullable $ref
  // being wrapped in oneOf(null, ref-that-already-allows-null).
  // Use public Zod metadata rather than .openapi(): canonical schemas may
  // have been created before the host initialized its OpenAPI extension.
  DataValueSchema.register(z.globalRegistry, {
    type: ["string", "number", "boolean", "object", "array", "null"],
    description:
      "Any JSON value; arrays and objects may contain nested JSON values.",
  });
  const resource = z.object({
    id: z.string().uuid(),
    name: z.string(),
    schema: DataSchema,
    schemaVersion: z.number().int(),
    createdAt: z.string(),
  });
  const row = z.record(z.string(), z.unknown());
  const queryResult = z.object({
    rows: z.array(row),
    rowCount: z.number().int(),
    truncated: z.boolean(),
  });
  const batchResult = z.array(
    z.object({
      rows: z.array(row),
      total: z.number().int().optional(),
      nextOffset: z.number().int().nullable().optional(),
    }),
  );
  const history = z.array(
    z.object({
      id: z.string(),
      checksum: z.string(),
      schemaVersion: z.number().int(),
      appliedAt: z.string(),
    }),
  );
  const error = z.object({
    ok: z.literal(false),
    code: z.string(),
    error: z.string(),
  });
  const definitions = [
    {
      method: "get",
      path: "/",
      summary: "List accessible databases",
      result: z.array(resource),
    },
    {
      method: "post",
      path: "/",
      summary: "Create a database and its tables",
      body: CreateDataSchema,
      result: resource,
      status: 201,
    },
    {
      method: "get",
      path: "/{resource}",
      summary: "Describe a database",
      result: resource,
    },
    {
      method: "patch",
      path: "/{resource}",
      summary: "Rename a database",
      body: RenameDataSchema,
      result: resource,
    },
    {
      method: "put",
      path: "/{resource}/schema",
      summary: "Apply an additive table schema migration",
      body: MigrateDataSchema,
      result: resource,
    },
    {
      method: "delete",
      path: "/{resource}",
      summary: "Delete a database and its records",
      result: z.object({ deleted: z.literal(true) }),
      query: z.object({ expectedVersion: z.string().regex(/^[1-9][0-9]*$/) }),
    },
    {
      method: "post",
      path: "/{resource}/transactions",
      summary: "Run an atomic batch of structured record operations",
      body: DataBatchSchema,
      result: batchResult,
    },
    {
      method: "post",
      path: "/{resource}/query",
      summary: "Run a scoped SQL query or mutation",
      body: DataQuerySchema,
      result: queryResult,
    },
    {
      method: "get",
      path: "/{resource}/migrations",
      summary: "List applied SQL migrations (manage grant)",
      result: history,
    },
    {
      method: "post",
      path: "/{resource}/migrations",
      summary: "Apply an atomic SQL migration (manage grant)",
      body: DataSqlMigrationSchema,
      result: resource,
    },
  ] as const;
  for (const definition of definitions)
    app.openAPIRegistry.registerPath({
      method: definition.method,
      path: definition.path,
      tags: ["Databases"],
      summary: definition.summary,
      description:
        "Requires host authentication and current database grants. Names and stable UUIDs are accepted as resource references. SQL availability and dialect depend on the provider; the PostgreSQL adapter supports a bounded subset, not arbitrary server SQL.",
      request: {
        ...(definition.path.includes("{resource}")
          ? { params: z.object({ resource: z.string().min(1).max(128) }) }
          : {}),
        ...("body" in definition
          ? {
              body: {
                required: true,
                content: { "application/json": { schema: definition.body } },
              },
            }
          : {}),
        ...("query" in definition ? { query: definition.query } : {}),
      },
      responses: {
        ["status" in definition ? definition.status : 200]: {
          description: "Success",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.literal(true),
                data: definition.result,
              }),
            },
          },
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 413, 422, 503].map((status) => [
            status,
            {
              description:
                "Invalid, denied, conflicting, bounded or unavailable request",
              content: { "application/json": { schema: error } },
            },
          ]),
        ),
      },
    });
}
