import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { DataError, DataService, type DataResource } from "@polpo-ai/core/data";
import { PostgresDataProvider, type DataSqlExecutor } from "../data/index.js";
import { compileQuery } from "../data/sql.js";

describe("SQL compiler authorization before PostgreSQL", () => {
  const schema = {
    tables: {
      customers: {
        columns: {
          name: { type: "text" as const },
          email: { type: "text" as const, unique: true },
        },
      },
      secrets: { columns: { value: { type: "text" as const } } },
    },
  };
  const access = { readTables: ["customers"], writeTables: ["customers"] };
  const compile = (sql: string, params = 0) =>
    compileQuery(
      sql,
      "data_compiler_test",
      schema,
      access,
      sql.startsWith("INSERT") || sql.startsWith("UPDATE") ? "write" : "read",
      params,
    );
  it.each([
    "SELECT 'pg_catalog.pg_authid'::regclass",
    "SELECT 'pg_catalog.set_config'::regproc",
    "SELECT 'x'::public.secret_type",
    "SELECT DISTINCT ON (set_config('role','none',true)) name FROM customers",
    "SELECT DISTINCT ON (pg_sleep(1)) name FROM customers",
    "SELECT count(*) OVER (PARTITION BY set_config('role','none',true)) FROM customers",
    "SELECT count(*) OVER (ORDER BY pg_sleep(1)) FROM customers",
    "INSERT INTO customers(name,email) VALUES ('a','b') ON CONFLICT(email) DO UPDATE SET name='c' WHERE set_config('role','none',true)='none'",
    "INSERT INTO customers(name,email) VALUES ('a','b') ON CONFLICT(email) DO UPDATE SET _version=10",
    "SELECT DISTINCT ON ((SELECT count(*) FROM pg_catalog.pg_authid)) name FROM customers",
    "SELECT count(*) OVER (ORDER BY (SELECT count(*) FROM public.customers)) FROM customers",
    "SELECT count(*) OVER (PARTITION BY 'x'::regclass) FROM customers",
    "SELECT count(*) OVER (ORDER BY current_user) FROM customers",
    "SELECT name FROM customers FOR SHARE",
    "SELECT 1e999",
  ])("rejects unsafe syntax in every AST position: %s", (sql) => {
    expect(() => compile(sql)).toThrowError(DataError);
    expect(() => compile(sql)).toThrowError(
      expect.objectContaining({ code: "data_invalid" }),
    );
  });
  it.each([
    "SELECT DISTINCT ON ((SELECT value FROM secrets LIMIT 1)) name FROM customers",
    "SELECT count(*) OVER (PARTITION BY (SELECT value FROM secrets LIMIT 1)) FROM customers",
    "SELECT count(*) OVER (ORDER BY (SELECT value FROM secrets LIMIT 1)) FROM customers",
    "INSERT INTO customers(name,email) VALUES ('a','b') ON CONFLICT(email) DO UPDATE SET name='c' WHERE (SELECT count(*) FROM secrets)>0",
    "UPDATE customers SET name='c' FROM secrets WHERE true",
    "SELECT * FROM (SELECT * FROM secrets) nested",
    "SELECT name FROM customers UNION ALL SELECT value FROM secrets",
  ])("checks table grants even in formerly skipped fields: %s", (sql) => {
    expect(() => compile(sql)).toThrowError(
      expect.objectContaining({ code: "data_forbidden" }),
    );
  });
  it("rewrites authorized tables in DISTINCT, OVER and conflict predicates", () => {
    for (const sql of [
      "SELECT DISTINCT ON ((SELECT count(*) FROM customers)) name FROM customers",
      "SELECT count(*) OVER (PARTITION BY (SELECT count(*) FROM customers) ORDER BY $1) FROM customers",
      "INSERT INTO customers AS c(name,email) VALUES ('a','b') ON CONFLICT(email) DO UPDATE SET name=excluded.name WHERE (SELECT count(*) FROM customers)>0",
    ]) {
      const result = compile(sql, sql.includes("$1") ? 1 : 0).sql;
      expect(result.match(/data_compiler_test\.customers/g)).toHaveLength(2);
      expect(result).not.toMatch(/FROM customers/);
    }
    expect(() =>
      compile("SELECT DISTINCT ON ($1) name FROM customers"),
    ).toThrowError(expect.objectContaining({ code: "data_invalid" }));
  });
});

