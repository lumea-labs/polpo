import { describe, expect, it, vi } from "vitest";
import { HookEngine, type CommandHookRequest } from "./engine.js";
import { HookRuntime } from "./runtime.js";
import type { HooksConfig } from "./config.js";
import type { CommandRunResult } from "./output.js";

function runtime(hooks: HooksConfig, respond: (request: CommandHookRequest) => Partial<CommandRunResult>, cap?: number) {
  const runCommand = vi.fn(async (request: CommandHookRequest): Promise<CommandRunResult> => ({
    kind: "command", exitCode: 0, stdout: "", stderr: "", ...respond(request),
  }));
  const engine = new HookEngine({ projectDir: "/work", host: { runCommand }, sources: [{ source: "project", name: "p", hooks }] });
  const hookRuntime = new HookRuntime(engine, {
    sessionId: "sess-1",
    cwd: "/work",
    projectDir: "/work",
    transcriptPath: "/work/.polpo/transcripts/sess-1.jsonl",
    permissionMode: "default",
    polpo: { run_id: "run-1", surface: "chat" },
  }, cap === undefined ? {} : { stopHookBlockCap: cap });
  return { runCommand, hookRuntime, stdin: (index: number) => JSON.parse(runCommand.mock.calls[index]![0].stdin) };
}

describe("tool boundary", () => {
  it("projects Polpo tools to Claude names and fields, and maps updatedInput back", async () => {
    const { hookRuntime, stdin } = runtime(
      { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "rewrite" }] }] },
      () => ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { file_path: "/work/safe.txt", content: "redacted" } } }) }),
    );
    const outcome = await hookRuntime.preToolUse("write", { path: "notes.txt", content: "secret" }, "call-1");
    expect(stdin(0)).toMatchObject({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/work/notes.txt", content: "secret" },
      tool_use_id: "call-1",
      session_id: "sess-1",
      cwd: "/work",
      permission_mode: "default",
      polpo: { run_id: "run-1", surface: "chat" },
    });
    expect(outcome).toMatchObject({ decision: "allow", input: { path: "/work/safe.txt", content: "redacted" } });
  });

  it("a Bash exit-2 hook denies before the side effect with the documented reason", async () => {
    const { hookRuntime } = runtime(
      { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "no-rm" }] }] },
      () => ({ exitCode: 2, stderr: "Blocked: rm commands are not allowed" }),
    );
    const outcome = await hookRuntime.preToolUse("bash", { command: "rm -rf build" }, "call-2");
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toBe("PreToolUse:Bash hook error: [no-rm]: Blocked: rm commands are not allowed");
  });

  it("PostToolUse feedback and context reach the model next to the result", async () => {
    const { hookRuntime } = runtime(
      { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "lint" }] }] },
      () => ({ stdout: JSON.stringify({ decision: "block", reason: "lint failed: missing semicolon", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "This file is generated." } }) }),
    );
    const outcome = await hookRuntime.postToolUse("edit", { path: "a.ts", old_text: "x", new_text: "y" }, "Edited a.ts", "call-3", 12);
    expect(outcome.result).toContain("Edited a.ts");
    expect(outcome.result).toContain("lint failed: missing semicolon");
    expect(outcome.result).toContain("This file is generated.");
  });

  it("failed tool results go to PostToolUseFailure with the error", async () => {
    const { hookRuntime, stdin } = runtime(
      { PostToolUseFailure: [{ hooks: [{ type: "command", command: "log" }] }] },
      () => ({}),
    );
    await hookRuntime.postToolUse("bash", { command: "npm test" }, "Error: Exit code 1", "call-4", 10);
    expect(stdin(0)).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "Exit code 1", is_interrupt: false, duration_ms: 10 });
  });
});

