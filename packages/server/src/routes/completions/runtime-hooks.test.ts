import { describe, expect, it, vi } from "vitest";
import {
  RuntimeHookEngine,
  type RuntimeHookDefinition,
  type RuntimeHookHandlerResult,
} from "@polpo-ai/core/runtime-hooks";
import {
  createRuntimeHookedToolExecutor,
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
});
