import {
  DataError,
  DataSchema,
  DataQuerySchema,
  DataSqlMigrationSchema,
  canonicalDataJson,
  dataColumn,
  parseData,
  validateDataOperation,
  type CreateDataInput,
  type DataBatch,
  type DataColumn,
  type DataMigration,
  type DataOperation,
  type DataProvider,
  type DataRename,
  type DataResource,
  type DataResult,
  type DataRow,
  type DataSchemaDefinition,
  type DataTable,
  type DataQuery,
  type DataQueryAccess,
  type DataQueryResult,
  type DataSqlMigration,
  type DataMigrationRecord,
} from "@polpo-ai/core/data";
import { compileQuery, migrationStatement } from "./sql.js";
import { dataValueConstraint, finiteDataJson } from "./constraints.js";

/** Drivers must keep every transaction callback on one connection. */
export interface DataSqlExecutor {
  query(text: string, values?: unknown[]): Promise<Record<string, any>[]>;
}
export interface DataSqlDatabase extends DataSqlExecutor {
  transaction<T>(fn: (tx: DataSqlExecutor) => Promise<T>): Promise<T>;
}
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value))
    throw new DataError("data_invalid", "Invalid SQL identifier");
  return `"${value}"`;
};
const namespace = (id: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    throw new DataError("data_invalid", "Invalid Data identity");
  return `data_${id.replaceAll("-", "")}`;
};
const qualified = (id: string, table: string) =>
  `${identifier(namespace(id))}.${identifier(table)}`;
const sqlTypes = {
  text: "text",
  integer: "integer",
  number: "double precision",
  boolean: "boolean",
  timestamp: "timestamptz",
  uuid: "uuid",
  json: "jsonb",
} as const;
function resource(row: Record<string, any>): DataResource {
  return {
    id: row.id,
    name: row.name,
    schema: row.definition,
    schemaVersion: row.version,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function rowResult(row: Record<string, any>, table: DataTable): DataRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value != null &&
      (value instanceof Date ||
        key === "_created_at" ||
        key === "_updated_at" ||
        table.columns[key]?.type === "timestamp")
        ? new Date(value).toISOString()
        : value,
    ]),
  ) as DataRow;
}
function safeError(error: unknown): never {
  if (error instanceof DataError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === "57014")
    throw new DataError(
      "data_limit",
      "Database query exceeded its execution limit",
    );
  if (code === "42501")
    throw new DataError(
      "data_forbidden",
      "Database operation is not permitted",
    );
  if (code?.startsWith("42") || code === "2BP01")
    throw new DataError(
      "data_invalid",
      "SQL is incompatible with the current database schema",
    );
  if (code?.startsWith("22"))
    throw new DataError(
      "data_constraint",
      "SQL values or calculations are invalid for the requested operation",
    );
  if (code === "23505")
    throw new DataError("data_conflict", "A unique value already exists");
  if (
    ["23503", "23502", "23514", "22003", "22007", "22P02"].includes(code ?? "")
  )
    throw new DataError(
      "data_constraint",
      "The operation violates a data constraint",
    );
  if (["40001", "40P01", "55P03"].includes(code ?? ""))
    throw new DataError(
      "data_conflict",
      "Concurrent operation; retry with the same idempotency key",
    );
  throw new DataError(
    "data_unavailable",
    "Data backend unavailable; retry with the same idempotency key",
  );
}

