import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import { PolpoClient } from "../../../client-sdk/src/client/polpo-client.js";
import { dataRoutes } from "@polpo-ai/server";
import {
  createDataTools,
  bindCustomTool,
  defineTool,
  emptyCustomToolConnections,
  createToolInvocationContext,
} from "@polpo-ai/tools";
import { createNodeDataRuntime } from "../data/index.js";
import type { DataGrant, DataResource, DataService } from "@polpo-ai/core/data";

describe.skipIf(!process.env.DATA_TEST_DATABASE_URL)(
  "Data SDK, HTTP and tools integration",
  () => {
    let grants: DataGrant[] = [];
    const runtime = createNodeDataRuntime({
      databaseUrl: process.env.DATA_TEST_DATABASE_URL!,
      scope: `sdk-test-${crypto.randomUUID()}`,
      resolveAgentGrants: () => grants,
    });
    const app = new Hono();
    app.use("*", async (c, next) =>
      c.req.header("Authorization") === "Bearer local-test"
        ? next()
        : c.json(
            { ok: false, error: "Unauthorized", code: "unauthorized" },
            401,
          ),
    );
    app.route(
      "/api/v1/data",
      dataRoutes((request) => runtime.resolveService(request)),
    );
    const client = new PolpoClient({
      baseUrl: "http://localhost",
      apiKey: "local-test",
      fetch: (input, init) =>
        app.request(new Request(input, init)) as Promise<Response>,
    });
    let resource: DataResource;
    let admin: DataService;
    beforeAll(async () => {
      admin = await runtime.resolveService(new Request("http://localhost"));
    });
    afterAll(async () => {
      if (admin)
        for (const r of await admin.list())
          await admin.remove(r.id, r.schemaVersion);
      await runtime.close();
    });
    it("creates a schema and performs a complete SDK lifecycle through HTTP", async () => {
      resource = await client.createData({
        name: "crm",
        schema: {
          tables: {
            customers: {
              columns: {
                name: { type: "text" },
                email: { type: "text", unique: true },
              },
            },
          },
        },
      });
      expect((await client.listData()).map((r) => r.id)).toContain(resource.id);
      const customers = client.data("crm").table("customers");
      const row = await customers.insert(
        { name: "Mario", email: "mario@example.com" },
        { idempotencyKey: "first" },
      );
      const replay = await customers.insert(
        { name: "Mario", email: "mario@example.com" },
        { idempotencyKey: "first" },
      );
      expect(replay._id).toBe(row._id);
      const updated = await customers.update(
        row._id,
        { name: "Maria" },
        row._version,
      );
      expect(updated._version).toBe(2);
      expect(
        (
          await customers.list({
            filter: { email: { eq: "mario@example.com" } },
          })
        ).rows[0].name,
      ).toBe("Maria");
      await expect(
        customers.update(row._id, { name: "Stale" }, 1),
      ).rejects.toMatchObject({ code: "data_conflict", status: 409 });
    });
    it("queries and migrates through SDK and HTTP with real PostgreSQL", async () => {
      const database = client.data(resource.id);
      expect(
        (
          await database.query({
            sql: "SELECT count(*) AS total FROM customers",
          })
        ).rows,
      ).toEqual([{ total: 1 }]);
      const updated = await database.query({
        sql: "UPDATE customers SET name = $1 WHERE email = $2 RETURNING *",
        params: ["Maria", "mario@example.com"],
        mode: "write",
        idempotencyKey: "sql-update",
      });
      expect(updated.rows[0]).toMatchObject({ name: "Maria", _version: 3 });
      const migration = {
        id: "add_nickname",
        expectedVersion: resource.schemaVersion,
        statements: [
          { sql: "ALTER TABLE customers ADD COLUMN nickname text" },
          { sql: "UPDATE customers SET nickname=$1", params: ["customer"] },
          { sql: "ALTER TABLE customers ALTER COLUMN nickname SET NOT NULL" },
        ],
      };
      const migrated = await database.migrateSql(migration);
      expect(migrated.schema.tables.customers.columns.nickname).toEqual({
        type: "text",
      });
      expect(await database.migrateSql(migration)).toEqual(migrated);
      expect(await database.migrations()).toEqual([
        expect.objectContaining({ id: "add_nickname", schemaVersion: 2 }),
      ]);
      expect((await database.table("customers").list()).rows[0].nickname).toBe(
        "customer",
      );
      await expect(
        database.query({ sql: "DROP TABLE customers", mode: "write" }),
      ).rejects.toMatchObject({ code: "data_invalid", status: 400 });
      await expect(
        database.query({ sql: "SELECT $1", params: [] }),
      ).rejects.toMatchObject({ code: "data_invalid", status: 400 });
    });
    it("publishes canonical SQL and migration contracts in OpenAPI", () => {
      const spec = dataRoutes(() => admin).getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "Data", version: "1" },
      });
      expect(
        spec.paths?.["/{resource}/query"]?.post?.requestBody,
      ).toBeDefined();
      expect(
        spec.paths?.["/{resource}/migrations"]?.post?.requestBody,
      ).toBeDefined();
      expect(spec.paths?.["/{resource}/migrations"]?.get).toBeDefined();
      expect(spec.paths?.["/{resource}/transactions"]?.post).toBeDefined();
    });
    it("agent and custom tool share scoped Data and immediate grant revocation", async () => {
      grants = [{ resource: resource.id, actions: ["read", "write"] }];
      const capability = runtime.forAgent("leo");
      expect(Object.isFrozen(capability)).toBe(true);
      expect(Object.keys(capability).sort()).toEqual([
        "describe",
        "execute",
        "list",
        "query",
      ]);
      const read = createDataTools(capability, ["database_read"])[0];
      expect(
        (await read.execute("call", { resource: "crm", table: "customers" }))
          .content[0],
      ).toMatchObject({ type: "text", text: expect.stringContaining("Maria") });
      const custom = defineTool({
        name: "customer_count",
        description: "Count customers",
        parameters: Type.Object({}),
        execute: async (ctx) => {
          const page = await ctx.data!.query!("crm", {
            sql: "SELECT count(*) AS total FROM customers",
          });
          return `Customers: ${page.rows[0].total}`;
        },
      });
      const bound = bindCustomTool(custom, {
        data: capability,
        fs: {} as any,
        shell: {} as any,
        connections: emptyCustomToolConnections(),
        env: {},
        workDir: "/tmp",
        invocation: createToolInvocationContext({
          requestId: "test",
          runId: "test",
          surface: "chat",
          metadata: {},
        }),
      });
      expect((await bound.execute("custom", {})).content[0]).toMatchObject({
        text: "Customers: 1",
      });
      const queryTool = createDataTools(capability, ["database_query"])[0];
      expect(
        (
          await queryTool.execute("query", {
            resource: "crm",
            sql: "SELECT nickname FROM customers",
          })
        ).content[0],
      ).toMatchObject({ text: expect.stringContaining("customer") });
      grants = [];
      await expect(
        queryTool.execute("revoked-query", {
          resource: "crm",
          sql: "SELECT 1",
        }),
      ).rejects.toMatchObject({ code: "data_forbidden" });
      await expect(
        read.execute("denied", { resource: "crm", table: "customers" }),
      ).rejects.toMatchObject({ code: "data_forbidden" });
      await expect(bound.execute("denied-custom", {})).rejects.toMatchObject({
        code: "data_forbidden",
      });
    });
    it("rejects unauthenticated requests and ignores SDK end-user labels for authorization", async () => {
      expect((await app.request("/api/v1/data")).status).toBe(401);
      client.setUser("another-app-user");
      expect((await client.data(resource.id).describe()).id).toBe(resource.id);
      grants = [];
      await expect(
        runtime.forAgent("another-app-user").describe(resource.id),
      ).rejects.toMatchObject({ code: "data_forbidden" });
    });
  },
);
