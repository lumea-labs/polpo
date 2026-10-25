import { describe, expect, it } from "vitest";
import type { HookPack, HookPackStore } from "@polpo-ai/core/runtime-hooks";
import { runtimeHookRoutes } from "./runtime-hooks.js";

class MemoryStore implements HookPackStore {
  packs = new Map<string, HookPack>();
  async list() { return [...this.packs.values()]; }
  async get(name: string) { return this.packs.get(name); }
  async put(pack: HookPack) { this.packs.set(pack.name, pack); }
  async delete(name: string) { return this.packs.delete(name); }
}

const put = (app: ReturnType<typeof runtimeHookRoutes>, name: string, body: unknown) =>
  app.request(`/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("runtimeHookRoutes", () => {
  it("reports the Claude Code reference baseline and the events this host emits", async () => {
    const response = await runtimeHookRoutes(() => ({})).request("/capabilities");
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.reference).toBe("claude-code-hooks@2026-10-24");
    expect(data.events).toHaveLength(33);
    expect(data.emittedEvents).toEqual(expect.arrayContaining(["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "SessionStart"]));
    expect(data.stopHookBlockCap).toBe(8);
  });

  it("stores a Claude Code hooks block unchanged and round-trips it exactly", async () => {
    const store = new MemoryStore();
    const app = runtimeHookRoutes(() => ({ store }));
    const pack = {
      name: "quality",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", if: "Bash(rm *)", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh", args: [] }] }],
        Stop: [{ hooks: [{ type: "command", command: "./scripts/validate.sh", timeout: 120 }] }],
      },
    };
    const response = await put(app, "quality", pack);
    expect(response.status).toBe(200);
    expect((await (await app.request("/quality")).json()).data).toEqual(pack);
    expect(await (await app.request("/")).json()).toMatchObject({ data: [{ name: "quality" }] });
    expect((await app.request("/quality", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/quality")).status).toBe(404);
  });

  it("rejects mismatched names, unknown events, ineligible handlers and the removed array dialect", async () => {
    const app = runtimeHookRoutes(() => ({ store: new MemoryStore() }));
    expect((await put(app, "expected", { name: "other", hooks: {} })).status).toBe(400);
    expect((await put(app, "bad", { name: "bad", hooks: { Bogus: [] } })).status).toBe(400);
    expect((await put(app, "bad", { name: "bad", hooks: { SessionStart: [{ hooks: [{ type: "prompt", prompt: "x" }] }] } })).status).toBe(400);
    const legacy = await put(app, "old", { version: 1, name: "old", hooks: [{ id: "guard", event: "tool:before", handler: { type: "command", command: "check" } }] });
    expect(legacy.status).toBe(400);
    expect((await legacy.json()).error).toMatch(/removed array format/);
  });
});