describe("Stop continuation controller", () => {
  it("continues the same agent with feedback and marks stop_hook_active on the next attempt", async () => {
    const { hookRuntime, stdin } = runtime({ Stop: [{ hooks: [{ type: "command", command: "validate" }] }] },
      (request) => JSON.parse(request.stdin).last_assistant_message === "fixed" ? {} : { exitCode: 2, stderr: "tests fail: 2" });
    const first = await hookRuntime.stop("done", { attempt: 1 });
    expect(first).toMatchObject({ action: "continue", feedback: "tests fail: 2", kind: "block" });
    expect(stdin(0).stop_hook_active).toBe(false);
    const second = await hookRuntime.stop("fixed", { attempt: 2 });
    expect(second.action).toBe("accept");
    expect(stdin(1).stop_hook_active).toBe(true);
  });

  it("allows exactly eight consecutive continuations, then overrides the block", async () => {
    const { hookRuntime } = runtime({ Stop: [{ hooks: [{ type: "command", command: "never-satisfied" }] }] },
      () => ({ exitCode: 2, stderr: "keep going" }));
    const actions: string[] = [];
    for (let attempt = 1; attempt <= 9; attempt++) actions.push((await hookRuntime.stop("x", { attempt })).action);
    expect(actions).toEqual([...Array(8).fill("continue"), "accept"]);
  });

  it("a real tool call resets the consecutive counter", async () => {
    const { hookRuntime } = runtime({ Stop: [{ hooks: [{ type: "command", command: "strict" }] }] },
      () => ({ exitCode: 2, stderr: "again" }), 2);
    expect((await hookRuntime.stop("a", { attempt: 1 })).action).toBe("continue");
    expect((await hookRuntime.stop("b", { attempt: 2 })).action).toBe("continue");
    hookRuntime.noteToolCall();
    expect((await hookRuntime.stop("c", { attempt: 3 })).action).toBe("continue");
  });

  it("keeps stop_hook_active true through a repair that calls tools", async () => {
    const { hookRuntime, stdin } = runtime({ Stop: [{ hooks: [{ type: "command", command: "validate" }] }] },
      (request) => JSON.parse(request.stdin).last_assistant_message === "fixed" ? {} : { exitCode: 2, stderr: "fix it" });
    expect((await hookRuntime.stop("draft", { attempt: 1 })).action).toBe("continue");
    hookRuntime.noteToolCall();
    expect((await hookRuntime.stop("fixed", { attempt: 2 })).action).toBe("accept");
    expect(stdin(1).stop_hook_active).toBe(true);
    expect(hookRuntime.stopState()).toEqual({ consecutiveStopContinuations: 0, stopHookActive: true });
  });

  it("continue: false halts instead of continuing", async () => {
    const { hookRuntime } = runtime({ Stop: [{ hooks: [{ type: "command", command: "halt" }] }] },
      () => ({ stdout: JSON.stringify({ continue: false, stopReason: "Budget exhausted" }) }));
    expect(await hookRuntime.stop("x", { attempt: 1 })).toMatchObject({ action: "halt", reason: "Budget exhausted" });
  });

  it("restores the counter from a checkpoint", async () => {
    const { hookRuntime } = runtime({ Stop: [{ hooks: [{ type: "command", command: "strict" }] }] },
      () => ({ exitCode: 2, stderr: "again" }), 3);
    hookRuntime.restoreStopState({ consecutiveStopContinuations: 3 });
    expect((await hookRuntime.stop("x", { attempt: 4 })).action).toBe("accept");
  });

  it("restores stop_hook_active from a checkpoint, including legacy ones without the flag", async () => {
    const { hookRuntime, stdin } = runtime({ Stop: [{ hooks: [{ type: "command", command: "log" }] }] }, () => ({}));
    hookRuntime.restoreStopState({ consecutiveStopContinuations: 0, stopHookActive: true });
    await hookRuntime.stop("x", { attempt: 2 });
    expect(stdin(0).stop_hook_active).toBe(true);
    const legacy = runtime({ Stop: [{ hooks: [{ type: "command", command: "log" }] }] }, () => ({}));
    legacy.hookRuntime.restoreStopState({ consecutiveStopContinuations: 2 });
    await legacy.hookRuntime.stop("x", { attempt: 3 });
    expect(legacy.stdin(0).stop_hook_active).toBe(true);
  });
});