export class PostgresDataProvider implements DataProvider {
  readonly capabilities = {
    transactions: true,
    relations: true,
    schemaEvolution: "additive" as const,
    sql: { dialect: "postgresql" as const, migrations: true },
  };
  constructor(private readonly database: DataSqlDatabase) {}
  private async transaction<T>(
    fn: (tx: DataSqlExecutor) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query("SET LOCAL search_path = pg_catalog");
        await tx.query("SET LOCAL statement_timeout = '10000ms'");
        await tx.query("SET LOCAL lock_timeout = '5000ms'");
        return fn(tx);
      });
    } catch (error) {
      return safeError(error);
    }
  }
  async initialize(): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(729433870001)");
      await tx.query('CREATE SCHEMA IF NOT EXISTS "_polpo_data"');
      await tx.query('REVOKE ALL ON SCHEMA "_polpo_data" FROM PUBLIC');
      await tx.query(`CREATE TABLE IF NOT EXISTS "_polpo_data"."resources" (
        id uuid PRIMARY KEY, scope text NOT NULL, name text NOT NULL,
        definition jsonb NOT NULL, version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(scope, name))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS "_polpo_data"."replays" (
        resource_id uuid NOT NULL REFERENCES "_polpo_data"."resources"(id) ON DELETE CASCADE,
        principal text NOT NULL, key text NOT NULL, request text NOT NULL, result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(resource_id, principal, key))`);
      await tx.query(`CREATE TABLE IF NOT EXISTS "_polpo_data"."migrations" (
        resource_id uuid NOT NULL REFERENCES "_polpo_data"."resources"(id) ON DELETE CASCADE,
        id text NOT NULL, checksum text NOT NULL, version integer NOT NULL, result jsonb NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(resource_id,id))`);
    });
  }
  async list(scope: string): Promise<DataResource[]> {
    try {
      return (
        await this.database.query(
          'SELECT * FROM "_polpo_data"."resources" WHERE scope = $1 ORDER BY name',
          [scope],
        )
      ).map(resource);
    } catch (error) {
      return safeError(error);
    }
  }
  async get(
    scope: string,
    reference: string,
  ): Promise<DataResource | undefined> {
    try {
      const [row] = await this.database.query(
        'SELECT * FROM "_polpo_data"."resources" WHERE scope = $1 AND (id::text = lower($2) OR name = $2) ORDER BY (id::text = lower($2)) DESC LIMIT 1',
        [scope, reference],
      );
      return row ? resource(row) : undefined;
    } catch (error) {
      return safeError(error);
    }
  }
  private async locked(
    tx: DataSqlExecutor,
    scope: string,
    id: string,
    mode: "SHARE" | "UPDATE",
    expected?: number,
  ): Promise<DataResource> {
    const [row] = await tx.query(
      `SELECT * FROM "_polpo_data"."resources" WHERE scope = $1 AND id = $2 FOR ${mode}`,
      [scope, id],
    );
    if (!row) throw new DataError("data_not_found", "Data resource not found");
    if (expected !== undefined && row.version !== expected)
      throw new DataError(
        "data_conflict",
        "Schema version changed; refresh before retrying",
      );
    return resource(row);
  }
  private async grantTables(tx: DataSqlExecutor, id: string): Promise<void> {
    const ns = namespace(id);
    await tx.query(
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${identifier(ns)} TO ${identifier(`${ns}_read`)}`,
    );
    await tx.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${identifier(ns)} TO ${identifier(`${ns}_write`)}`,
    );
  }
  private async evolve(
    tx: DataSqlExecutor,
    id: string,
    previous: DataSchemaDefinition,
    next: DataSchemaDefinition,
  ): Promise<void> {
    // Check the entire plan before DDL. Failed plans leave schema and catalog unchanged.
    for (const [tableName, table] of Object.entries(previous.tables)) {
      const target = next.tables[tableName];
      if (!target)
        throw new DataError(
          "data_invalid",
          "Removing tables requires a destructive migration workflow",
        );
      for (const [name, column] of Object.entries(table.columns)) {
        if (
          canonicalDataJson(column) !==
          canonicalDataJson(target.columns[name] ?? null)
        )
          throw new DataError(
            "data_invalid",
            "Changing or removing columns is not supported by additive migrations",
          );
      }
      if (
        (table.indexes ?? []).some(
          (index, i) =>
            canonicalDataJson(index) !==
            canonicalDataJson(target.indexes?.[i] ?? null),
        )
      )
        throw new DataError(
          "data_invalid",
          "Existing indexes must remain unchanged",
        );
      for (const [name, column] of Object.entries(target.columns))
        if (!Object.hasOwn(table.columns, name) && !column.nullable)
          throw new DataError(
            "data_invalid",
            "New columns on existing tables must be nullable",
          );
    }
    const columnDdl = (name: string, column: DataColumn) =>
      `${identifier(name)} ${sqlTypes[column.type]}${column.nullable ? "" : " NOT NULL"}${column.unique ? " UNIQUE" : ""}${dataValueConstraint(name, column)}`;
    for (const [tableName, table] of Object.entries(next.tables)) {
      const old = previous.tables[tableName];
      if (!old) {
        const columns = [
          '"_id" uuid PRIMARY KEY',
          '"_version" integer NOT NULL DEFAULT 1',
          '"_created_at" timestamptz NOT NULL DEFAULT now()',
          '"_updated_at" timestamptz NOT NULL DEFAULT now()',
          ...Object.entries(table.columns).map(([name, column]) =>
            columnDdl(name, column),
          ),
        ];
        await tx.query(
          `CREATE TABLE ${qualified(id, tableName)} (${columns.join(", ")})`,
        );
      } else {
        for (const [name, column] of Object.entries(table.columns))
          if (!Object.hasOwn(old.columns, name))
            await tx.query(
              `ALTER TABLE ${qualified(id, tableName)} ADD COLUMN ${columnDdl(name, column)}`,
            );
      }
      for (
        let i = old?.indexes?.length ?? 0;
        i < (table.indexes?.length ?? 0);
        i++
      ) {
        const index = table.indexes![i];
        await tx.query(
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${identifier(index.name ?? `idx_${tableName}_${i}`)} ON ${qualified(id, tableName)} (${index.columns.map(identifier).join(", ")})`,
        );
      }
    }
    // All tables and unique keys must exist before resolving foreign keys.
    for (const [tableName, table] of Object.entries(next.tables)) {
      let i = 0;
      for (const [name, column] of Object.entries(table.columns)) {
        if (column.references && !previous.tables[tableName]?.columns[name]) {
          await tx.query(
            `ALTER TABLE ${qualified(id, tableName)} ADD CONSTRAINT ${identifier(`fk_${name}`)} FOREIGN KEY (${identifier(name)}) REFERENCES ${qualified(id, column.references.table)} (${identifier(column.references.column)}) ON DELETE RESTRICT`,
          );
        }
        i++;
      }
    }
    await this.grantTables(tx, id);
  }
  async create(scope: string, input: CreateDataInput): Promise<DataResource> {
    parseData(DataSchema, input.schema);
    return this.transaction(async (tx) => {
      await tx.query(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [`data-create:${scope}`],
      );
      const [count] = await tx.query(
        'SELECT count(*)::integer AS count FROM "_polpo_data"."resources" WHERE scope=$1',
        [scope],
      );
      if (count.count >= 100)
        throw new DataError(
          "data_limit",
          "A scope may contain at most 100 Data resources",
        );
      const id = crypto.randomUUID();
      const ns = namespace(id);
      const [row] = await tx.query(
        'INSERT INTO "_polpo_data"."resources" (id, scope, name, definition) VALUES ($1,$2,$3,$4::text::jsonb) RETURNING *',
        [id, scope, input.name, JSON.stringify(input.schema)],
      );
      await tx.query(`CREATE SCHEMA ${identifier(ns)}`);
      await tx.query(`REVOKE ALL ON SCHEMA ${identifier(ns)} FROM PUBLIC`);
      for (const suffix of ["read", "write"]) {
        const role = identifier(`${ns}_${suffix}`);
        await tx.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
        await tx.query(`GRANT ${role} TO CURRENT_USER`);
        await tx.query(`GRANT USAGE ON SCHEMA ${identifier(ns)} TO ${role}`);
      }
      await this.evolve(tx, id, { tables: {} }, input.schema);
      return resource(row);
    });
  }
  async migrate(
    scope: string,
    id: string,
    input: DataMigration,
  ): Promise<DataResource> {
    parseData(DataSchema, input.schema);
    return this.transaction(async (tx) => {
      const current = await this.locked(
        tx,
        scope,
        id,
        "UPDATE",
        input.expectedVersion,
      );
      await this.evolve(tx, id, current.schema, input.schema);
      const [row] = await tx.query(
        'UPDATE "_polpo_data"."resources" SET definition=$1::text::jsonb, version=version+1 WHERE id=$2 RETURNING *',
        [JSON.stringify(input.schema), id],
      );
      return resource(row);
    });
  }
  private async sqlResult(
    tx: DataSqlExecutor,
    compiled: { sql: string; write: boolean },
    input: DataQuery,
  ): Promise<DataQueryResult> {
    const limit = input.maxRows ?? 200;
    // JSON and byte accounting happen inside PostgreSQL before any rows cross
    // the driver boundary. DML always completes atomically even if its result
    // page is truncated; rowCount reports every affected row.
    const source = compiled.write ? '"_polpo_mutation"' : `(${compiled.sql})`;
    const prefix = compiled.write
      ? `WITH "_polpo_mutation" AS (${compiled.sql}) `
      : "";
    const count = compiled.write
      ? '(SELECT count(*) FROM "_polpo_mutation")'
      : "count(*)";
    const [result] = await tx.query(
      `${prefix}SELECT ${count} AS affected,
      count(*) AS fetched,
      COALESCE(bool_and(${finiteDataJson("r")}), true) AS finite,
      CASE WHEN COALESCE(sum(octet_length(r::text)),0) <= 1048576
        THEN COALESCE(jsonb_agg(r), '[]'::jsonb) ELSE NULL END AS rows
      FROM (SELECT to_jsonb(q) AS r FROM ${source} AS q LIMIT ${limit + 1}) AS bounded`,
      input.params ?? [],
    );
    if (result.rows === null)
      throw new DataError(
        "data_limit",
        "SQL result exceeds 1 MiB; select fewer or smaller columns",
      );
    if (!result.finite)
      throw new DataError(
        "data_invalid",
        "SQL result contains a number outside the supported finite range",
      );
    const rows =
      typeof result.rows === "string" ? JSON.parse(result.rows) : result.rows;
    return {
      rows: rows.slice(0, limit),
      rowCount: compiled.write
        ? Number(result.affected)
        : Math.min(Number(result.fetched), limit),
      truncated: Number(result.fetched) > limit,
    };
  }
  async query(
    scope: string,
    id: string,
    principalId: string,
    input: DataQuery,
    access: DataQueryAccess,
  ): Promise<DataQueryResult> {
    input = parseData(DataQuerySchema, input);
    return this.transaction(async (tx) => {
      const current = await this.locked(tx, scope, id, "SHARE");
      const compiled = compileQuery(
        input.sql,
        namespace(id),
        current.schema,
        access,
        input.mode ?? "read",
        input.params?.length ?? 0,
      );
      const { idempotencyKey: _key, ...queryInput } = input;
      const request = canonicalDataJson({ kind: "sql", ...queryInput });
      if (input.idempotencyKey) {
        await tx.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [canonicalDataJson([id, principalId, input.idempotencyKey])],
        );
        const [replay] = await tx.query(
          'SELECT request,result FROM "_polpo_data"."replays" WHERE resource_id=$1 AND principal=$2 AND key=$3',
          [id, principalId, input.idempotencyKey],
        );
        if (replay) {
          if (replay.request !== request)
            throw new DataError(
              "data_conflict",
              "Idempotency key was already used for a different request",
            );
          return replay.result as DataQueryResult;
        }
      }
      await tx.query(
        `SET LOCAL ROLE ${identifier(`${namespace(id)}_${compiled.write ? "write" : "read"}`)}`,
      );
      const result = await this.sqlResult(tx, compiled, input);
      await tx.query("RESET ROLE");
      if (input.idempotencyKey)
        await tx.query(
          'INSERT INTO "_polpo_data"."replays" (resource_id,principal,key,request,result) VALUES ($1,$2,$3,$4,$5::text::jsonb)',
          [
            id,
            principalId,
            input.idempotencyKey,
            request,
            JSON.stringify(result),
          ],
        );
      return result;
    });
  }
  async migrateSql(
    scope: string,
    id: string,
    input: DataSqlMigration,
  ): Promise<DataResource> {
    input = parseData(DataSqlMigrationSchema, input);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalDataJson(input)),
    );
    const checksum = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    return this.transaction(async (tx) => {
      const current = await this.locked(tx, scope, id, "UPDATE");
      const [prior] = await tx.query(
        'SELECT checksum,result FROM "_polpo_data"."migrations" WHERE resource_id=$1 AND id=$2',
        [id, input.id],
      );
      if (prior) {
        if (prior.checksum !== checksum)
          throw new DataError(
            "data_conflict",
            "Migration ID was already used for different content",
          );
        return prior.result as DataResource;
      }
      if (current.schemaVersion !== input.expectedVersion)
        throw new DataError(
          "data_conflict",
          "Schema version changed; refresh before retrying",
        );
      const schema = structuredClone(current.schema);
      for (const [name, table] of Object.entries(schema.tables))
        table.indexes?.forEach((index, i) => {
          index.name ??= `idx_${name}_${i}`;
        });
      for (const statement of input.statements) {
        const ddl = migrationStatement(
          statement.sql,
          namespace(id),
          schema,
          input.allowDestructive ?? false,
        );
        if (ddl) {
          if (statement.params?.length)
            throw new DataError(
              "data_invalid",
              "DDL statements do not accept parameters",
            );
          for (const text of ddl) await tx.query(text);
          await this.grantTables(tx, id);
        } else {
          const tables = Object.keys(schema.tables);
          const compiled = compileQuery(
            statement.sql,
            namespace(id),
            schema,
            { readTables: tables, writeTables: tables },
            "write",
            statement.params?.length ?? 0,
          );
          await tx.query(
            `SET LOCAL ROLE ${identifier(`${namespace(id)}_write`)}`,
          );
          // Backfills do not transfer record values or arbitrary result sizes.
          await tx.query(
            `WITH "_polpo_backfill" AS (${compiled.sql}) SELECT count(*) FROM "_polpo_backfill"`,
            statement.params ?? [],
          );
          await tx.query("RESET ROLE");
        }
      }
      parseData(DataSchema, schema);
      const [row] = await tx.query(
        'UPDATE "_polpo_data"."resources" SET definition=$1::text::jsonb, version=version+1 WHERE id=$2 RETURNING *',
        [JSON.stringify(schema), id],
      );
      const result = resource(row);
      await tx.query(
        'INSERT INTO "_polpo_data"."migrations" (resource_id,id,checksum,version,result) VALUES ($1,$2,$3,$4,$5::text::jsonb)',
        [id, input.id, checksum, result.schemaVersion, JSON.stringify(result)],
      );
      return result;
    });
  }
  async migrations(scope: string, id: string): Promise<DataMigrationRecord[]> {
    return this.transaction(async (tx) => {
      await this.locked(tx, scope, id, "SHARE");
      const rows = await tx.query(
        'SELECT id,checksum,version,applied_at FROM "_polpo_data"."migrations" WHERE resource_id=$1 ORDER BY version',
        [id],
      );
      return rows.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        schemaVersion: row.version,
        appliedAt: new Date(row.applied_at).toISOString(),
      }));
    });
  }
  async rename(
    scope: string,
    id: string,
    input: DataRename,
  ): Promise<DataResource> {
    return this.transaction(async (tx) => {
      await this.locked(tx, scope, id, "UPDATE", input.expectedVersion);
      const [row] = await tx.query(
        'UPDATE "_polpo_data"."resources" SET name=$1, version=version+1 WHERE id=$2 RETURNING *',
        [input.name, id],
      );
      return resource(row);
    });
  }
  async remove(
    scope: string,
    id: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      await this.locked(tx, scope, id, "UPDATE", expectedVersion);
      await tx.query(`DROP SCHEMA ${identifier(namespace(id))} CASCADE`);
      await tx.query(
        `DROP ROLE ${identifier(`${namespace(id)}_read`)}, ${identifier(`${namespace(id)}_write`)}`,
      );
      await tx.query('DELETE FROM "_polpo_data"."resources" WHERE id=$1', [id]);
    });
  }
  async execute(
    scope: string,
    id: string,
    principalId: string,
    batch: DataBatch,
  ): Promise<DataResult[]> {
    return this.transaction(async (tx) => {
      const current = await this.locked(tx, scope, id, "SHARE");
      for (const operation of batch.operations)
        validateDataOperation(current.schema, operation);
      const request = canonicalDataJson(batch.operations);
      if (batch.idempotencyKey) {
        await tx.query(
          "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [canonicalDataJson([id, principalId, batch.idempotencyKey])],
        );
        const [replay] = await tx.query(
          'SELECT request,result FROM "_polpo_data"."replays" WHERE resource_id=$1 AND principal=$2 AND key=$3',
          [id, principalId, batch.idempotencyKey],
        );
        if (replay) {
          if (replay.request !== request)
            throw new DataError(
              "data_conflict",
              "Idempotency key was already used for a different request",
            );
          return replay.result as DataResult[];
        }
      }
      const write = batch.operations.some((op) => op.op !== "list");
      await tx.query(
        `SET LOCAL ROLE ${identifier(`${namespace(id)}_${write ? "write" : "read"}`)}`,
      );
      const results: DataResult[] = [];
      let resultBytes = 2;
      for (const operation of batch.operations) {
        const result = await this.operation(
          tx,
          id,
          current.schema.tables[operation.table],
          operation,
        );
        resultBytes +=
          new TextEncoder().encode(JSON.stringify(result)).length + 1;
        if (resultBytes > 1048576)
          throw new DataError(
            "data_limit",
            "Data response exceeds 1 MiB; reduce page or batch size",
          );
        results.push(result);
      }
      await tx.query("RESET ROLE");
      if (batch.idempotencyKey)
        await tx.query(
          'INSERT INTO "_polpo_data"."replays" (resource_id,principal,key,request,result) VALUES ($1,$2,$3,$4,$5::text::jsonb)',
          [
            id,
            principalId,
            batch.idempotencyKey,
            request,
            JSON.stringify(results),
          ],
        );
      return results;
    });
  }
  private async boundedRows(
    tx: DataSqlExecutor,
    sql: string,
    values: unknown[],
    table: DataTable,
    orderBy = "",
  ): Promise<DataRow[]> {
    const rows = await tx.query(
      `WITH result AS (${sql}) SELECT CASE
      WHEN sum(octet_length(row_to_json(result)::text)) OVER () <= 1048576
      THEN row_to_json(result)::text ELSE NULL END AS payload FROM result${orderBy}`,
      values,
    );
    if (rows.some((row) => row.payload === null))
      throw new DataError(
        "data_limit",
        "Data response exceeds 1 MiB; reduce page or batch size",
      );
    return rows.map((row) => rowResult(JSON.parse(row.payload), table));
  }
  private async operation(
    tx: DataSqlExecutor,
    id: string,
    table: DataTable,
    op: DataOperation,
  ): Promise<DataResult> {
    const target = qualified(id, op.table);
    const parameters: unknown[] = [];
    const bind = (value: unknown, column?: DataColumn) => {
      parameters.push(
        column?.type === "json" && value !== null
          ? JSON.stringify(value)
          : value,
      );
      return `$${parameters.length}${column ? `::${column.type === "json" ? "text::jsonb" : sqlTypes[column.type]}` : ""}`;
    };
    if (op.op === "list") {
      const filters: string[] = [];
      const operators: Record<string, string> = {
        eq: "=",
        ne: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      for (const [name, conditions] of Object.entries(op.filter ?? {})) {
        const col = identifier(name);
        const type = dataColumn(table, name);
        for (const [operator, value] of Object.entries(conditions)) {
          if (operator === "isNull")
            filters.push(`${col} IS ${value ? "" : "NOT "}NULL`);
          else if (operator === "in") {
            const items = value as unknown[];
            const nonNull = items.filter((v) => v !== null);
            const alternatives = nonNull.length
              ? [`${col} IN (${nonNull.map((v) => bind(v, type)).join(",")})`]
              : [];
            if (items.includes(null)) alternatives.push(`${col} IS NULL`);
            filters.push(`(${alternatives.join(" OR ")})`);
          } else if (value === null)
            filters.push(`${col} IS ${operator === "ne" ? "NOT " : ""}NULL`);
          else
            filters.push(`${col} ${operators[operator]} ${bind(value, type)}`);
        }
      }
      const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
      // Count + page share the transaction but READ COMMITTED permits concurrent
      // changes between statements; the API deliberately does not promise a snapshot.
      const [count] = await tx.query(
        `SELECT count(*)::integer AS total FROM ${target}${where}`,
        [...parameters],
      );
      const ordering = [...(op.orderBy ?? [])];
      if (!ordering.some((o) => o.column === "_id"))
        ordering.push({ column: "_id", direction: "asc" });
      const limit = op.limit ?? 50;
      const offset = op.offset ?? 0;
      const orderBy = ` ORDER BY ${ordering.map((o) => `${identifier(o.column)} ${o.direction.toUpperCase()} NULLS LAST`).join(",")}`;
      const rows = await this.boundedRows(
        tx,
        `SELECT * FROM ${target}${where}${orderBy} LIMIT ${bind(limit)} OFFSET ${bind(offset)}`,
        parameters,
        table,
        orderBy,
      );
      return {
        rows,
        total: count.total,
        nextOffset:
          offset + rows.length < count.total ? offset + rows.length : null,
      };
    }
    if (op.op === "insert" || op.op === "upsert") {
      const entries = Object.entries(op.values);
      const names = ["_id", ...entries.map(([name]) => name)];
      const placeholders = [
        bind(crypto.randomUUID()),
        ...entries.map(([name, value]) => bind(value, table.columns[name])),
      ];
      const conflict =
        op.op === "upsert"
          ? ` ON CONFLICT (${op.onConflict.map(identifier).join(",")}) DO UPDATE SET ${entries.map(([name]) => `${identifier(name)}=EXCLUDED.${identifier(name)}`).join(",")}, "_version"=${identifier(op.table)}."_version"+1, "_updated_at"=clock_timestamp()`
          : "";
      const rows = await this.boundedRows(
        tx,
        `INSERT INTO ${target} AS ${identifier(op.table)} (${names.map(identifier).join(",")}) VALUES (${placeholders.join(",")})${conflict} RETURNING *`,
        parameters,
        table,
      );
      return { rows };
    }
    const assignments =
      op.op === "update"
        ? Object.entries(op.values).map(
            ([name, value]) =>
              `${identifier(name)}=${bind(value, table.columns[name])}`,
          )
        : [];
    const where = ` WHERE "_id"=${bind(op.id)} AND "_version"=${bind(op.expectedVersion)}`;
    const sql =
      op.op === "delete"
        ? `DELETE FROM ${target}${where} RETURNING *`
        : `UPDATE ${target} SET ${assignments.join(",")}, "_version"="_version"+1, "_updated_at"=clock_timestamp()${where} RETURNING *`;
    const rows = await this.boundedRows(tx, sql, parameters, table);
    if (!rows.length)
      throw new DataError(
        "data_conflict",
        "Row missing or revision changed; refresh before retrying",
      );
    return { rows };
  }
}