describe.skipIf(!process.env.DATA_TEST_DATABASE_URL)(
  "Scoped database SQL",
  () => {
    const sql = postgres(process.env.DATA_TEST_DATABASE_URL!, {
      max: 8,
      onnotice: () => {},
    });
    const executor = (c: any): DataSqlExecutor => ({
      query: async (text, params = []) => [...(await c.unsafe(text, params))],
    });
    const provider = new PostgresDataProvider({
      ...executor(sql),
      transaction: (fn) => sql.begin((tx) => fn(executor(tx))) as any,
    });
    const scope = `sql-${crypto.randomUUID()}`;
    const admin = new DataService(provider, {
      scope,
      principalId: "admin",
      grants: [{ resource: "*", actions: ["manage"] }],
    });
    let db: DataResource;
    beforeAll(async () => {
      await provider.initialize();
      db = await admin.create({
        name: "shop",
        schema: {
          tables: {
            customers: {
              columns: {
                name: { type: "text" },
                email: { type: "text", unique: true },
              },
            },
            orders: {
              columns: {
                customer: {
                  type: "uuid",
                  references: { table: "customers", column: "_id" },
                },
                amount: { type: "number" },
              },
            },
          },
        },
      });
    });
    afterAll(async () => {
      for (const r of await provider.list(scope))
        await provider.remove(scope, r.id, r.schemaVersion);
      await sql.end();
    });
    const q = (
      text: string,
      params: (string | number | boolean | null)[] = [],
      mode: "read" | "write" = "read",
    ) => admin.query(db.id, { sql: text, params, mode });

    it("executes parameterized mutations with IDs/revisions and retry protection", async () => {
      const input = {
        sql: "INSERT INTO customers(name,email) VALUES ($1,$2) RETURNING *",
        params: ["Mario'; DROP TABLE customers; --", "mario@example.test"],
        mode: "write" as const,
        idempotencyKey: "insert-mario",
      };
      const first = await admin.query(db.id, input);
      expect(first.rowCount).toBe(1);
      expect(first.rows[0]).toMatchObject({
        name: input.params[0],
        _version: 1,
      });
      expect(await admin.query(db.id, input)).toEqual(first);
      await expect(
        admin.query(db.id, {
          ...input,
          params: ["other", "other@example.test"],
        }),
      ).rejects.toMatchObject({ code: "data_conflict" });
      const id = first.rows[0]._id as string;
      await q(
        "INSERT INTO orders(customer,amount) VALUES ($1,10),($1,20)",
        [id],
        "write",
      );
      const changed = await q(
        "UPDATE customers SET name = upper($1) WHERE _id = $2 AND _version = 1 RETURNING *",
        ["Mario", id],
        "write",
      );
      expect(changed.rows[0]).toMatchObject({ name: "MARIO", _version: 2 });
      expect(
        (
          await q(
            "UPDATE customers SET name = $1 WHERE _id = $2 AND _version = 1",
            ["stale", id],
            "write",
          )
        ).rowCount,
      ).toBe(0);
    });
    it("supports joins, aggregates, subqueries and bounded result pages", async () => {
      const result = await q(
        "SELECT c.name, sum(o.amount) AS total FROM customers c JOIN orders o ON o.customer=c._id WHERE o.amount > $1 GROUP BY c.name HAVING count(*) > 1 ORDER BY total DESC",
        [5],
      );
      expect(result.rows).toEqual([{ name: "MARIO", total: 30 }]);
      expect(
        (
          await q(
            "SELECT name FROM customers WHERE _id IN (SELECT customer FROM orders)",
          )
        ).rowCount,
      ).toBe(1);
      const page = await admin.query(db.id, {
        sql: "SELECT amount FROM orders ORDER BY amount",
        maxRows: 1,
      });
      expect(page).toMatchObject({ rows: [{ amount: 10 }], truncated: true });
    });
    it("checks grants for every table, including joins and subqueries", async () => {
      const reader = new DataService(provider, {
        scope,
        principalId: "reader",
        grants: [{ resource: db.id, tables: ["customers"], actions: ["read"] }],
      });
      expect(
        (await reader.query(db.id, { sql: "SELECT name FROM customers" })).rows,
      ).toHaveLength(1);
      for (const text of [
        "SELECT * FROM orders",
        "SELECT * FROM customers JOIN orders ON true",
        "SELECT (SELECT count(*) FROM orders) FROM customers",
      ])
        await expect(reader.query(db.id, { sql: text })).rejects.toMatchObject({
          code: "data_forbidden",
        });
      await expect(
        reader.query(db.id, { sql: "DELETE FROM customers", mode: "write" }),
      ).rejects.toMatchObject({ code: "data_forbidden" });
      await expect(
        reader.migrateSql(db.id, {
          id: "forged",
          expectedVersion: 1,
          statements: [{ sql: "DROP TABLE customers" }],
          allowDestructive: true,
        }),
      ).rejects.toMatchObject({ code: "data_forbidden" });
    });
    it.each([
      "SELECT * FROM pg_catalog.pg_authid",
      "SELECT * FROM _polpo_data.resources",
      "SELECT * FROM public.customers",
      "SELECT set_config('role','none',true)",
      "SELECT pg_catalog.set_config('role','none',true)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_sleep(10)",
      "SELECT lo_export(1,'/tmp/escape')",
      "SELECT 'customers'::regclass",
      "SELECT current_user",
      "SELECT * FROM customers FOR UPDATE",
      "SELECT 1; DELETE FROM customers",
      "RESET ROLE",
      "SET search_path = public",
      "DO $$ BEGIN END $$",
      "WITH gone AS (DELETE FROM customers RETURNING *) SELECT * FROM gone",
      "COPY customers TO PROGRAM 'id'",
      "DELETE FROM customers",
      "UPDATE customers SET name='escape'",
      "CREATE TABLE escape(id integer)",
    ])("rejects unsupported or escaping SQL: %s", async (text) => {
      await expect(q(text)).rejects.toHaveProperty("code");
    });
    it("protects system revisions", async () => {
      await expect(
        q("UPDATE customers SET _version=100", [], "write"),
      ).rejects.toMatchObject({ code: "data_invalid" });
      await expect(
        q(
          "INSERT INTO customers(_id,name,email) VALUES ($1,'a','b')",
          [crypto.randomUUID()],
          "write",
        ),
      ).rejects.toMatchObject({ code: "data_invalid" });
      expect((await q("SELECT count(*) AS n FROM customers")).rows[0].n).toBe(
        1,
      );
    });
    it("migrates schema and backfills atomically, records history and safely replays", async () => {
      const migration = {
        id: "customer_labels",
        expectedVersion: 1,
        statements: [
          { sql: "ALTER TABLE customers ADD COLUMN label text" },
          { sql: "UPDATE customers SET label=lower(name)" },
          { sql: "ALTER TABLE customers ALTER COLUMN label SET NOT NULL" },
          { sql: "CREATE INDEX customer_labels ON customers(label)" },
          {
            sql: "CREATE TABLE notes (body text NOT NULL, customer uuid REFERENCES customers(_id))",
          },
        ],
      };
      db = await admin.migrateSql(db.id, migration);
      expect(db.schemaVersion).toBe(2);
      expect(db.schema.tables.customers.columns.label).toEqual({
        type: "text",
      });
      expect(db.schema.tables.notes.columns.customer.references).toEqual({
        table: "customers",
        column: "_id",
      });
      expect((await q("SELECT label FROM customers")).rows[0].label).toBe(
        "mario",
      );
      expect(await admin.migrateSql(db.id, migration)).toEqual(db);
      expect(await admin.migrations(db.id)).toEqual([
        expect.objectContaining({ id: "customer_labels", schemaVersion: 2 }),
      ]);
      await expect(
        admin.migrateSql(db.id, {
          ...migration,
          statements: [{ sql: "DROP TABLE orders" }],
        }),
      ).rejects.toMatchObject({ code: "data_conflict" });
    });
    it("rolls back DDL, backfills and catalog updates together", async () => {
      await expect(
        admin.migrateSql(db.id, {
          id: "failed",
          expectedVersion: 2,
          statements: [
            { sql: "ALTER TABLE customers ADD COLUMN temporary text" },
            { sql: "UPDATE customers SET label=NULL" },
          ],
        }),
      ).rejects.toHaveProperty("code");
      const current = await admin.describe(db.id);
      expect(current.schemaVersion).toBe(2);
      expect(current.schema.tables.customers.columns.temporary).toBeUndefined();
      expect(await admin.migrations(db.id)).toHaveLength(1);
    });
    it("requires explicit destructive intent and keeps renamed metadata in sync", async () => {
      const migration = {
        id: "rename_labels",
        expectedVersion: 2,
        statements: [
          { sql: "ALTER TABLE customers RENAME COLUMN label TO title" },
          { sql: "DROP INDEX customer_labels" },
          { sql: "DROP TABLE notes" },
        ],
      };
      await expect(admin.migrateSql(db.id, migration)).rejects.toMatchObject({
        code: "data_invalid",
      });
      db = await admin.migrateSql(db.id, {
        ...migration,
        allowDestructive: true,
      });
      expect(db.schema.tables.customers.columns.title).toEqual({
        type: "text",
      });
      expect(db.schema.tables.notes).toBeUndefined();
      expect(
        (
          await admin.execute(db.id, {
            operations: [{ op: "list", table: "customers" }],
          })
        )[0].rows[0].title,
      ).toBe("mario");
    });
    it("preserves aliased upsert predicates, increments revisions and rechecks nested grants", async () => {
      const local = await admin.create({
        name: "upsert_checks",
        schema: {
          tables: {
            entries: {
              columns: {
                name: { type: "text" },
                email: { type: "text", unique: true },
              },
            },
            private_values: { columns: { value: { type: "text" } } },
          },
        },
      });
      const input = {
        sql: "INSERT INTO entries AS e(name,email) VALUES ($1,$2) ON CONFLICT(email) DO UPDATE SET name=excluded.name WHERE e.name <> excluded.name RETURNING *",
        params: ["first", "alias@example.test"],
        mode: "write" as const,
      };
      const first = await admin.query(local.id, input);
      const changed = await admin.query(local.id, {
        ...input,
        params: ["second", input.params[1]],
      });
      expect(changed.rows[0]).toMatchObject({
        _id: first.rows[0]._id,
        _version: 2,
        name: "second",
      });
      expect(
        (
          await admin.query(local.id, {
            ...input,
            params: ["second", input.params[1]],
          })
        ).rowCount,
      ).toBe(0);
      const scoped = new DataService(provider, {
        scope,
        principalId: "upsert_writer",
        grants: [
          {
            resource: local.id,
            tables: ["entries"],
            actions: ["read", "write"],
          },
        ],
      });
      await expect(
        scoped.query(local.id, {
          ...input,
          sql: input.sql.replace(
            "e.name <> excluded.name",
            "(SELECT count(*) FROM private_values)>0",
          ),
        }),
      ).rejects.toMatchObject({ code: "data_forbidden" });
      expect(
        (
          await admin.execute(local.id, {
            operations: [{ op: "list", table: "entries" }],
          })
        )[0].rows[0]._version,
      ).toBe(2);
    });
    it("rolls back mutations whose result exceeds the byte limit", async () => {
      const local = await admin.create({
        name: "oversize_checks",
        schema: {
          tables: { entries: { columns: { name: { type: "text" } } } },
        },
      });
      const text = "x".repeat(65536);
      const values = Array.from({ length: 17 }, () => "($1)").join(",");
      await expect(
        admin.query(local.id, {
          sql: `INSERT INTO entries(name) VALUES ${values} RETURNING *`,
          params: [text],
          mode: "write",
          idempotencyKey: "too-large",
        }),
      ).rejects.toMatchObject({ code: "data_limit" });
      expect(
        (
          await admin.query(local.id, {
            sql: "SELECT count(*) AS n FROM entries",
          })
        ).rows,
      ).toEqual([{ n: 0 }]);
      const retry = await admin.query(local.id, {
        sql: "INSERT INTO entries(name) VALUES ($1) RETURNING name",
        params: ["small"],
        mode: "write",
        idempotencyKey: "too-large",
      });
      expect(retry.rowCount).toBe(1);
    });
    it("counts all mutations while truncating only returned rows and serializes retries", async () => {
      const local = await admin.create({
        name: "retry_checks",
        schema: {
          tables: { entries: { columns: { name: { type: "text" } } } },
        },
      });
      const input = {
        sql: "INSERT INTO entries(name) VALUES ('a'),('b'),('c') RETURNING *",
        mode: "write" as const,
        maxRows: 1,
        idempotencyKey: "concurrent-insert",
      };
      const [first, retry] = await Promise.all([
        admin.query(local.id, input),
        admin.query(local.id, input),
      ]);
      expect(first).toMatchObject({ rowCount: 3, truncated: true });
      expect(first.rows).toHaveLength(1);
      expect(retry).toEqual(first);
      expect(
        (
          await admin.query(local.id, {
            sql: "SELECT count(*) AS n FROM entries",
          })
        ).rows,
      ).toEqual([{ n: 3 }]);
    });
    it("supports DISTINCT ON, windows and safe nested expressions at runtime", async () => {
      const result = await q(
        "SELECT DISTINCT ON (amount) amount, sum(amount) OVER (ORDER BY amount) AS running FROM orders ORDER BY amount",
      );
      expect(result.rows).toEqual([
        { amount: 10, running: 10 },
        { amount: 20, running: 30 },
      ]);
      expect(
        (
          await q(
            "SELECT count(*) OVER (PARTITION BY (SELECT count(*) FROM customers)) AS n FROM orders",
          )
        ).rows,
      ).toEqual([{ n: 2 }, { n: 2 }]);
    });
    it("enforces portable value constraints for SQL, DDL changes and typed CRUD", async () => {
      const local = await admin.create({
        name: "value_checks",
        schema: {
          tables: {
            entries: {
              columns: {
                name: { type: "text" },
                amount: { type: "number", nullable: true },
                happened: { type: "timestamp", nullable: true },
                payload: { type: "json", nullable: true },
              },
            },
          },
        },
      });
      for (const sql of [
        "INSERT INTO entries(name,amount) VALUES ('bad','NaN'::float8)",
        "INSERT INTO entries(name,amount) VALUES ('bad','Infinity'::float8)",
        "INSERT INTO entries(name,happened) VALUES ('bad','infinity'::timestamptz)",
        "INSERT INTO entries(name,happened) VALUES ('bad','10000-01-01T00:00:00Z'::timestamptz)",
        "INSERT INTO entries(name,payload) VALUES ('bad','{\"big\": 1e309}'::jsonb)",
      ])
        await expect(
          admin.query(local.id, { sql, mode: "write" }),
        ).rejects.toMatchObject({ code: "data_constraint" });
      await expect(
        admin.query(local.id, {
          sql: "INSERT INTO entries(name) VALUES ($1 || $1)",
          params: ["x".repeat(40000)],
          mode: "write",
        }),
      ).rejects.toMatchObject({ code: "data_constraint" });
      const created = await admin.query(local.id, {
        sql: "INSERT INTO entries(name,amount,happened,payload) VALUES ('valid', 42, '2026-10-09T00:00:00Z'::timestamptz, '{\"nested\": [1, true]}'::jsonb)",
        mode: "write",
      });
      expect(
        (
          await admin.execute(local.id, {
            operations: [{ op: "list", table: "entries" }],
          })
        )[0].rows[0],
      ).toMatchObject({
        name: "valid",
        amount: 42,
        payload: { nested: [1, true] },
      });
      const changed = await admin.migrateSql(local.id, {
        id: "types",
        expectedVersion: 1,
        allowDestructive: true,
        statements: [
          { sql: "ALTER TABLE entries RENAME COLUMN amount TO total" },
          { sql: "ALTER TABLE entries ALTER COLUMN total TYPE integer" },
          {
            sql: "ALTER TABLE entries ALTER COLUMN total TYPE double precision",
          },
          { sql: "ALTER TABLE entries ADD COLUMN label text" },
          { sql: "CREATE TABLE added(body text, score double precision)" },
        ],
      });
      expect(changed.schema.tables.entries.columns.total.type).toBe("number");
      for (const sql of [
        "UPDATE entries SET total='Infinity'::float8",
        "INSERT INTO added(score) VALUES ('NaN'::float8)",
      ])
        await expect(
          admin.query(local.id, { sql, mode: "write" }),
        ).rejects.toMatchObject({ code: "data_constraint" });
      await expect(
        admin.query(local.id, {
          sql: "UPDATE entries SET label=$1 || $1",
          params: ["x".repeat(40000)],
          mode: "write",
        }),
      ).rejects.toMatchObject({ code: "data_constraint" });
      const final = await admin.execute(local.id, {
        operations: [
          {
            op: "update",
            table: "entries",
            id: created.rows[0]._id as string,
            expectedVersion: 1,
            values: { total: 50 },
          },
        ],
      });
      expect(final[0].rows[0]).toMatchObject({ total: 50, _version: 2 });
    });
    it("rejects computed numbers beyond JSON's finite range and rolls back RETURNING", async () => {
      const local = await admin.create({
        name: "numeric_result_checks",
        schema: {
          tables: { entries: { columns: { name: { type: "text" } } } },
        },
      });
      // Each ordinary decimal literal fits a finite JS number; PostgreSQL's
      // arbitrary-precision numeric multiplication produces 10^400.
      const literal = `1${"0".repeat(100)}`;
      const huge = Array.from({ length: 4 }, () => literal).join(" * ");
      await expect(
        admin.query(local.id, { sql: `SELECT (${huge}) AS huge` }),
      ).rejects.toMatchObject({ code: "data_invalid" });
      await expect(
        admin.query(local.id, {
          sql: `INSERT INTO entries(name) VALUES ('must_rollback') RETURNING (${huge}) AS huge`,
          mode: "write",
          idempotencyKey: "overflow",
        }),
      ).rejects.toMatchObject({ code: "data_invalid" });
      expect(
        (
          await admin.query(local.id, {
            sql: "SELECT count(*) AS n FROM entries",
          })
        ).rows,
      ).toEqual([{ n: 0 }]);
      expect(
        (
          await admin.query(local.id, {
            sql: "INSERT INTO entries(name) VALUES ('valid') RETURNING name",
            mode: "write",
            idempotencyKey: "overflow",
          })
        ).rows,
      ).toEqual([{ name: "valid" }]);
    });
    it("reports invalid query inputs without retryable backend errors", async () => {
      await expect(q("SELECT 1 / 0 AS result")).rejects.toMatchObject({
        code: "data_constraint",
      });
      await expect(
        q("SELECT _id FROM customers JOIN orders ON true"),
      ).rejects.toMatchObject({ code: "data_invalid" });
    });
    it("serializes concurrent schema migrations and records only the committed version", async () => {
      const local = await admin.create({
        name: "migration_race",
        schema: {
          tables: { entries: { columns: { name: { type: "text" } } } },
        },
      });
      const migrations = ["first", "second"].map((id) =>
        admin.migrateSql(local.id, {
          id,
          expectedVersion: 1,
          statements: [{ sql: `ALTER TABLE entries ADD COLUMN ${id} text` }],
        }),
      );
      const results = await Promise.allSettled(migrations);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "data_conflict" },
      });
      expect((await admin.describe(local.id)).schemaVersion).toBe(2);
      expect(await admin.migrations(local.id)).toHaveLength(1);
    });
  },
);
