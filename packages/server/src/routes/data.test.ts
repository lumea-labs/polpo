import { describe, expect, it, vi } from "vitest";
import { DataError, type DataService } from "@polpo-ai/core/data";
import { dataRoutes } from "./data.js";

describe("Data HTTP boundary", () => {
  it("requires an authenticated host resolver and sanitizes unexpected errors", async () => {
    const app = dataRoutes(async () => {
      throw new Error("postgres://secret@private");
    });
    const response = await app.request("/");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
  it("preserves scoped denial without invoking another service operation", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        new DataError("data_forbidden", "Data access is not granted"),
      );
    const app = dataRoutes(async () => ({ execute }) as unknown as DataService);
    const response = await app.request("/crm/transactions", {
      method: "POST",
      body: JSON.stringify({
        operations: [{ op: "list", table: "customers" }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "data_forbidden",
    });
  });
  it("rejects malformed and oversized JSON before service resolution", async () => {
    const resolve = vi.fn();
    const app = dataRoutes(resolve);
    const malformed = await app.request("/", { method: "POST", body: "{" });
    expect(malformed.status).toBe(400);
    const oversized = await app.request("/", {
      method: "POST",
      body: "x".repeat(262145),
    });
    expect(oversized.status).toBe(413);
    expect(resolve).not.toHaveBeenCalled();
  });
  it("uses the canonical success envelope", async () => {
    const app = dataRoutes(
      async () => ({ list: async () => [] }) as unknown as DataService,
    );
    expect(await (await app.request("/")).json()).toEqual({
      ok: true,
      data: [],
    });
  });
});
