import { z } from "zod";

export type DataErrorCode =
  | "data_invalid"
  | "data_forbidden"
  | "data_not_found"
  | "data_conflict"
  | "data_constraint"
  | "data_limit"
  | "data_unavailable";
export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DataError";
  }
}
const invalid = (message: string): never => {
  throw new DataError("data_invalid", message);
};
const forbidden = (): never => {
  throw new DataError("data_forbidden", "Data access is not granted");
};
const forbiddenNames = new Set(["constructor", "prototype", "__proto__"]);
export const DataIdentifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((v) => !forbiddenNames.has(v), "Reserved identifier");
export const DataIndexName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/)
  .refine((v) => !forbiddenNames.has(v), "Reserved index name");
export const DataName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/)
  .refine((v) => !forbiddenNames.has(v), "Reserved name")
  .refine(
    (v) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v),
    "UUIDs are reserved for resource identities",
  );
const columnRef = z
  .string()
  .refine(
    (v) =>
      ["_id", "_version", "_created_at", "_updated_at"].includes(v) ||
      DataIdentifier.safeParse(v).success,
    "Invalid column",
  );
const uuid = z.string().uuid();
export const DataColumnSchema = z
  .object({
    type: z.enum([
      "text",
      "integer",
      "number",
      "boolean",
      "timestamp",
      "uuid",
      "json",
    ]),
    nullable: z.boolean().optional(),
    unique: z.boolean().optional(),
    references: z
      .object({ table: DataIdentifier, column: columnRef })
      .strict()
      .optional(),
  })
  .strict();
