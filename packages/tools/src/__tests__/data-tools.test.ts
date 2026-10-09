import { describe, expect, it, vi } from "vitest";
import { createDataTools } from "../data-tools.js";
import type { DataClient } from "@polpo-ai/core/data";

describe("Data agent capabilities", () => {
  it("exposes only explicitly requested tools without requiring a sandbox", () => {
    const client = {} as DataClient;
    expect(createDataTools(client, []).length).toBe(0);
    expect(
      createDataTools(client, ["data_read"]).map((t) => [
        t.name,
        t.requiresSandbox,
      ]),
    ).toEqual([["data_read", false]]);
  });
  it("passes bounded operations to the host-bound capability", async () => {
    const execute = vi.fn().mockResolvedValue([{ rows: [] }]);
    const client = { execute } as unknown as DataClient;
    const tool = createDataTools(client, ["data_read"])[0];
    await tool.execute("call", { resource: "crm", table: "customers" });
    expect(execute).toHaveBeenCalledWith("crm", {
      operations: [{ op: "list", table: "customers", limit: 20 }],
    });
  });
});
