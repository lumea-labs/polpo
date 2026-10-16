import { describe, expect, it, vi } from "vitest";
import {
  RuntimeHookEngine,
  RuntimeHookValidationError,
  createRuntimeHookEnvelope,
  runtimeHookFileChangeForTool,
  validateRuntimeHookPack,
  type RuntimeHookDefinition,
  type RuntimeHookHandlerResult,
} from "./runtime-hooks.js";

function hook(overrides: Partial<RuntimeHookDefinition> = {}): RuntimeHookDefinition {
  return {
    id: "hook-1",
    event: "tool:before",
    handler: { type: "tool", tool: "policy_check" },
    ...overrides,
  };
}

describe("RuntimeHookEngine", () => {
  it("orders controlling hooks by scope, priority, and declaration order", async () => {
    const calls: string[] = [];
    const engine = new RuntimeHookEngine({
      definitions: [
        hook({ id: "agent", scope: "agent", priority: -10 }),
        hook({ id: "project-late", scope: "project", priority: 5 }),
        hook({ id: "project-first", scope: "project", priority: 0 }),
      ],
      host: {
        execute: async ({ hook: definition }) => {
          calls.push(definition.id);
          return { decision: { action: "allow" } };
        },
      },
    });

    await engine.dispatch({ event: "tool:before", surface: "chat", data: { tool: "bash" } });
    expect(calls).toEqual(["project-first", "project-late", "agent"]);
  });

  it("stops controlling handlers after a deny and runs observers without changing the decision", async () => {
    const calls: string[] = [];
    const engine = new RuntimeHookEngine({
      definitions: [
        hook({ id: "deny" }),
        hook({ id: "never" }),
        hook({ id: "observer", mode: "observe" }),
      ],
      host: {
        execute: async ({ hook: definition }): Promise<RuntimeHookHandlerResult> => {
          calls.push(definition.id);
          if (definition.id === "deny") return { decision: { action: "deny", reason: "blocked" } };
          if (definition.id === "observer") return { decision: { action: "allow" } };
          return {};
        },
      },
    });

    const result = await engine.dispatch({ event: "tool:before", surface: "loop", data: { tool: "write" } });
    expect(result.decision).toEqual({ action: "deny", reason: "blocked" });
    expect(calls).toEqual(["deny", "observer"]);
  });

  it("merges ordered modifications and never lets allow erase a restriction", async () => {
    const engine = new RuntimeHookEngine({
      definitions: [hook({ id: "a" }), hook({ id: "b" }), hook({ id: "c" })],
      host: {
        execute: async ({ hook: definition }): Promise<RuntimeHookHandlerResult> => {
          if (definition.id === "a") return { decision: { action: "modify", data: { input: { safe: true } } } };
          if (definition.id === "b") return { decision: { action: "modify", data: { context: "checked" } } };
          return { decision: { action: "allow" as const } };
        },
      },
    });
    const result = await engine.dispatch({ event: "tool:before", surface: "chat" });
    expect(result.decision).toMatchObject({ action: "modify", data: { input: { safe: true }, context: "checked" } });
  });

  it("honors glob matchers and recursion fences", async () => {
    const execute = vi.fn(async () => ({}));
    const engine = new RuntimeHookEngine({
      definitions: [hook({ matcher: { surfaces: ["chat"], tools: ["file_*"] } })],
      host: { execute },
    });
    await engine.dispatch({ event: "tool:before", surface: "chat", data: { tool: "file_write" } });
    await engine.dispatch({ event: "tool:before", surface: "chat", data: { tool: "bash" } });
    await engine.dispatch({
      event: "tool:before",
      surface: "chat",
      data: { tool: "file_write" },
      origin: { kind: "hook", depth: 1, hookId: "parent" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("blocks on timeout only when onFailure is block", async () => {
    const never = () => new Promise<void>(() => undefined);
    const blocked = new RuntimeHookEngine({
      definitions: [hook({ onFailure: "block", handler: { type: "tool", tool: "slow", timeoutMs: 2 } })],
      host: { execute: never },
    });
    const allowed = new RuntimeHookEngine({
      definitions: [hook({ onFailure: "continue", handler: { type: "tool", tool: "slow", timeoutMs: 2 } })],
      host: { execute: never },
    });
    await expect(blocked.dispatch({ event: "tool:before", surface: "chat" }))
      .resolves.toMatchObject({ decision: { action: "deny", code: "runtime_hook_timeout" } });
    await expect(allowed.dispatch({ event: "tool:before", surface: "chat" }))
      .resolves.toMatchObject({ decision: { action: "allow" } });
  });

  it("redacts sensitive keys and rejects oversized or circular payloads", () => {
    const envelope = createRuntimeHookEnvelope({
      event: "tool:before",
      surface: "chat",
      data: { apiKey: "secret", nested: { Authorization: "bearer" }, safe: "ok" },
    });
    expect(envelope.data).toEqual({ apiKey: "[REDACTED]", nested: { Authorization: "[REDACTED]" }, safe: "ok" });
    expect(() => createRuntimeHookEnvelope({
      event: "input:before",
      surface: "chat",
      data: { large: "x".repeat(100) },
    }, undefined, 10)).toThrow(RuntimeHookValidationError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createRuntimeHookEnvelope({ event: "input:before", surface: "chat", data: cyclic }))
      .toThrow(RuntimeHookValidationError);
  });

  it("derives replay-stable event and idempotency identities independently of wall-clock time", () => {
    const first = createRuntimeHookEnvelope({
      event: "tool:before", surface: "chat", occurredAt: "2026-01-01T00:00:00.000Z",
      identity: { runId: "run-1", toolCallId: "call-1" }, data: { tool: "write", input: { path: "a" } },
    });
    const replay = createRuntimeHookEnvelope({
      event: "tool:before", surface: "chat", occurredAt: "2026-01-01T00:05:00.000Z",
      identity: { runId: "run-1", toolCallId: "call-1" }, data: { tool: "write", input: { path: "a" } },
    });
    expect(replay.eventId).toBe(first.eventId);
  });

  it("reuses a durably completed execution without repeating its handler side effect", async () => {
    const execute = vi.fn(async () => ({ decision: { action: "deny" as const, reason: "new" } }));
    const trace = vi.fn();
    const engine = new RuntimeHookEngine({
      definitions: [hook({ id: "durable" })],
      host: {
        execute,
        trace,
        findCompleted: async ({ idempotencyKey, hook: definition, envelope }) => ({
          execution: {
            idempotencyKey,
            eventId: envelope.eventId,
            hookId: definition.id,
            handlerType: definition.handler.type,
            event: envelope.event,
            scope: "project",
            mode: "control",
            priority: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:00.010Z",
            durationMs: 10,
            outcome: "denied",
            decision: "deny",
          },
          decision: { action: "deny", reason: "persisted" },
        }),
      },
    });

    const result = await engine.dispatch({
      event: "tool:before",
      surface: "chat",
      identity: { runId: "run-1", toolCallId: "call-1" },
      data: { tool: "write" },
    });

    expect(result.decision).toEqual({ action: "deny", reason: "persisted" });
    expect(result.executions[0]).toMatchObject({ hookId: "durable", replayed: true });
    expect(execute).not.toHaveBeenCalled();
    expect(trace).not.toHaveBeenCalled();
  });

  it("passes the complete controlling decision to durable trace persistence", async () => {
    const trace = vi.fn(async () => undefined);
    const engine = new RuntimeHookEngine({
      definitions: [hook({ id: "rewrite" })],
      host: {
        execute: async () => ({
          decision: { action: "modify", data: { input: { approved: true } } },
        }),
        trace,
      },
    });

    await engine.dispatch({ event: "tool:before", surface: "chat" });

    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "modify", outcome: "modified" }),
      { action: "modify", data: { input: { approved: true } } },
    );
  });

  it("validates the versioned JSON pack and every handler family", () => {
    const handlers = [
      { type: "command", command: "true" },
      { type: "http", url: "https://example.com/hook" },
      { type: "tool", tool: "read" },
      { type: "mcp_tool", connection: "drive", tool: "search" },
      { type: "prompt", prompt: "Review" },
      { type: "agent", agent: "reviewer", prompt: "Review" },
    ];
    const pack = validateRuntimeHookPack({
      version: 1,
      name: "quality",
      hooks: handlers.map((handler, index) => ({ id: `h-${index}`, event: "tool:before", handler })),
    });
    expect(pack.hooks).toHaveLength(6);
  });

  it("rejects inline command and HTTP credentials", () => {
    expect(() => validateRuntimeHookPack({
      version: 1,
      name: "invalid-command-secret",
      hooks: [{
        id: "command-secret", event: "run:start",
        handler: { type: "command", command: "check", env: { API_KEY: "secret" } },
      }],
    })).toThrow("must not contain inline credentials");
    expect(() => validateRuntimeHookPack({
      version: 1,
      name: "invalid-http-secret",
      hooks: [{
        id: "http-secret", event: "run:start",
        handler: { type: "http", url: "https://example.com/hook", headers: { Authorization: "Bearer secret" } },
      }],
    })).toThrow("use handler.connection");
  });

  it.each([
    [{ type: "command" }, "handler.command"],
    [{ type: "http", url: "http://example.com" }, "must use HTTPS"],
    [{ type: "tool", tool: "" }, "handler.tool"],
    [{ type: "mcp_tool", connection: "drive" }, "handler.tool"],
    [{ type: "prompt", prompt: "Review", maxOutputTokens: 0 }, "maxOutputTokens"],
    [{ type: "agent", agent: "reviewer", prompt: "Review", maxTurns: 21 }, "maxTurns"],
  ])("rejects malformed handler contracts: %o", (handler, message) => {
    expect(() => validateRuntimeHookPack({
      version: 1,
      name: "invalid",
      hooks: [{ id: "invalid", event: "tool:before", handler }],
    })).toThrow(message);
  });

  it("rejects malformed matchers and metadata", () => {
    expect(() => validateRuntimeHookPack({
      version: 1,
      name: "invalid",
      hooks: [{
        id: "invalid", event: "tool:before", priority: 1.5,
        matcher: { surfaces: ["unknown"] },
        handler: { type: "tool", tool: "read" },
      }],
    })).toThrow("priority");
    expect(() => validateRuntimeHookPack({
      version: 1,
      name: "invalid",
      hooks: [{
        id: "invalid", event: "tool:before",
        matcher: { surfaces: ["unknown"] },
        handler: { type: "tool", tool: "read" },
      }],
    })).toThrow("matcher.surfaces");
  });
});

describe("runtimeHookFileChangeForTool", () => {
  it("normalizes successful portable workspace writes and ignores failures", () => {
    expect(runtimeHookFileChangeForTool("write_file", { path: "src/index.ts" }, "ok"))
      .toEqual({
        action: "created",
        path: "src/index.ts",
        directory: "src",
        sourceTool: "write_file",
      });
    expect(runtimeHookFileChangeForTool("edit_file", { path: "README.md" }, "Error: denied"))
      .toBeUndefined();
    expect(runtimeHookFileChangeForTool("bash", { path: "src/index.ts" }, "ok"))
      .toBeUndefined();
  });
});