export type DataColumn = z.infer<typeof DataColumnSchema>;
export const DataTableSchema = z
  .object({
    columns: z
      .record(DataIdentifier, DataColumnSchema)
      .refine((v) => Object.keys(v).length <= 64, "At most 64 columns"),
    indexes: z
      .array(
        z
          .object({
            name: DataIndexName.optional(),
            columns: z.array(DataIdentifier).min(1).max(4),
            unique: z.boolean().optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();
export const DataSchema = z
  .object({
    tables: z
      .record(DataIdentifier, DataTableSchema)
      .refine((v) => Object.keys(v).length <= 32, "At most 32 tables"),
  })
  .strict()
  .superRefine((schema, ctx) => {
    const indexNames = new Set<string>();
    for (const [tableName, table] of Object.entries(schema.tables)) {
      for (const [position, index] of (table.indexes ?? []).entries()) {
        const indexName = index.name ?? `idx_${tableName}_${position}`;
        if (indexNames.has(indexName))
          ctx.addIssue({
            code: "custom",
            message: "Index names must be unique within a database",
            path: ["tables", tableName, "indexes", position, "name"],
          });
        indexNames.add(indexName);
        if (
          new Set(index.columns).size !== index.columns.length ||
          index.columns.some((c) => !Object.hasOwn(table.columns, c))
        )
          ctx.addIssue({
            code: "custom",
            message: "Index must reference distinct existing columns",
            path: ["tables", tableName, "indexes"],
          });
        if (index.columns.some((c) => table.columns[c]?.type === "json"))
          ctx.addIssue({
            code: "custom",
            message: "JSON indexes are not supported",
            path: ["tables", tableName, "indexes"],
          });
      }
      for (const [name, column] of Object.entries(table.columns)) {
        if (column.type === "json" && (column.unique || column.references))
          ctx.addIssue({
            code: "custom",
            message: "JSON cannot be a unique key or reference",
            path: ["tables", tableName, "columns", name],
          });
        if (!column.references) continue;
        const target = schema.tables[column.references.table];
        const targetColumn =
          column.references.column === "_id"
            ? { type: "uuid", unique: true }
            : target?.columns[column.references.column];
        const unique =
          targetColumn?.unique ||
          target?.indexes?.some(
            (i) =>
              i.unique &&
              i.columns.length === 1 &&
              i.columns[0] === column.references!.column,
          );
        if (
          !target ||
          !targetColumn ||
          !unique ||
          targetColumn.type !== column.type
        )
          ctx.addIssue({
            code: "custom",
            message: "Reference must target a unique column of the same type",
            path: ["tables", tableName, "columns", name],
          });
      }
    }
  });
export type DataSchemaDefinition = z.infer<typeof DataSchema>;
export type DataTable = z.infer<typeof DataTableSchema>;
export const CreateDataSchema = z
  .object({ name: DataName, schema: DataSchema })
  .strict();
export const MigrateDataSchema = z
  .object({ expectedVersion: z.number().int().positive(), schema: DataSchema })
  .strict();
export const RenameDataSchema = z
  .object({ expectedVersion: z.number().int().positive(), name: DataName })
  .strict();
export type CreateDataInput = z.infer<typeof CreateDataSchema>;
export type DataMigration = z.infer<typeof MigrateDataSchema>;
export type DataRename = z.infer<typeof RenameDataSchema>;
export interface DataResource {
  id: string;
  name: string;
  schema: DataSchemaDefinition;
  schemaVersion: number;
  createdAt: string;
}
export type DataValue =
  | null
  | string
  | number
  | boolean
  | DataValue[]
  | { [key: string]: DataValue };
export type DataRow = Record<string, DataValue> & {
  _id: string;
  _version: number;
  _created_at: string;
  _updated_at: string;
};
/** Canonical recursive JSON values, also named by API schema generators. */
export const DataValueSchema = z.json();
const json = DataValueSchema;
const filterOperators = z
  .object({
    eq: json.optional(),
    ne: json.optional(),
    gt: json.optional(),
    gte: json.optional(),
    lt: json.optional(),
    lte: json.optional(),
    in: z.array(json).min(1).max(100).optional(),
    isNull: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Empty filter");
export const DataFilterSchema = z
  .record(columnRef, filterOperators)
  .refine((v) => Object.keys(v).length <= 16, "At most 16 filters");
const values = z.record(DataIdentifier, json);
export const DataOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("list"),
      table: DataIdentifier,
      filter: DataFilterSchema.optional(),
      orderBy: z
        .array(
          z
            .object({ column: columnRef, direction: z.enum(["asc", "desc"]) })
            .strict(),
        )
        .max(3)
        .optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    })
    .strict(),
  z.object({ op: z.literal("insert"), table: DataIdentifier, values }).strict(),
  z
    .object({
      op: z.literal("upsert"),
      table: DataIdentifier,
      values,
      onConflict: z.array(DataIdentifier).min(1).max(4),
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      table: DataIdentifier,
      id: uuid,
      expectedVersion: z.number().int().positive(),
      values,
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      table: DataIdentifier,
      id: uuid,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export const DataBatchSchema = z
  .object({
    operations: z.array(DataOperationSchema).min(1).max(100),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();
export type DataOperation = z.infer<typeof DataOperationSchema>;
export type DataBatch = z.infer<typeof DataBatchSchema>;
export type DataListQuery = Omit<
  Extract<DataOperation, { op: "list" }>,
  "op" | "table"
>;
export type DataResult = {
  rows: DataRow[];
  total?: number;
  nextOffset?: number | null;
};
const sqlStatement = z
  .object({
    sql: z.string().trim().min(1).max(65536),
    params: z
      .array(
        z.union([
          z.string().max(65536),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .max(1000)
      .optional(),
  })
  .strict();
export const DataQuerySchema = sqlStatement.extend({
  mode: z.enum(["read", "write"]).optional(),
  maxRows: z.number().int().min(1).max(200).optional(),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
});
export type DataQuery = z.infer<typeof DataQuerySchema>;
export type DataQueryResult = {
  rows: Record<string, DataValue>[];
  rowCount: number;
  truncated: boolean;
};
export const DataSqlMigrationSchema = z
  .object({
    id: DataIdentifier,
    expectedVersion: z.number().int().positive(),
    statements: z.array(sqlStatement).min(1).max(100),
    allowDestructive: z.boolean().optional(),
  })
  .strict();
export type DataSqlMigration = z.infer<typeof DataSqlMigrationSchema>;
export type DataMigrationRecord = {
  id: string;
  checksum: string;
  schemaVersion: number;
  appliedAt: string;
};
/** Host-computed permissions; never accept these from query arguments. */
export type DataQueryAccess = { readTables: string[]; writeTables: string[] };
export const DataGrantSchema = z
  .object({
    resource: z.union([uuid, z.literal("*")]),
    tables: z.array(DataIdentifier).min(1).max(32).optional(),
    actions: z
      .array(z.enum(["read", "write", "manage"]))
      .min(1)
      .max(3),
  })
  .strict();
export type DataGrant = z.infer<typeof DataGrantSchema>;
export interface DataAccess {
  scope: string;
  principalId: string;
  grants: readonly DataGrant[];
}
export interface DataCapabilities {
  transactions: boolean;
  relations: boolean;
  schemaEvolution: "additive";
  sql?: { dialect: "postgresql"; migrations: boolean };
}
export interface DataProvider {
  readonly capabilities: DataCapabilities;
  list(scope: string): Promise<DataResource[]>;
  get(scope: string, reference: string): Promise<DataResource | undefined>;
  create(scope: string, input: CreateDataInput): Promise<DataResource>;
  migrate(
    scope: string,
    id: string,
    input: DataMigration,
  ): Promise<DataResource>;
  rename(scope: string, id: string, input: DataRename): Promise<DataResource>;
  remove(scope: string, id: string, expectedVersion: number): Promise<void>;
  execute(
    scope: string,
    id: string,
    principalId: string,
    batch: DataBatch,
  ): Promise<DataResult[]>;
  query?(
    scope: string,
    id: string,
    principalId: string,
    input: DataQuery,
    access: DataQueryAccess,
  ): Promise<DataQueryResult>;
  migrateSql?(
    scope: string,
    id: string,
    input: DataSqlMigration,
  ): Promise<DataResource>;
  migrations?(scope: string, id: string): Promise<DataMigrationRecord[]>;
}

/** Bound capability safe to pass to a custom tool; no credentials or mutable host context. */
export interface DataClient {
  list(): Promise<DataResource[]>;
  describe(reference: string): Promise<DataResource>;
  execute(reference: string, batch: DataBatch): Promise<DataResult[]>;
  query?(reference: string, input: DataQuery): Promise<DataQueryResult>;
}

/** Re-resolve authorization on each call; expose no provider or host internals. */
export function createDataCapability(
  resolve: () => DataClient | Promise<DataClient>,
): DataClient {
  return Object.freeze({
    list: async () => (await resolve()).list(),
    describe: async (reference: string) =>
      (await resolve()).describe(reference),
    execute: async (reference: string, batch: DataBatch) =>
      (await resolve()).execute(reference, batch),
    query: async (reference: string, input: DataQuery) => {
      const client = await resolve();
      if (!client.query)
        throw new DataError(
          "data_invalid",
          "SQL queries are not supported by this provider",
        );
      return client.query(reference, input);
    },
  });
}

export function parseData<T>(schema: z.ZodType<T>, input: unknown): T {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return invalid("Expected JSON input");
  }
  if (!serialized || new TextEncoder().encode(serialized).length > 262144)
    throw new DataError("data_limit", "Data request exceeds 256 KiB");
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return invalid(
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .slice(0, 5)
        .join("; "),
    );
  return parsed.data;
}
export function dataColumn(table: DataTable, name: string): DataColumn {
  const system: Record<string, DataColumn> = {
    _id: { type: "uuid" },
    _version: { type: "integer" },
    _created_at: { type: "timestamp" },
    _updated_at: { type: "timestamp" },
  };
  const column = Object.hasOwn(system, name)
    ? system[name]
    : Object.hasOwn(table.columns, name)
      ? table.columns[name]
      : undefined;
  return column ?? invalid(`Unknown column: ${name}`);
}
function validateValue(column: DataColumn, value: unknown, name: string): void {
  if (value === null) {
    if (column.nullable) return;
    return invalid(`${name} cannot be null`);
  }
  const valid =
    column.type === "json"
      ? json.safeParse(value).success
      : column.type === "text"
        ? typeof value === "string" &&
          new TextEncoder().encode(value).byteLength <= 65536
        : column.type === "boolean"
          ? typeof value === "boolean"
          : column.type === "integer"
            ? typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= -2147483648 &&
              value <= 2147483647
            : column.type === "number"
              ? typeof value === "number" && Number.isFinite(value)
              : column.type === "uuid"
                ? uuid.safeParse(value).success
                : typeof value === "string" &&
                  z.iso.datetime({ offset: true }).safeParse(value).success;
  if (!valid) invalid(`Invalid ${column.type} value for ${name}`);
}
export function validateDataOperation(
  schema: DataSchemaDefinition,
  input: unknown,
): DataOperation {
  const operation = parseData(DataOperationSchema, input);
  const table = Object.hasOwn(schema.tables, operation.table)
    ? schema.tables[operation.table]
    : undefined;
  if (!table) return invalid(`Unknown table: ${operation.table}`);
  if (operation.op === "list") {
    for (const order of operation.orderBy ?? [])
      if (dataColumn(table, order.column).type === "json")
        invalid("JSON ordering is not supported");
    if (
      new Set(operation.orderBy?.map((o) => o.column)).size !==
      (operation.orderBy?.length ?? 0)
    )
      invalid("Duplicate ordering column");
    for (const [name, operators] of Object.entries(operation.filter ?? {})) {
      const column = dataColumn(table, name);
      for (const [operator, value] of Object.entries(operators)) {
        if (operator === "isNull") continue;
        if (column.type === "json" && !["eq", "ne", "in"].includes(operator))
          invalid("JSON only supports equality filters");
        if (column.type === "boolean" && !["eq", "ne", "in"].includes(operator))
          invalid("Boolean only supports equality filters");
        for (const item of operator === "in" ? (value as unknown[]) : [value]) {
          if (item === null) {
            if (!["eq", "ne", "in"].includes(operator))
              invalid("Null cannot be ordered");
          } else validateValue(column, item, name);
        }
      }
    }
  } else if (operation.op !== "delete") {
    if (Object.keys(operation.values).length === 0)
      invalid("Values cannot be empty");
    for (const [name, value] of Object.entries(operation.values)) {
      if (!Object.hasOwn(table.columns, name))
        invalid(`Unknown column: ${name}`);
      validateValue(table.columns[name], value, name);
    }
    if (operation.op !== "update")
      for (const [name, column] of Object.entries(table.columns))
        if (!column.nullable && !Object.hasOwn(operation.values, name))
          invalid(`Missing required column: ${name}`);
    if (operation.op === "upsert") {
      const keys = operation.onConflict;
      const unique =
        (keys.length === 1 && table.columns[keys[0]]?.unique) ||
        table.indexes?.some(
          (i) =>
            i.unique &&
            i.columns.length === keys.length &&
            i.columns.every((c) => keys.includes(c)),
        );
      if (
        !unique ||
        new Set(keys).size !== keys.length ||
        keys.some((k) => operation.values[k] == null)
      )
        invalid("Upsert conflict columns must form a populated unique key");
    }
  }
  return operation;
}

export function canonicalDataJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalDataJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalDataJson((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

export class DataService implements DataClient {
  readonly #access: DataAccess;
  constructor(
    private readonly provider: DataProvider,
    access: DataAccess,
  ) {
    if (
      !access.scope ||
      !access.principalId ||
      access.scope.length > 200 ||
      access.principalId.length > 200
    )
      invalid("A bounded host scope and principal are required");
    this.#access = {
      scope: access.scope,
      principalId: access.principalId,
      grants: parseData(z.array(DataGrantSchema).max(100), access.grants),
    };
  }
  private allows(
    resource: string,
    action: "read" | "write" | "manage",
    table?: string,
  ): boolean {
    return this.#access.grants.some(
      (g) =>
        (g.resource === "*" || g.resource === resource) &&
        (g.actions.includes(action) || g.actions.includes("manage")) &&
        (action === "manage"
          ? !g.tables
          : !table || !g.tables || g.tables.includes(table)),
    );
  }
  private async resolve(reference: string): Promise<DataResource> {
    if (!this.#access.grants.length) return forbidden();
    if (
      typeof reference !== "string" ||
      !(
        DataName.safeParse(reference).success ||
        uuid.safeParse(reference).success
      )
    )
      invalid("Invalid Data reference");
    const resource = await this.provider.get(this.#access.scope, reference);
    if (!resource)
      throw new DataError("data_not_found", "Data resource not found");
    if (
      !["read", "write", "manage"].some((action) =>
        this.allows(resource.id, action as "read"),
      )
    )
      return forbidden();
    return resource;
  }
  private visible(resource: DataResource): DataResource {
    return {
      ...resource,
      schema: {
        tables: Object.fromEntries(
          Object.entries(resource.schema.tables).filter(
            ([table]) =>
              this.allows(resource.id, "read", table) ||
              this.allows(resource.id, "write", table),
          ),
        ),
      },
    };
  }
  async list(): Promise<DataResource[]> {
    if (!this.#access.grants.length) return [];
    return (await this.provider.list(this.#access.scope))
      .filter(
        (r) =>
          this.allows(r.id, "read") ||
          this.allows(r.id, "write") ||
          this.allows(r.id, "manage"),
      )
      .map((r) => this.visible(r));
  }
  async describe(reference: string): Promise<DataResource> {
    return this.visible(await this.resolve(reference));
  }
  async create(input: CreateDataInput): Promise<DataResource> {
    if (!this.allows("*", "manage")) return forbidden();
    return this.provider.create(
      this.#access.scope,
      parseData(CreateDataSchema, input),
    );
  }
  async migrate(
    reference: string,
    input: DataMigration,
  ): Promise<DataResource> {
    const resource = await this.resolve(reference);
    if (!this.allows(resource.id, "manage")) return forbidden();
    return this.provider.migrate(
      this.#access.scope,
      resource.id,
      parseData(MigrateDataSchema, input),
    );
  }
  async rename(reference: string, input: DataRename): Promise<DataResource> {
    const resource = await this.resolve(reference);
    if (!this.allows(resource.id, "manage")) return forbidden();
    return this.provider.rename(
      this.#access.scope,
      resource.id,
      parseData(RenameDataSchema, input),
    );
  }
  async remove(reference: string, expectedVersion: number): Promise<void> {
    const resource = await this.resolve(reference);
    if (!this.allows(resource.id, "manage")) return forbidden();
    return this.provider.remove(
      this.#access.scope,
      resource.id,
      parseData(z.number().int().positive(), expectedVersion),
    );
  }
  async execute(reference: string, input: DataBatch): Promise<DataResult[]> {
    const batch = parseData(DataBatchSchema, input);
    const resource = await this.resolve(reference);
    for (const operation of batch.operations) {
      if (
        !this.allows(
          resource.id,
          operation.op === "list" ? "read" : "write",
          operation.table,
        )
      )
        return forbidden();
      validateDataOperation(resource.schema, operation);
    }
    if (batch.operations.length > 1 && !this.provider.capabilities.transactions)
      invalid("Provider does not support atomic batches");
    return this.provider.execute(
      this.#access.scope,
      resource.id,
      this.#access.principalId,
      batch,
    );
  }
  async query(reference: string, input: DataQuery): Promise<DataQueryResult> {
    const query = parseData(DataQuerySchema, input);
    const resource = await this.resolve(reference);
    const action = query.mode === "write" ? "write" : "read";
    if (!this.allows(resource.id, action)) return forbidden();
    if (!this.provider.capabilities.sql || !this.provider.query)
      return invalid("SQL queries are not supported by this provider");
    const tables = Object.keys(resource.schema.tables);
    return this.provider.query(
      this.#access.scope,
      resource.id,
      this.#access.principalId,
      query,
      {
        readTables: tables.filter((table) =>
          this.allows(resource.id, "read", table),
        ),
        writeTables: tables.filter((table) =>
          this.allows(resource.id, "write", table),
        ),
      },
    );
  }
  async migrateSql(
    reference: string,
    input: DataSqlMigration,
  ): Promise<DataResource> {
    const resource = await this.resolve(reference);
    if (!this.allows(resource.id, "manage")) return forbidden();
    if (
      !this.provider.capabilities.sql?.migrations ||
      !this.provider.migrateSql
    )
      return invalid("SQL migrations are not supported by this provider");
    return this.provider.migrateSql(
      this.#access.scope,
      resource.id,
      parseData(DataSqlMigrationSchema, input),
    );
  }
  async migrations(reference: string): Promise<DataMigrationRecord[]> {
    const resource = await this.resolve(reference);
    if (!this.allows(resource.id, "manage")) return forbidden();
    if (!this.provider.migrations)
      return invalid("SQL migrations are not supported by this provider");
    return this.provider.migrations(this.#access.scope, resource.id);
  }
}

/** Credential-bearing transport for a trusted host. Returned tools see only DataClient. */
export function createRemoteDataClient(options: {
  url: string;
  token: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}): DataClient {
  const url = new URL(options.url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !options.token
  )
    throw new DataError("data_invalid", "Invalid remote Data binding");
  const headers = Object.freeze({
    ...options.headers,
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  });
  const fetcher = options.fetch ?? fetch;
  const call = async <T>(input: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new DataError(
        "data_unavailable",
        "Data gateway unavailable; retry writes with the same idempotency key",
      );
    }
    let body: { ok?: boolean; data?: T; code?: string; error?: string };
    try {
      body = await response.json();
    } catch {
      throw new DataError("data_unavailable", "Invalid Data gateway response");
    }
    if (!response.ok || !body?.ok) {
      const codes = [
        "data_invalid",
        "data_forbidden",
        "data_not_found",
        "data_conflict",
        "data_constraint",
        "data_limit",
        "data_unavailable",
      ];
      const code = codes.includes(body?.code ?? "")
        ? (body.code as DataErrorCode)
        : "data_unavailable";
      throw new DataError(
        code,
        codes.includes(body?.code ?? "") && typeof body.error === "string"
          ? body.error
          : "Data gateway unavailable",
      );
    }
    if (!Object.hasOwn(body, "data"))
      throw new DataError("data_unavailable", "Invalid Data gateway response");
    return body.data as T;
  };
  const reference = (ref: string) => parseData(z.union([DataName, uuid]), ref);
  return Object.freeze({
    list: () => call<DataResource[]>({ operation: "list" }),
    describe: (ref: string) =>
      call<DataResource>({ operation: "describe", resource: reference(ref) }),
    execute: (ref: string, batch: DataBatch) =>
      call<DataResult[]>({
        operation: "execute",
        resource: reference(ref),
        batch: parseData(DataBatchSchema, batch),
      }),
    query: (ref: string, query: DataQuery) =>
      call<DataQueryResult>({
        operation: "query",
        resource: reference(ref),
        query: parseData(DataQuerySchema, query),
      }),
  });
}
