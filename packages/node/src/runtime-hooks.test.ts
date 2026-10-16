import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeHookValidationError } from "@polpo-ai/core/runtime-hooks";
import {
  createNodeRuntimeHookHost,
  createProjectRuntimeHookEngine,
  loadRuntimeHookPacks,
} from "./runtime-hooks.js";

describe("Node runtime hooks", () => {
  it("loads named packs without allowing path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-hooks-"));
    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "safe.json"), JSON.stringify({
      version: 1,
      name: "safe",
      hooks: [{ id: "audit", event: "tool:after", mode: "observe", handler: { type: "command", command: "true" } }],
    }));
    await expect(loadRuntimeHookPacks(root, ["safe"])).resolves.toMatchObject([{ name: "safe" }]);
    await expect(loadRuntimeHookPacks(root, ["../secret"])).rejects.toBeInstanceOf(RuntimeHookValidationError);
  });

  it("executes command handlers with stable hook metadata", async () => {
    const execute = vi.fn(async () => ({
      stdout: JSON.stringify({ decision: { action: "deny", reason: "blocked" } }),
      stderr: "",
      exitCode: 0,
    }));
    const host = createNodeRuntimeHookHost({ shell: { execute }, cwd: "/work" });
    const result = await host.execute({
      hook: { id: "h", event: "tool:before", handler: { type: "command", command: "check", args: ["a b"] } },
      envelope: {
        version: 1,
        event: "tool:before",
        eventId: "event-1",
        occurredAt: new Date(0).toISOString(),
        surface: "chat",
        identity: {},
        data: {},
        origin: { kind: "runtime", depth: 0 },
      },
      idempotencyKey: "idem-1",
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ decision: { action: "deny" } });
    expect(execute).toHaveBeenCalledWith("check 'a b'", expect.objectContaining({
      cwd: "/work",
      env: expect.objectContaining({ POLPO_HOOK_IDEMPOTENCY_KEY: "idem-1" }),
    }));
  });

  it("rejects unsafe HTTP hook destinations before fetch", async () => {
    const fetch = vi.fn();
    const host = createNodeRuntimeHookHost({
      shell: { execute: vi.fn() },
      cwd: "/work",
      fetch: fetch as never,
    });
    await expect(host.execute({
      hook: { id: "h", event: "tool:before", handler: { type: "http", url: "https://127.0.0.1/hook" } },
      envelope: {
        version: 1,
        event: "tool:before",
        eventId: "event-1",
        occurredAt: new Date(0).toISOString(),
        surface: "chat",
        identity: {},
        data: {},
        origin: { kind: "runtime", depth: 0 },
      },
      idempotencyKey: "idem-1",
      signal: new AbortController().signal,
    })).rejects.toThrow("public hostname");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects HTTP hostnames that resolve to private addresses", async () => {
    const fetch = vi.fn();
    const host = createNodeRuntimeHookHost({
      shell: { execute: vi.fn() },
      cwd: "/work",
      fetch: fetch as never,
      lookup: vi.fn(async () => [{ address: "10.0.0.12", family: 4 }]) as never,
    });
    await expect(host.execute({
      hook: { id: "h", event: "tool:before", handler: { type: "http", url: "https://hooks.example.test/policy" } },
      envelope: {
        version: 1, event: "tool:before", eventId: "event-1", occurredAt: new Date(0).toISOString(),
        surface: "chat", identity: {}, data: {}, origin: { kind: "runtime", depth: 0 },
      },
      idempotencyKey: "idem-1",
      signal: new AbortController().signal,
    })).rejects.toThrow("public addresses");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves connection-backed HTTP headers without storing credentials in the pack", async () => {
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => new Response("{}", { status: 200 }));
    const resolveHttpHeaders = vi.fn(async () => ({ authorization: "Bearer secret" }));
    const host = createNodeRuntimeHookHost({
      shell: { execute: vi.fn() },
      cwd: "/work",
      fetch: fetch as never,
      lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) as never,
      resolveHttpHeaders,
    });
    await host.execute({
      hook: { id: "h", event: "tool:before", handler: { type: "http", url: "https://hooks.example.test/policy", connection: "policy-webhook" } },
      envelope: {
        version: 1, event: "tool:before", eventId: "event-1", occurredAt: new Date(0).toISOString(),
        surface: "chat", identity: {}, data: {}, origin: { kind: "runtime", depth: 0 },
      },
      idempotencyKey: "idem-1",
      signal: new AbortController().signal,
    });
    expect(resolveHttpHeaders).toHaveBeenCalledWith("policy-webhook", expect.any(AbortSignal));
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret" }),
      redirect: "error",
    }));
  });

  it("adapts tool, MCP, prompt, and bounded agent handlers", async () => {
    const invokeTool = vi.fn(async () => ({ decision: { action: "allow" as const } }));
    const invokeMcpTool = vi.fn(async () => ({ decision: { action: "allow" as const } }));
    const runPrompt = vi.fn(async () => ({ decision: { action: "allow" as const } }));
    const runAgent = vi.fn(async () => ({ decision: { action: "allow" as const } }));
    const host = createNodeRuntimeHookHost({
      shell: { execute: vi.fn() }, cwd: "/work", invokeTool, invokeMcpTool, runPrompt, runAgent,
    });
    const envelope = {
      version: 1 as const, event: "tool:before" as const, eventId: "event-1", occurredAt: new Date(0).toISOString(),
      surface: "chat" as const, identity: {}, data: {}, origin: { kind: "runtime" as const, depth: 0 },
    };
    const base = { envelope, idempotencyKey: "idem-1", signal: new AbortController().signal };
    await host.execute({ ...base, hook: { id: "tool", event: "tool:before", handler: { type: "tool", tool: "policy", input: { level: "strict" } } } });
    await host.execute({ ...base, hook: { id: "mcp", event: "tool:before", handler: { type: "mcp_tool", connection: "drive", tool: "inspect" } } });
    await host.execute({ ...base, hook: { id: "prompt", event: "tool:before", handler: { type: "prompt", prompt: "Review", maxOutputTokens: 128 } } });
    await host.execute({ ...base, hook: { id: "agent", event: "tool:before", handler: { type: "agent", agent: "reviewer", prompt: "Review", allowedTools: ["read"], maxTurns: 2 } } });
    expect(invokeTool).toHaveBeenCalledWith("policy", expect.objectContaining({ level: "strict", hook: envelope }), expect.any(AbortSignal));
    expect(invokeMcpTool).toHaveBeenCalledWith("drive", "inspect", expect.objectContaining({ hook: envelope }), expect.any(AbortSignal));
    expect(runPrompt).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Review", model: undefined, maxOutputTokens: 128,
      envelope: expect.objectContaining({ event: "tool:before" }),
    }), expect.any(AbortSignal));
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: "reviewer", prompt: "Review", allowedTools: ["read"], maxTurns: 2,
      envelope: expect.objectContaining({ event: "tool:before" }),
    }), expect.any(AbortSignal));
  });

  it("constructs one engine from multiple packs with namespaced hook ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-hooks-"));
    await mkdir(join(root, "hooks"));
    for (const name of ["one", "two"]) {
      await writeFile(join(root, "hooks", `${name}.json`), JSON.stringify({
        version: 1,
        name,
        hooks: [{ id: "same", event: "input:before", handler: { type: "command", command: "true" } }],
      }));
    }
    const calls: string[] = [];
    const engine = await createProjectRuntimeHookEngine({
      polpoDir: root,
      names: ["one", "two"],
      host: { execute: async ({ hook }) => { calls.push(hook.id); } },
    });
    await engine!.dispatch({ event: "input:before", surface: "chat" });
    expect(calls).toEqual(["one/same", "two/same"]);
  });
});
