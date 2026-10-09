import { describe, expect, it, vi } from "vitest";
import { createDataTools } from "../data-tools.js";
import { createAllTools } from "../system-tools.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import type { DataClient } from "@polpo-ai/core/data";

describe("Data agent capabilities", () => {
  it("bounds SQL results and acknowledges successful writes when rows are too large for the agent", async () => {
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [{ notes: "a".repeat(40000) }],
        rowCount: 1,
        truncated: false,
      });
    const tool = createDataTools({ query } as unknown as DataClient, [
      "database_query",
    ])[0];
    const result = await tool.execute("sql", {
      resource: "crm",
      sql: "UPDATE customers SET name=$1",
      params: ["Maria"],
      mode: "write",
      idempotencyKey: "update-1",
    });
    expect(query).toHaveBeenCalledWith("crm", {
      sql: "UPDATE customers SET name=$1",
      params: ["Maria"],
      mode: "write",
      maxRows: 20,
      idempotencyKey: "update-1",
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('"committed":true'),
    });
    await expect(
      tool.execute("read", { resource: "crm", sql: "SELECT * FROM customers" }),
    ).rejects.toMatchObject({ code: "data_limit" });
  });
  it("exposes only explicitly requested tools without requiring a sandbox", () => {
    const client = {} as DataClient;
    expect(createDataTools(client, []).length).toBe(0);
    expect(
      createDataTools(client, ["database_read"]).map((t) => [
        t.name,
        t.requiresSandbox,
      ]),
    ).toEqual([["database_read", false]]);
  });
  it("passes bounded operations to the host-bound capability", async () => {
    const execute = vi.fn().mockResolvedValue([{ rows: [] }]);
    const client = { execute } as unknown as DataClient;
    const tool = createDataTools(client, ["database_read"])[0];
    await tool.execute("call", { resource: "crm", table: "customers" });
    expect(execute).toHaveBeenCalledWith("crm", {
      operations: [{ op: "list", table: "customers", limit: 20 }],
    });
  });

  it("loads record capabilities through database_* without exposing administration", async () => {
    const options = {
      cwd: "/tmp",
      allowedTools: ["database_*"],
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
    };
    expect(await createAllTools(options)).toEqual([]);
    const tools = await createAllTools({ ...options, data: {} as DataClient });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "database_delete",
      "database_describe",
      "database_insert",
      "database_list",
      "database_query",
      "database_read",
      "database_transaction",
      "database_update",
      "database_upsert",
    ]);
  });

  it.each([
    [
      "database_insert",
      { table: "contacts", values: { name: "Mario" } },
      "insert",
    ],
    [
      "database_update",
      {
        table: "contacts",
        id: "row",
        expectedVersion: 1,
        values: { name: "Maria" },
      },
      "update",
    ],
    [
      "database_delete",
      { table: "contacts", id: "row", expectedVersion: 2 },
      "delete",
    ],
    [
      "database_upsert",
      {
        table: "contacts",
        values: { email: "mario@example.test" },
        onConflict: ["email"],
      },
      "upsert",
    ],
  ])(
    "%s forwards the canonical operation and retry key",
    async (name, input, op) => {
      const execute = vi.fn().mockResolvedValue([{ rows: [] }]);
      const tool = createDataTools({ execute } as unknown as DataClient, [
        name,
      ])[0];
      await tool.execute("call", {
        resource: "crm",
        idempotencyKey: "retry-1",
        ...input,
      });
      expect(execute).toHaveBeenCalledWith("crm", {
        operations: [{ ...input, op }],
        idempotencyKey: "retry-1",
      });
    },
  );

  it("submits a transaction as one batch rather than separate calls", async () => {
    const execute = vi.fn().mockResolvedValue([{ rows: [] }, { rows: [] }]);
    const tool = createDataTools({ execute } as unknown as DataClient, [
      "database_transaction",
    ])[0];
    const operations = [
      { op: "insert", table: "orders", values: { product: "book" } },
      {
        op: "update",
        table: "stock",
        id: "row",
        expectedVersion: 1,
        values: { quantity: 4 },
      },
    ];
    await tool.execute("call", {
      resource: "shop",
      operations,
      idempotencyKey: "checkout-1",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith("shop", {
      operations,
      idempotencyKey: "checkout-1",
    });
  });
});
