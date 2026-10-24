import { describe, expect, it, vi } from "vitest";
import { createScriptedHookRuntime, type HooksConfig } from "@polpo-ai/core/runtime-hooks";
import {
  createRuntimeHookedToolExecutor,
  dispatchCompletionModelPolicyHook,
  takePendingHookContext,
  type CompletionRuntimeHookContext,
} from "./runtime-hooks.js";

function context(hooks: HooksConfig, respond: Parameters<typeof createScriptedHookRuntime>[0]["respond"]): CompletionRuntimeHookContext {
  return { surface: "chat", runtime: createScriptedHookRuntime({ hooks, respond, context: { cwd: "/workspace" } }) };
}

const fallback = {
  type: "model-fallback-selected" as const,
  from: { index: 0, retryIndex: 0, model: "anthropic/claude-sonnet-5", isFallback: false, totalCandidates: 2 },
  to: { index: 1, retryIndex: 0, model: "openai/gpt-6.1", isFallback: true, totalCandidates: 2 },
  reason: { class: "rate-limit" as const, phase: "request" as const, retryable: true, message: "busy" },
};

describe("createRuntimeHookedToolExecutor", () => {
  it("denies before the tool side effect with the hook's reason as the tool error", async () => {
    const sideEffect = vi.fn(async () => "written");
    const execute = createRuntimeHookedToolExecutor({
      executor: sideEffect,
      hooks: context({ PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "policy" }] }] },
        () => ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "read only" } }) })),
    });
    await expect(execute("write", { path: "unsafe.txt", content: "x" })).resolves.toBe("Error: read only");
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("applies updatedInput in the Claude shape and updatedToolOutput to the result", async () => {
    const sideEffect = vi.fn(async (_name: string, args: Record<string, unknown>) => `ran:${args.command}`);
    const execute = createRuntimeHookedToolExecutor({
      executor: sideEffect,
      hooks: context({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rewrite" }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "redact" }] }],
      }, (input) => input.hook_event_name === "PreToolUse"
        ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "npm run lint" } } }) }
        : { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: { stdout: "[redacted]", stderr: "", interrupted: false, isImage: false } } }) }),
    });
    await expect(execute("bash", { command: "npm run lint -- --fix" })).resolves.toBe("[redacted]");
    expect(sideEffect).toHaveBeenCalledWith("bash", { command: "npm run lint" }, undefined);
  });

  it("routes failed results to PostToolUseFailure and shows exit-2 feedback to the model", async () => {
    const events: string[] = [];
    const execute = createRuntimeHookedToolExecutor({
      executor: async () => "Error: Exit code 1",
      hooks: context({ PostToolUseFailure: [{ hooks: [{ type: "command", command: "advise" }] }] }, (input) => {
        events.push(input.hook_event_name);
        return { exitCode: 2, stderr: "install dependencies first" };
      }),
    });
    const result = await execute("bash", { command: "npm test" });
    expect(events).toEqual(["PostToolUseFailure"]);
    expect(result).toContain("Error: Exit code 1");
    expect(result).toContain("install dependencies first");
  });

  it("fires FileChanged for a watched file written by a workspace tool", async () => {
    const seen: Record<string, any>[] = [];
    const execute = createRuntimeHookedToolExecutor({
      executor: async () => "written",
      hooks: context({ FileChanged: [{ matcher: ".envrc|.env", hooks: [{ type: "command", command: "reload-env" }] }] }, (input) => {
        seen.push(input);
        return {};
      }),
    });
    await execute("write", { path: "src/index.ts", content: "x" });
    await execute("write", { path: ".env", content: "A=1" });
    expect(seen).toEqual([expect.objectContaining({ hook_event_name: "FileChanged", file_path: "/workspace/.env", event: "add" })]);
  });

  it("continue: false from a tool hook records a stop for the next boundary", async () => {
    const hooks = context({ PostToolUse: [{ hooks: [{ type: "command", command: "halt" }] }] },
      () => ({ stdout: JSON.stringify({ continue: false, stopReason: "Build failed" }) }));
    const execute = createRuntimeHookedToolExecutor({ executor: async () => "ok", hooks });
    await execute("bash", { command: "make" });
    expect(hooks.runtime.pendingStop).toEqual({ reason: "Build failed" });
  });
});

describe("dispatchCompletionModelPolicyHook", () => {
  it("an automatic fallback fires PostModelSwitch with source auto and queues its context", async () => {
    const seen: Record<string, any>[] = [];
    const hooks = context({ PostModelSwitch: [{ matcher: ".*gpt.*", hooks: [{ type: "command", command: "guidance" }] }] }, (input) => {
      seen.push(input);
      return { stdout: "On GPT, keep answers short." };
    });
    await dispatchCompletionModelPolicyHook(hooks, fallback);
    expect(seen[0]).toMatchObject({ hook_event_name: "PostModelSwitch", from_model: "anthropic/claude-sonnet-5", to_model: "openai/gpt-6.1", source: "auto", requested_model: null });
    expect(takePendingHookContext(hooks)?.content).toContain("On GPT, keep answers short.");
    expect(takePendingHookContext(hooks)).toBeUndefined();
  });
});
