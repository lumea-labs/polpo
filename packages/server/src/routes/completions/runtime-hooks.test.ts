import { describe, expect, it, vi } from "vitest";
import {
  RuntimeHookEngine,
  type RuntimeHookDefinition,
  type RuntimeHookHandlerResult,
} from "@polpo-ai/core/runtime-hooks";
import {
  createRuntimeHookedToolExecutor,
  dispatchCompletionModelPolicyHook,
  type CompletionRuntimeHookContext,
} from "./runtime-hooks.js";

function context(definitions: RuntimeHookDefinition[]): CompletionRuntimeHookContext {
  return {
    surface: "chat",
    identity: { runId: "run-1", agent: "support" },
    dispatcher: new RuntimeHookEngine({
      definitions,
      host: {
        execute: async ({ hook }): Promise<RuntimeHookHandlerResult> => {
          if (hook.id === "deny-write") return { decision: { action: "deny", reason: "read only" } };
          if (hook.id === "rewrite") return { decision: { action: "modify", data: { input: { path: "safe.txt" } } } };
          if (hook.id === "redact") return { decision: { action: "modify", data: { result: "redacted" } } };
          return { decision: { action: "allow" } };
        },
      },
    }),
  };
}

describe("createRuntimeHookedToolExecutor", () => {
  it("denies before the tool side effect in direct chat", async () => {
    const sideEffect = vi.fn(async () => "written");
    const execute = createRuntimeHookedToolExecutor({
      executor: sideEffect,
      hooks: context([{
        id: "deny-write",
        event: "tool:before",
        matcher: { tools: ["write"] },
        handler: { type: "tool", tool: "policy" },
      }]),
    });
    await expect(execute("write", { path: "unsafe.txt" })).resolves.toBe("Error: Runtime hook deny: read only");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("passes modified input through the ordinary executor and can modify its result", async () => {
    const sideEffect = vi.fn(async (_name, args) => `read:${args.path}`);
    const execute = createRuntimeHookedToolExecutor({
      executor: sideEffect,
      hooks: context([
        { id: "rewrite", event: "tool:before", handler: { type: "tool", tool: "policy" } },
        { id: "redact", event: "tool:after", handler: { type: "tool", tool: "policy" } },
      ]),
    });
    await expect(execute("read", { path: "private.txt" })).resolves.toBe("redacted");
    expect(sideEffect).toHaveBeenCalledWith("read", { path: "safe.txt" }, undefined);
  });

  it("emits tool:error for normalized executor failures", async () => {
    const events: string[] = [];
    const hooks: CompletionRuntimeHookContext = {
      surface: "loop",
      identity: { step: "implement" },
      dispatcher: new RuntimeHookEngine({
        definitions: [{ id: "observe-error", event: "tool:error", mode: "observe", handler: { type: "tool", tool: "audit" } }],
        host: { execute: async ({ envelope }) => { events.push(envelope.event); } },
      }),
    };
    const execute = createRuntimeHookedToolExecutor({ executor: async () => "Error: failed", hooks });
    await execute("bash", {});
    expect(events).toEqual(["tool:error"]);
  });

  it("emits sandbox:file_changed after a successful local file mutation", async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const hooks: CompletionRuntimeHookContext = {
      surface: "chat",
      identity: { runId: "run-1", agent: "support" },
      dispatcher: new RuntimeHookEngine({
        definitions: [{
          id: "observe-file",
          event: "sandbox:file_changed",
          mode: "observe",
          handler: { type: "tool", tool: "audit" },
        }],
        host: {
          execute: async ({ envelope }) => {
            events.push({ event: envelope.event, data: envelope.data });
          },
        },
      }),
    };
    const execute = createRuntimeHookedToolExecutor({
      executor: async () => "written",
      hooks,
    });

    await execute("write_file", { path: "src/index.ts" }, { callId: "tool-1" });

    expect(events).toEqual([{
      event: "sandbox:file_changed",
      data: {
        action: "created",
        path: "src/index.ts",
        directory: "src",
        sourceTool: "write_file",
      },
    }]);
  });
});

describe("dispatchCompletionModelPolicyHook", () => {
  it("emits controlling before and observable after events for a fallback", async () => {
    const events: string[] = [];
    const hooks: CompletionRuntimeHookContext = {
      surface: "loop",
      identity: { runId: "run-1", agent: "support", step: "implement" },
      dispatcher: new RuntimeHookEngine({
        definitions: [
          { id: "before", event: "model:switch:before", handler: { type: "tool", tool: "policy" } },
          { id: "after", event: "model:switch:after", mode: "observe", handler: { type: "tool", tool: "audit" } },
        ],
        host: { execute: async ({ envelope }) => { events.push(envelope.event); } },
      }),
    };

    await dispatchCompletionModelPolicyHook(hooks, {
      type: "model-fallback-selected",
      from: { index: 0, retryIndex: 0, model: "primary", isFallback: false, totalCandidates: 2 },
      to: { index: 1, retryIndex: 0, model: "fallback", isFallback: true, totalCandidates: 2 },
      reason: { class: "rate-limit", phase: "request", retryable: true, message: "busy" },
    });

    expect(events).toEqual(["model:switch:before", "model:switch:after"]);
  });

  it("blocks a fallback before the next provider attempt", async () => {
    const hooks: CompletionRuntimeHookContext = {
      surface: "chat",
      identity: { runId: "run-1", agent: "support" },
      dispatcher: new RuntimeHookEngine({
        definitions: [{ id: "pin", event: "model:switch:before", handler: { type: "tool", tool: "policy" } }],
        host: { execute: async () => ({ decision: { action: "deny", reason: "model pinned" } }) },
      }),
    };

    await expect(dispatchCompletionModelPolicyHook(hooks, {
      type: "model-fallback-selected",
      from: { index: 0, retryIndex: 0, model: "primary", isFallback: false, totalCandidates: 2 },
      to: { index: 1, retryIndex: 0, model: "fallback", isFallback: true, totalCandidates: 2 },
      reason: { class: "rate-limit", phase: "request", retryable: true, message: "busy" },
    })).rejects.toThrow("Runtime hook deny: model pinned");
  });
});
