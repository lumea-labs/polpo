import { describe, expect, it, vi } from "vitest";
import {
  DataService,
  DataSchema,
  DataName,
  validateDataOperation,
  type DataProvider,
  type DataResource,
} from "./index.js";

const schema = {
  tables: {
    customers: {
      columns: {
        name: { type: "text" as const },
        email: { type: "text" as const, unique: true },
        age: { type: "integer" as const, nullable: true },
      },
    },
  },
};
const resource: DataResource = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "crm",
  schema,
  schemaVersion: 1,
  createdAt: "2026-10-09T00:00:00.000Z",
};
function setup(
  grants: ConstructorParameters<typeof DataService>[1]["grants"] = [],
) {
  const provider: DataProvider = {
    capabilities: {
      transactions: true,
      relations: true,
      schemaEvolution: "additive",
    },
    list: vi.fn().mockResolvedValue([resource]),
    get: vi.fn().mockResolvedValue(resource),
    create: vi.fn().mockResolvedValue(resource),
    migrate: vi.fn().mockResolvedValue(resource),
    rename: vi.fn().mockResolvedValue(resource),
    remove: vi.fn().mockResolvedValue(undefined),
    execute: vi
      .fn()
      .mockResolvedValue([{ rows: [], total: 0, nextOffset: null }]),
  };
  return {
    provider,
    service: new DataService(provider, {
      scope: "project-a",
      principalId: "agent:leo",
      grants,
    }),
  };
}
describe("Data contracts and scoped service", () => {
  it("reserves UUID-shaped names so names cannot shadow immutable identities", () => {
    expect(
      DataName.safeParse("abcdefab-1111-4111-8111-111111111111").success,
    ).toBe(false);
    expect(DataName.safeParse("crm-live").success).toBe(true);
  });
  it("denies by default before resolving or mutating a resource", async () => {
    const { service, provider } = setup();
    await expect(
      service.execute("crm", {
        operations: [{ op: "list", table: "customers" }],
      }),
    ).rejects.toMatchObject({ code: "data_forbidden" });
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });
  it("binds host scope and identity and resolves immutable resource grants", async () => {
    const { service, provider } = setup([
      { resource: resource.id, actions: ["read"] },
    ]);
    await service.execute("crm", {
      operations: [{ op: "list", table: "customers" }],
    });
    expect(provider.execute).toHaveBeenCalledWith(
      "project-a",
      resource.id,
      "agent:leo",
      expect.objectContaining({
        operations: [expect.objectContaining({ op: "list" })],
      }),
    );
  });
  it("rejects write escalation, foreign resources and table escalation", async () => {
    const { service, provider } = setup([
      { resource: resource.id, tables: ["orders"], actions: ["read"] },
    ]);
    await expect(
      service.execute("crm", {
        operations: [{ op: "list", table: "customers" }],
      }),
    ).rejects.toMatchObject({ code: "data_forbidden" });
    await expect(
      service.execute("crm", {
        operations: [
          {
            op: "insert",
            table: "customers",
            values: { name: "A", email: "a" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "data_forbidden" });
    expect(provider.execute).not.toHaveBeenCalled();
    const other = setup([
      { resource: "22222222-2222-4222-8222-222222222222", actions: ["read"] },
    ]);
    await expect(other.service.describe("crm")).rejects.toMatchObject({
      code: "data_forbidden",
    });
  });
  it("filters both resource listing and table metadata to grants", async () => {
    const { service } = setup([
      { resource: resource.id, tables: ["orders"], actions: ["read"] },
    ]);
    expect((await service.describe("crm")).schema.tables).toEqual({});
    expect(await setup().service.list()).toEqual([]);
  });
  it("separates schema management from record writes", async () => {
    const { service } = setup([{ resource: resource.id, actions: ["write"] }]);
    await expect(
      service.migrate("crm", { expectedVersion: 1, schema }),
    ).rejects.toMatchObject({ code: "data_forbidden" });
    await expect(service.create({ name: "new", schema })).rejects.toMatchObject(
      { code: "data_forbidden" },
    );
  });
  it("snapshots grants so callers cannot mutate their authorization after binding", async () => {
    const grants = [{ resource: resource.id, actions: ["read" as const] }];
    const { service } = setup(grants);
    (grants[0].actions as string[]).push("manage");
    await expect(
      service.rename("crm", { name: "other", expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "data_forbidden" });
  });
  it("validates every batch item before making any provider write", async () => {
    const { service, provider } = setup([
      { resource: "*", actions: ["manage"] },
    ]);
    await expect(
      service.execute("crm", {
        operations: [
          {
            op: "insert",
            table: "customers",
            values: { name: "A", email: "a" },
          },
          {
            op: "insert",
            table: "customers",
            values: { name: "B", email: "b", age: "invalid" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "data_invalid" });
    expect(provider.execute).not.toHaveBeenCalled();
  });
  it.each([
    { op: "delete", table: "customers" },
    { op: "list", table: "customers; DROP SCHEMA public" },
    { op: "list", table: "customers", limit: 100000 },
    { op: "list", table: "customers", scope: "project-b" },
    { op: "list", table: "customers", filter: { age: { eq: "not-a-number" } } },
    {
      op: "insert",
      table: "customers",
      values: { name: "A", email: "a", _version: 99 },
    },
    {
      op: "upsert",
      table: "customers",
      values: { name: "A", email: "a" },
      onConflict: ["name"],
    },
  ])("rejects malformed or unsafe operation %j", (operation) => {
    expect(() => validateDataOperation(schema, operation)).toThrow();
  });
  it("validates types, references and identifiers in the canonical schema", () => {
    expect(
      DataSchema.safeParse({ tables: { "public.customers": { columns: {} } } })
        .success,
    ).toBe(false);
    expect(
      DataSchema.safeParse({
        tables: { users: { columns: { _id: { type: "uuid" } } } },
      }).success,
    ).toBe(false);
    expect(
      DataSchema.safeParse({
        tables: {
          users: {
            columns: {
              customer: {
                type: "uuid",
                references: { table: "missing", column: "_id" },
              },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(DataSchema.safeParse({ ...schema, secret: "no" }).success).toBe(
      false,
    );
  });
  it("requires bounded idempotency keys and batches", async () => {
    const { service } = setup([{ resource: "*", actions: ["manage"] }]);
    await expect(
      service.execute("crm", { operations: [] }),
    ).rejects.toMatchObject({ code: "data_invalid" });
    await expect(
      service.execute("crm", {
        idempotencyKey: "x".repeat(201),
        operations: [{ op: "list", table: "customers" }],
      }),
    ).rejects.toMatchObject({ code: "data_invalid" });
  });
});

describe("Remote Data capability", () => {
  it("keeps bearer credentials out of the tool capability and preserves denial", async () => {
    const { createRemoteDataClient } = await import("./index.js");
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { ok: false, code: "data_forbidden", error: "Access revoked" },
          { status: 403 },
        ),
      );
    const client = createRemoteDataClient({
      url: "https://example.test/data",
      token: "private",
      headers: { "x-sandbox": "one" },
      fetch: fetcher,
    });
    expect(Object.keys(client).sort()).toEqual([
      "describe",
      "execute",
      "list",
      "query",
    ]);
    expect(Object.isFrozen(client)).toBe(true);
    await expect(client.describe("crm")).rejects.toMatchObject({
      code: "data_forbidden",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.test/data",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer private",
          "x-sandbox": "one",
        }),
      }),
    );
  });
  it("validates batch input before sending and never automatically retries ambiguous writes", async () => {
    const { createRemoteDataClient } = await import("./index.js");
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error("private network detail"));
    const client = createRemoteDataClient({
      url: "https://example.test/data",
      token: "private",
      fetch: fetcher,
    });
    expect(() => client.execute("crm", { operations: [] })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      client.execute("crm", {
        operations: [
          { op: "insert", table: "contacts", values: { name: "Mario" } },
        ],
        idempotencyKey: "retry",
      }),
    ).rejects.toMatchObject({ code: "data_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
