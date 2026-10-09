import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { DataService, type DataResource } from "@polpo-ai/core/data";
import {
  PostgresDataProvider,
  type DataSqlDatabase,
  type DataSqlExecutor,
} from "../data/index.js";

const databaseUrl = process.env.DATA_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("Data on real PostgreSQL", () => {
  const sql = postgres(databaseUrl!, { max: 10, onnotice: () => {} });
  const query = (client: any): DataSqlExecutor => ({
    query: async (text, values = []) => [
      ...(await client.unsafe(text, values)),
    ],
  });
  const database: DataSqlDatabase = {
    ...query(sql),
    transaction: (fn) => sql.begin(async (tx) => fn(query(tx))) as Promise<any>,
  };
  const provider = new PostgresDataProvider(database);
  const scope = `data-test-${crypto.randomUUID()}`;
  const service = new DataService(provider, {
    scope,
    principalId: "test-admin",
    grants: [{ resource: "*", actions: ["manage"] }],
  });
  const schema = {
    tables: {
      customers: {
        columns: {
          name: { type: "text" as const },
          email: { type: "text" as const, unique: true },
          age: { type: "integer" as const, nullable: true },
          profile: { type: "json" as const, nullable: true },
        },
      },
      orders: {
        columns: {
          customer: {
            type: "uuid" as const,
            references: { table: "customers", column: "_id" },
          },
          amount: { type: "number" as const },
        },
      },
    },
  };
  let crm: DataResource;
  beforeAll(async () => {
    await provider.initialize();
    await provider.initialize();
    crm = await service.create({ name: "crm", schema });
  });
  afterAll(async () => {
    for (const resource of await provider.list(scope))
      await provider.remove(scope, resource.id, resource.schemaVersion);
    await sql.end();
  });
  const insert = (
    email: string,
    options: { idempotencyKey?: string; name?: string } = {},
  ) =>
    service.execute(crm.id, {
      idempotencyKey: options.idempotencyKey,
      operations: [
        {
          op: "insert",
          table: "customers",
          values: { name: options.name ?? "Mario", email },
        },
      ],
    });
  it("creates actual isolated schemas and preserves resource identity", async () => {
    expect(crm.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await service.describe("crm")).id).toBe(crm.id);
    expect((await service.describe(crm.id.toUpperCase())).id).toBe(crm.id);
    expect(await provider.get("foreign-project", crm.id)).toBeUndefined();
    expect(await provider.list("foreign-project")).toEqual([]);
  });
  it("inserts typed rows and supports filtered deterministic pagination", async () => {
    const [result] = await insert("pagination@example.com");
    expect(result.rows[0]).toMatchObject({
      email: "pagination@example.com",
      _version: 1,
      age: null,
    });
    const [page] = await service.execute("crm", {
      operations: [
        {
          op: "list",
          table: "customers",
          filter: { email: { eq: "pagination@example.com" } },
          limit: 1,
        },
      ],
    });
    expect(page.total).toBe(1);
    expect(page.nextOffset).toBeNull();
    expect(page.rows[0]._id).toBe(result.rows[0]._id);
  });
  it("treats SQL-like row values as data", async () => {
    const name = "'; DROP SCHEMA public CASCADE; --";
    const [result] = await insert("sql@example.com", { name });
    expect(result.rows[0].name).toBe(name);
    expect(await service.describe(crm.id)).toBeDefined();
  });
  it("rolls back all operations when a later operation fails a constraint", async () => {
    await expect(
      service.execute(crm.id, {
        operations: [
          {
            op: "insert",
            table: "customers",
            values: { name: "First", email: "rollback@example.com" },
          },
          {
            op: "insert",
            table: "orders",
            values: { customer: crypto.randomUUID(), amount: 10 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "data_constraint" });
    const [page] = await service.execute(crm.id, {
      operations: [
        {
          op: "list",
          table: "customers",
          filter: { email: { eq: "rollback@example.com" } },
        },
      ],
    });
    expect(page.rows).toEqual([]);
  });
  it("replays concurrent writes once and rejects key reuse with different payload", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        insert("retry@example.com", { idempotencyKey: "retry-key" }),
      ),
    );
    expect(new Set(results.map((r) => r[0].rows[0]._id)).size).toBe(1);
    await expect(
      insert("different@example.com", { idempotencyKey: "retry-key" }),
    ).rejects.toMatchObject({ code: "data_conflict" });
  });
  it("detects concurrent stale updates and stale deletes", async () => {
    const [created] = await insert("concurrency@example.com");
    const id = created.rows[0]._id;
    const results = await Promise.allSettled(
      ["One", "Two"].map((name) =>
        service.execute(crm.id, {
          operations: [
            {
              op: "update",
              table: "customers",
              id,
              expectedVersion: 1,
              values: { name },
            },
          ],
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(
      service.execute(crm.id, {
        operations: [
          { op: "delete", table: "customers", id, expectedVersion: 1 },
        ],
      }),
    ).rejects.toMatchObject({ code: "data_conflict" });
    expect(
      (
        await service.execute(crm.id, {
          operations: [
            { op: "delete", table: "customers", id, expectedVersion: 2 },
          ],
        })
      )[0].rows[0]._id,
    ).toBe(id);
  });
  it("upserts against a declared unique key and increments row version", async () => {
    const run = (name: string) =>
      service.execute(crm.id, {
        operations: [
          {
            op: "upsert",
            table: "customers",
            onConflict: ["email"],
            values: { name, email: "upsert@example.com" },
          },
        ],
      });
    const first = await run("First");
    const second = await run("Second");
    expect(second[0].rows[0]).toMatchObject({
      _id: first[0].rows[0]._id,
      _version: 2,
      name: "Second",
    });
  });
  it("enforces database privileges independently from application checks", async () => {
    const other = await service.create({ name: "other", schema });
    const role = `data_${crm.id.replaceAll("-", "")}_read`;
    const namespace = `data_${other.id.replaceAll("-", "")}`;
    await expect(
      database.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE "${role}"`);
        await tx.query(`SELECT * FROM "${namespace}"."customers"`);
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE "${role}"`);
        await tx.query('SELECT * FROM "_polpo_data"."resources"');
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE "${role}"`);
        await tx.query(
          `DELETE FROM "data_${crm.id.replaceAll("-", "")}"."customers"`,
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("serializes schema changes and only permits additive evolution", async () => {
    const next = structuredClone(schema);
    Object.assign(next.tables.customers.columns, {
      notes: { type: "text", nullable: true },
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.migrate(crm.id, { expectedVersion: 1, schema: next }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await service.describe(crm.id)).schemaVersion).toBe(2);
    await expect(
      service.migrate(crm.id, { expectedVersion: 2, schema }),
    ).rejects.toMatchObject({ code: "data_invalid" });
    expect((await service.describe(crm.id)).schemaVersion).toBe(2);
  });
  it("bounds large result pages in SQL and rolls back writes in an oversized batch", async () => {
    const large = await service.create({
      name: "large",
      schema: {
        tables: {
          rows: {
            columns: {
              a: { type: "text" },
              b: { type: "text" },
              c: { type: "text" },
            },
          },
        },
      },
    });
    const values = {
      a: "x".repeat(60000),
      b: "y".repeat(60000),
      c: "z".repeat(60000),
    };
    for (let i = 0; i < 7; i++)
      await service.execute(large.id, {
        operations: [{ op: "insert", table: "rows", values }],
      });
    await expect(
      service.execute(large.id, {
        operations: [{ op: "list", table: "rows", limit: 7 }],
      }),
    ).rejects.toMatchObject({ code: "data_limit" });
    await expect(
      service.execute(large.id, {
        operations: [
          { op: "insert", table: "rows", values },
          ...Array.from({ length: 6 }, () => ({
            op: "list" as const,
            table: "rows",
            limit: 1,
          })),
        ],
      }),
    ).rejects.toMatchObject({ code: "data_limit" });
    const [page] = await service.execute(large.id, {
      operations: [{ op: "list", table: "rows", limit: 1 }],
    });
    expect(page.total).toBe(7);
    expect(page.rows).toHaveLength(1);
  });
  it("preserves identity and grants across rename and detects duplicate names", async () => {
    const renamed = await service.rename(crm.id, {
      name: "renamed",
      expectedVersion: 2,
    });
    expect(renamed.id).toBe(crm.id);
    expect((await service.describe("renamed")).schemaVersion).toBe(3);
    await expect(
      service.create({ name: "renamed", schema }),
    ).rejects.toMatchObject({ code: "data_conflict" });
  });
});
