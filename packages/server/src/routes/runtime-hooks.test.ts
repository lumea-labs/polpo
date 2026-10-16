import { describe, expect, it } from "vitest";
import type { RuntimeHookPack, RuntimeHookPackStore } from "@polpo-ai/core/runtime-hooks";
import { runtimeHookRoutes } from "./runtime-hooks.js";

class MemoryStore implements RuntimeHookPackStore {
  packs = new Map<string, RuntimeHookPack>();
  async list() { return [...this.packs.values()]; }
  async get(name: string) { return this.packs.get(name); }
  async put(pack: RuntimeHookPack) { this.packs.set(pack.name, pack); }
  async delete(name: string) { return this.packs.delete(name); }
}

describe("runtimeHookRoutes", () => {
  it("validates, stores, reads, lists, and deletes packs", async () => {
    const store = new MemoryStore();
    const app = runtimeHookRoutes(() => ({ store }));
    const pack = {
      version: 1,
      name: "quality",
      hooks: [{ id: "guard", event: "tool:before", handler: { type: "command", command: "check" } }],
    };
    const put = await app.request("/quality", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(pack) });
    expect(put.status).toBe(200);
    expect((await app.request("/quality")).status).toBe(200);
    expect(await (await app.request("/")).json()).toMatchObject({ data: [{ name: "quality" }] });
    expect((await app.request("/quality", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/quality")).status).toBe(404);
  });

  it("rejects mismatched names and invalid handler definitions", async () => {
    const store = new MemoryStore();
    const app = runtimeHookRoutes(() => ({ store }));
    const mismatch = await app.request("/expected", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, name: "other", hooks: [] }),
    });
    const invalid = await app.request("/bad", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, name: "bad", hooks: [{ id: "x", event: "unknown", handler: { type: "command", command: "true" } }] }),
    });
    expect(mismatch.status).toBe(400);
    expect(invalid.status).toBe(400);
  });
});
