/**
 * Golden conformance suite against the Claude Code hooks reference
 * (https://code.claude.com/docs/en/hooks, baseline 2026-10-24). Each case
 * cites the reference rule it pins.
 */
import { describe, expect, it, vi } from "vitest";
import { HOOK_EVENTS, HOOK_EVENT_NAMES, hookTimeoutMs } from "./events.js";
import { compileHookMatcher, assertLinearRegex, fileChangedWatchNames } from "./matcher.js";
import { matchesBashRule, matchesPermissionRule, parsePermissionRule, splitBashCommand } from "./permission-rule.js";
import { classifyStdout, interpretHookRun, isAllowedTerminalSequence } from "./output.js";
import { composeHookEvent, capHookText, escapeSystemReminder } from "./aggregate.js";
import { HookConfigError, validateHookPack, validateHooksConfig } from "./config.js";
import { HookEngine, interpolateHeader, renderHookPrompt, substituteInputTemplates, type HookHost } from "./engine.js";

const cmd = (exitCode: number, stdout = "", stderr = "") => ({ kind: "command" as const, exitCode, stdout, stderr });

describe("event manifest", () => {
  it("covers every reference event exactly once", () => {
    expect(HOOK_EVENT_NAMES).toHaveLength(33);
    expect(new Set(HOOK_EVENT_NAMES).size).toBe(33);
    for (const name of HOOK_EVENT_NAMES) expect(HOOK_EVENTS[name].name).toBe(name);
  });

  it("applies the reference default timeouts", () => {
    expect(hookTimeoutMs("PreToolUse", "command")).toBe(600_000);
    expect(hookTimeoutMs("UserPromptSubmit", "http")).toBe(30_000);
    expect(hookTimeoutMs("PreModelSwitch", "mcp_tool")).toBe(30_000);
    expect(hookTimeoutMs("PostModelSwitch", "command")).toBe(30_000);
    expect(hookTimeoutMs("MessageDisplay", "command")).toBe(10_000);
    expect(hookTimeoutMs("Stop", "prompt")).toBe(30_000);
    expect(hookTimeoutMs("Stop", "agent")).toBe(60_000);
    expect(hookTimeoutMs("Stop", "command", 120)).toBe(120_000);
  });

  it("enforces handler eligibility per event", () => {
    expect(() => validateHooksConfig({ SessionStart: [{ hooks: [{ type: "http", url: "https://x.test" }] }] })).toThrow(HookConfigError);
    expect(() => validateHooksConfig({ Notification: [{ hooks: [{ type: "prompt", prompt: "x" }] }] })).toThrow(/does not support "prompt"/);
    expect(() => validateHooksConfig({ Stop: [{ hooks: [{ type: "agent", prompt: "x" }] }] })).not.toThrow();
    expect(() => validateHooksConfig({ PermissionRequest: [{ hooks: [{ type: "prompt", prompt: "x" }] }] })).not.toThrow();
    expect(() => validateHooksConfig({ Bogus: [] })).toThrow(/not a supported hook event/);
  });
});

describe("configuration", () => {
  it("accepts the reference examples unchanged", () => {
    const pack = validateHookPack({
      name: "quality-gates",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", if: "Bash(rm *)", command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh", args: [] }] }],
        PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "mcp_tool", server: "my_server", tool: "security_scan", input: { file_path: "${tool_input.file_path}" } }] }],
        Stop: [{ hooks: [{ type: "prompt", prompt: "Evaluate if Claude should stop: $ARGUMENTS", timeout: 30 }] }],
      },
    });
    expect(Object.keys(pack.hooks)).toEqual(["PreToolUse", "PostToolUse", "Stop"]);
  });

  it("rejects the removed array dialect with a migration hint", () => {
    expect(() => validateHookPack({ version: 1, name: "old", hooks: [{ id: "x", event: "tool:before", handler: { type: "command", command: "x" } }] }))
      .toThrow(/removed array format/);
  });

  it("fails deployment on invalid regex matchers instead of never firing", () => {
    expect(() => validateHooksConfig({ PreToolUse: [{ matcher: "mcp__(", hooks: [{ type: "command", command: "x" }] }] })).toThrow(/regular expression/);
  });

  it("ignores unknown handler fields so newer hooks still deploy", () => {
    expect(() => validateHooksConfig({ Stop: [{ hooks: [{ type: "command", command: "x", futureField: true }] }] })).not.toThrow();
  });
});

describe("matcher semantics", () => {
  it.each([
    ["*", "Anything", true],
    ["", "Anything", true],
    [undefined, "Anything", true],
    ["Bash", "Bash", true],
    ["Bash", "BashOutput", false],
    ["Edit|Write", "Write", true],
    ["Edit, Write", "Edit", true],
    ["Edit.*", "NotebookEdit", true],
    ["^Edit$", "NotebookEdit", false],
    ["mcp__memory__.*", "mcp__memory__create_entities", true],
    ["mcp__memory", "mcp__memory__create_entities", false],
    ["mcp__brave-search__.*", "mcp__brave-search__search", true],
    ["code-reviewer", "code-reviewer", true],
  ] as const)("PreToolUse matcher %j vs %j → %j", (matcher, subject, expected) => {
    expect(compileHookMatcher("PreToolUse", matcher)(subject)).toBe(expected);
  });

  it("a named matcher never matches an empty agent type; a match-all does", () => {
    expect(compileHookMatcher("SubagentStop", "Explore")("")).toBe(false);
    expect(compileHookMatcher("SubagentStop", "*")("")).toBe(true);
    expect(compileHookMatcher("SubagentStop", ".*")("")).toBe(true);
  });

  it("uses the narrow exact set on FileChanged and StopFailure", () => {
    // A hyphen keeps the matcher on the regex path for these events.
    expect(compileHookMatcher("StopFailure", "rate_limit|server_error")("server_error")).toBe(true);
    // ", " is not a separator here: the whole value is an unanchored regex.
    expect(compileHookMatcher("StopFailure", "rate_limit, server_error")("server_error")).toBe(false);
    expect(compileHookMatcher("PreToolUse", "rate_limit, server_error")("server_error")).toBe(true);
  });

  it("ignores matchers on events without matcher support", () => {
    expect(compileHookMatcher("Stop", "Bash")(undefined)).toBe(true);
    expect(compileHookMatcher("UserPromptSubmit", "anything")("x")).toBe(true);
  });

  it("builds the FileChanged watch list from literal segments", () => {
    expect(fileChangedWatchNames(".envrc|.env")).toEqual([".envrc", ".env"]);
    expect(fileChangedWatchNames("*")).toEqual(["*"]);
    expect(fileChangedWatchNames(undefined)).toEqual([]);
  });

  it("rejects catastrophic-backtracking shapes and keeps real-world patterns", () => {
    expect(() => assertLinearRegex("(a+)+$")).toThrow();
    expect(() => assertLinearRegex("(.*a){20}")).toThrow();
    expect(() => assertLinearRegex("mcp__.*__write.*")).not.toThrow();
    expect(() => assertLinearRegex("^my-plugin:reviewer$")).not.toThrow();
    expect(() => assertLinearRegex(".*opus.*")).not.toThrow();
  });
});

describe("`if` permission rules", () => {
  // Reference table "How if patterns match Bash commands".
  it.each([
    ["git *", "FOO=bar git push", true],
    ["git *", "npm test && git push", true],
    ["rm *", "echo $(rm -rf /)", true],
    ["rm *", "echo $(date)", false],
    ["git push *", "echo $(date)", true],
    ["rm *", "rm file.txt", true],
    ["ls *", "lsof", false],
    ["ls *", "ls", true],
    ["npm run test:*", "npm run test:unit", true],
  ] as const)("Bash(%s) vs %j → %j", (pattern, command, expected) => {
    expect(matchesBashRule(pattern, command)).toBe(expected);
  });

  it("runs the hook when the command cannot be parsed", () => {
    expect(splitBashCommand('echo "unterminated')).toBeUndefined();
    expect(matchesBashRule("rm *", 'echo "unterminated')).toBe(true);
  });

  const ctx = { cwd: "/repo", projectDir: "/repo", homeDir: "/home/u" };
  it.each([
    ["Edit(*.ts)", "Edit", "/repo/src/deep/a.ts", true],
    ["Edit(*.ts)", "Edit", "/repo/src/a.js", false],
    ["Edit(src/**)", "Edit", "/repo/src/a/b.ts", true],
    ["Edit(src/**)", "Edit", "/repo/lib/src/b.ts", false],
    ["Edit(**/src/**)", "Edit", "/repo/lib/src/b.ts", true],
    ["Edit(*.ts)", "Write", "/repo/a.ts", true],
    ["Read(//etc/**)", "Read", "/etc/passwd", true],
    ["Read(~/.ssh/**)", "Read", "/home/u/.ssh/id_rsa", true],
  ] as const)("%s on %s %s → %j", (rule, tool, path, expected) => {
    expect(matchesPermissionRule(rule, tool, { file_path: path }, ctx)).toBe(expected);
  });

  it("matches tool names, MCP servers and WebFetch domains", () => {
    expect(matchesPermissionRule("Bash", "Bash", { command: "ls" }, ctx)).toBe(true);
    expect(matchesPermissionRule("mcp__memory", "mcp__memory__create", {}, ctx)).toBe(true);
    expect(matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://example.com/x" }, ctx)).toBe(true);
    expect(matchesPermissionRule("WebFetch(domain:example.com)", "WebFetch", { url: "https://evil.test/x" }, ctx)).toBe(false);
    expect(() => parsePermissionRule("not a rule(")).toThrow();
  });
});

describe("stdout classification (exit code 0 rule)", () => {
  it.each([
    ["", "empty"],
    ["hello", "plain"],
    ['["a"]', "plain"],
    ['"quoted"', "plain"],
    ['{"continue": true}', "json"],
    ['  \n{"decision":"block","reason":"x"}\n ', "json"],
    ['{"a":1}\n{"b":2}', "plain"],
    ['{"systemMessage":"x"}\n{"b":2}', "invalid"],
    ["{not json}", "invalid"],
    ["{ starts but not ends", "plain"],
  ] as const)("%j → %s", (stdout, kind) => {
    expect(classifyStdout(stdout).kind).toBe(kind);
  });
});

describe("exit code × stdout table (PreToolUse)", () => {
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "nope" } });
  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });

  it("valid JSON + exit 0 → success, fields apply", () => {
    const outcome = interpretHookRun("PreToolUse", cmd(0, deny));
    expect(outcome).toMatchObject({ status: "success", failed: false });
    expect(outcome.output?.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("valid JSON + exit 2 → blocking; JSON cannot override the block", () => {
    const outcome = interpretHookRun("PreToolUse", cmd(2, allow, "blocked by policy"));
    expect(outcome.status).toBe("blocking");
    const result = composeHookEvent("PreToolUse", [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome, failureBlocks: false, subject: "Bash" }]);
    expect(result.permissionDecision).toBe("deny");
    expect(result.block?.reason).toBe("PreToolUse:Bash hook error: [h]: blocked by policy");
  });

  it("valid JSON + other exit → success decided by fields, but counts as failure", () => {
    const outcome = interpretHookRun("PreToolUse", cmd(1, allow));
    expect(outcome).toMatchObject({ status: "success", failed: true });
  });

  it("invalid JSON + exit 0 → non-blocking error", () => {
    expect(interpretHookRun("PreToolUse", cmd(0, "{oops}"))).toMatchObject({ status: "non_blocking_error", failed: true });
  });

  it("invalid JSON + exit 2 → blocking with stderr as the reason", () => {
    const outcome = interpretHookRun("PreToolUse", cmd(2, "{oops}", "stderr reason"));
    expect(outcome).toMatchObject({ status: "blocking", message: "stderr reason" });
  });

  it("schema-invalid JSON (wrong hookEventName) → non-blocking error", () => {
    const wrong = JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } });
    expect(interpretHookRun("PreToolUse", cmd(0, wrong))).toMatchObject({ status: "non_blocking_error" });
  });

  it("plain text + other exit → non-blocking error carrying the first stderr line", () => {
    expect(interpretHookRun("PreToolUse", cmd(1, "", "something broke\nmore")))
      .toMatchObject({ status: "non_blocking_error", message: "Failed with non-blocking status code: something broke" });
  });

  it("deprecated approve/block map to allow/deny", () => {
    const outcome = interpretHookRun("PreToolUse", cmd(0, JSON.stringify({ decision: "block", reason: "legacy" })));
    const result = composeHookEvent("PreToolUse", [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome, failureBlocks: false }]);
    expect(result).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "legacy" });
  });

  it("composes multiple decisions with deny > defer > ask > allow", () => {
    const entries = ["allow", "ask", "deny", "defer"].map((decision) => ({
      hookLabel: decision,
      handler: { type: "command" as const, command: decision },
      outcome: interpretHookRun("PreToolUse", cmd(0, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: decision } }))),
      failureBlocks: false,
    }));
    expect(composeHookEvent("PreToolUse", entries)).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "deny" });
  });
});

describe("per-event exit 2 behavior", () => {
  const exit2 = (event: Parameters<typeof interpretHookRun>[0], stderr = "because") =>
    composeHookEvent(event, [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome: interpretHookRun(event, cmd(2, "", stderr)), failureBlocks: false }]);

  it("Stop continues the agent with stderr as feedback", () => {
    expect(exit2("Stop").continuation).toEqual({ feedback: "because", kind: "block" });
  });
  it("Stop with a missing-file stderr is a non-blocking error, not a continuation", () => {
    expect(exit2("Stop", "/bin/sh: hook.sh: No such file or directory").continuation).toBeUndefined();
  });
  it("UserPromptSubmit blocks the prompt with a user-facing reason", () => {
    expect(exit2("UserPromptSubmit").block).toEqual({ reason: "because", audience: "user" });
  });
  it("PostToolUse shows stderr to the model; the tool already ran", () => {
    expect(exit2("PostToolUse").modelFeedback).toEqual(["PostToolUse hook error: [h]: because"]);
  });
  it("PermissionRequest ignores exit 2", () => {
    expect(exit2("PermissionRequest").permissionRequest).toBeUndefined();
  });
  it("StopFailure discards output and exit code", () => {
    const result = exit2("StopFailure");
    expect(result.block).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });
  it("Elicitation exit 2 declines", () => {
    expect(exit2("Elicitation").elicitation).toEqual({ action: "decline" });
  });
  it("PostToolBatch exit 2 stops the loop", () => {
    expect(exit2("PostToolBatch").block?.reason).toBe("because");
  });
});

describe("onFailure", () => {
  const timeout = interpretHookRun("PreToolUse", { kind: "command", exitCode: null, stdout: "", stderr: "", timedOut: true });
  it("a failed policy hook blocks only with onFailure: block", () => {
    const blocking = composeHookEvent("PreToolUse", [{ hookLabel: "guard", handler: { type: "command", command: "guard", onFailure: "block" }, outcome: timeout, failureBlocks: true }]);
    expect(blocking.permissionDecision).toBe("deny");
    expect(blocking.block?.reason).toContain('timed out; blocking because onFailure is "block"');
    const open = composeHookEvent("PreToolUse", [{ hookLabel: "guard", handler: { type: "command", command: "guard" }, outcome: timeout, failureBlocks: false }]);
    expect(open.permissionDecision).toBeUndefined();
    expect(open.notices).toHaveLength(1);
  });
  it("PermissionRequest failure with onFailure: block denies the request", () => {
    const outcome = interpretHookRun("PermissionRequest", cmd(1));
    const result = composeHookEvent("PermissionRequest", [{ hookLabel: "h", handler: { type: "command", command: "h", onFailure: "block" }, outcome, failureBlocks: true }]);
    expect(result.permissionRequest?.behavior).toBe("deny");
  });
});

describe("HTTP response handling", () => {
  it.each([
    [{ kind: "http" as const, status: 204, body: "" }, "success"],
    [{ kind: "http" as const, status: 200, body: '{"continue":true}' }, "success"],
    [{ kind: "http" as const, status: 200, body: "plain text" }, "non_blocking_error"],
    [{ kind: "http" as const, status: 500, body: "" }, "non_blocking_error"],
    [{ kind: "http" as const, error: "ECONNREFUSED" }, "non_blocking_error"],
  ])("%j → %s", (result, status) => {
    expect(interpretHookRun("PreToolUse", result).status).toBe(status);
  });
});

describe("JSON output fields", () => {
  it("continue: false stops processing and wins over event decisions", () => {
    const outcome = interpretHookRun("PostToolUse", cmd(0, JSON.stringify({ continue: false, stopReason: "Build failed" })));
    expect(composeHookEvent("PostToolUse", [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome, failureBlocks: false }]).stop)
      .toEqual({ reason: "Build failed" });
  });

  it("Stop additionalContext continues with non-error feedback", () => {
    const outcome = interpretHookRun("Stop", cmd(0, JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "run the tests" } })));
    expect(composeHookEvent("Stop", [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome, failureBlocks: false }]).continuation)
      .toEqual({ feedback: "run the tests", kind: "context" });
  });

  it("plain stdout is context only on the reference events", () => {
    for (const event of ["UserPromptSubmit", "SessionStart", "PostModelSwitch", "UserPromptExpansion"] as const) {
      const result = composeHookEvent(event, [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome: interpretHookRun(event, cmd(0, "branch: main")), failureBlocks: false }]);
      expect(result.additionalContext).toEqual(["branch: main"]);
    }
    const tool = composeHookEvent("PreToolUse", [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome: interpretHookRun("PreToolUse", cmd(0, "noise")), failureBlocks: false }]);
    expect(tool.additionalContext).toEqual([]);
  });

  it("caps strings at 10,000 characters with a 2,000-character preview", () => {
    const capped = capHookText("x".repeat(10_001), () => "/session/hook-output-1.txt");
    expect(capped).toContain("/session/hook-output-1.txt");
    expect(capped.length).toBeLessThan(2_200);
    expect(capHookText("x".repeat(10_000))).toHaveLength(10_000);
  });

  it("neutralizes system-reminder tags in hook context", () => {
    expect(escapeSystemReminder("<system-reminder>x</system-reminder>")).toBe("&lt;system-reminder>x&lt;/system-reminder>");
  });

  it("accepts only allowlisted terminal sequences", () => {
    expect(isAllowedTerminalSequence("\u001b]777;notify;Claude;hi\u0007")).toBe(true);
    expect(isAllowedTerminalSequence("\u0007")).toBe(true);
    expect(isAllowedTerminalSequence("\u001b]52;c;Zm9v\u0007")).toBe(false);
    expect(isAllowedTerminalSequence("\u001b[31mred")).toBe(false);
  });

  it("WorktreeCreate reads the last non-empty stdout line, ANSI stripped", () => {
    const outcome = interpretHookRun("WorktreeCreate", cmd(0, "banner\n\u001b[32m/tmp/wt\u001b[0m\n\n"));
    expect(composeHookEvent("WorktreeCreate", [{ hookLabel: "h", handler: { type: "command", command: "h" }, outcome, failureBlocks: false }]).worktreePath).toBe("/tmp/wt");
  });

  it("Elicitation: decline from one hook overrides accept from another", () => {
    const accept = interpretHookRun("Elicitation", cmd(0, JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content: { a: 1 } } })));
    const decline = interpretHookRun("Elicitation", cmd(0, JSON.stringify({ hookSpecificOutput: { hookEventName: "Elicitation", action: "decline" } })));
    const handler = { type: "command" as const, command: "h" };
    expect(composeHookEvent("Elicitation", [
      { hookLabel: "a", handler, outcome: decline, failureBlocks: false },
      { hookLabel: "b", handler, outcome: accept, failureBlocks: false },
    ]).elicitation).toEqual({ action: "decline" });
  });
});

describe("prompt and agent verdicts", () => {
  const verdict = (ok: boolean, extra: Record<string, unknown> = {}) => ({ kind: "prompt" as const, verdict: { ok, reason: "not done", ...extra } });
  it("Stop ok:false continues; impossible lets the turn end", () => {
    const handler = { type: "prompt" as const, prompt: "p" };
    expect(composeHookEvent("Stop", [{ hookLabel: "p", handler, outcome: interpretHookRun("Stop", verdict(false)), failureBlocks: false }]).continuation?.feedback).toBe("not done");
    expect(composeHookEvent("Stop", [{ hookLabel: "p", handler, outcome: interpretHookRun("Stop", verdict(false, { impossible: true })), failureBlocks: false }]).continuation).toBeUndefined();
  });
  it("PreToolUse ok:false ends the turn by default, continues with continueOnBlock", () => {
    const ends = composeHookEvent("PreToolUse", [{ hookLabel: "p", handler: { type: "prompt", prompt: "p" }, outcome: interpretHookRun("PreToolUse", verdict(false)), failureBlocks: false }]);
    expect(ends).toMatchObject({ permissionDecision: "deny", stop: { reason: "not done" } });
    const continues = composeHookEvent("PreToolUse", [{ hookLabel: "p", handler: { type: "prompt", prompt: "p", continueOnBlock: true }, outcome: interpretHookRun("PreToolUse", verdict(false)), failureBlocks: false }]);
    expect(continues.stop).toBeUndefined();
    expect(continues.block).toEqual({ reason: "not done", audience: "model" });
  });
  it("renders $ARGUMENTS and escaped dollars", () => {
    expect(renderHookPrompt("Check: $ARGUMENTS costs \\$1.00", '{"a":1}')).toBe('Check: {"a":1} costs $1.00');
    expect(renderHookPrompt("No placeholder", '{"a":1}')).toBe('No placeholder\n\n{"a":1}');
  });
});

describe("engine", () => {
  const baseInput = { session_id: "s1", cwd: "/repo", transcript_path: "/repo/.polpo/t.jsonl", permission_mode: "default" };
  const host = (runCommand: HookHost["runCommand"]): HookHost => ({ runCommand });

  it("writes the event JSON to stdin and exports CLAUDE_PROJECT_DIR", async () => {
    const runCommand = vi.fn(async () => ({ kind: "command" as const, exitCode: 0, stdout: "", stderr: "" }));
    const engine = new HookEngine({
      projectDir: "/repo",
      host: host(runCommand),
      sources: [{ source: "project", name: "p", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/check.js"] }] }] } }],
    });
    await engine.dispatch("PreToolUse", { ...baseInput, tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" });
    const request = runCommand.mock.calls[0]![0];
    expect(JSON.parse(request.stdin)).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s1" });
    expect(request.argv).toEqual(["/repo/check.js"]);
    expect(request.env.CLAUDE_PROJECT_DIR).toBe("/repo");
    expect(request.timeoutMs).toBe(600_000);
  });

  it("evaluates `if` only on tool events; elsewhere the hook never runs", async () => {
    const runCommand = vi.fn(async () => ({ kind: "command" as const, exitCode: 2, stdout: "", stderr: "no rm" }));
    const engine = new HookEngine({
      projectDir: "/repo",
      host: host(runCommand),
      sources: [{ source: "project", name: "p", hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", if: "Bash(rm *)", command: "guard" }] }],
        Stop: [{ hooks: [{ type: "command", if: "Bash(rm *)", command: "never" }] }],
      } }],
    });
    const permissionContext = { cwd: "/repo", projectDir: "/repo" };
    const safe = await engine.dispatch("PreToolUse", { ...baseInput, tool_name: "Bash", tool_input: { command: "npm test" } }, { permissionContext });
    expect(safe.permissionDecision).toBeUndefined();
    const risky = await engine.dispatch("PreToolUse", { ...baseInput, tool_name: "Bash", tool_input: { command: "rm -rf /tmp/build" } }, { permissionContext });
    expect(risky.permissionDecision).toBe("deny");
    await engine.dispatch("Stop", { ...baseInput, stop_hook_active: false, last_assistant_message: "done" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("runs an identical handler from two settings sources once, but skill copies separately", async () => {
    const runCommand = vi.fn(async () => ({ kind: "command" as const, exitCode: 0, stdout: "", stderr: "" }));
    const hooks = { Stop: [{ hooks: [{ type: "command" as const, command: "check" }] }] };
    const engine = new HookEngine({
      projectDir: "/repo",
      host: host(runCommand),
      sources: [
        { source: "project", name: "a", hooks },
        { source: "local", name: "b", hooks },
        { source: "skill", name: "s", hooks },
      ],
    });
    await engine.dispatch("Stop", { ...baseInput, stop_hook_active: false, last_assistant_message: "x" });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("removes a skill's once hook only after a successful run", async () => {
    const results = [cmd(1, "", "boom"), cmd(0), cmd(0)];
    const runCommand = vi.fn(async () => results.shift()!);
    const engine = new HookEngine({
      projectDir: "/repo",
      host: host(runCommand),
      sources: [{ source: "skill", name: "s", hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "once", once: true }] }] } }],
    });
    for (const prompt of ["a", "b", "c"]) await engine.dispatch("UserPromptSubmit", { ...baseInput, prompt });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("converts a subagent's Stop hook to SubagentStop", async () => {
    const runCommand = vi.fn(async () => cmd(0));
    const engine = new HookEngine({
      projectDir: "/repo",
      host: host(runCommand),
      sources: [{ source: "subagent", name: "reviewer", hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }],
    });
    await engine.dispatch("Stop", { ...baseInput, stop_hook_active: false, last_assistant_message: "x" });
    expect(runCommand).not.toHaveBeenCalled();
    await engine.dispatch("SubagentStop", { ...baseInput, agent_type: "reviewer", agent_id: "a1", stop_hook_active: false, last_assistant_message: "x" });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("times out a hung command, discards its output and fails open by default", async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi.fn((request: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
      const engine = new HookEngine({
        projectDir: "/repo",
        host: { runCommand: runCommand as any },
        sources: [{ source: "project", name: "p", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "hang", timeout: 1 }] }] } }],
      });
      const pending = engine.dispatch("PreToolUse", { ...baseInput, tool_name: "Bash", tool_input: { command: "ls" } });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.permissionDecision).toBeUndefined();
      expect(result.notices[0]?.message).toBe("Hook timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a PreModelSwitch timeout blocks the switch", async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi.fn((request: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
      const engine = new HookEngine({
        projectDir: "/repo",
        host: { runCommand: runCommand as any },
        sources: [{ source: "project", name: "p", hooks: { PreModelSwitch: [{ hooks: [{ type: "command", command: "hang" }] }] } }],
      });
      const pending = engine.dispatch("PreModelSwitch", { ...baseInput, from_model: "a", to_model: "b" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending).permissionDecision).toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays a terminal receipt without running the handler again", async () => {
    const runCommand = vi.fn(async () => cmd(2, "", "fix the tests"));
    const store = new Map<string, any>();
    const engine = new HookEngine({
      projectDir: "/repo",
      host: { runCommand, findCompleted: async (key) => store.get(key), record: async (record) => { store.set(record.key, record); } },
      sources: [{ source: "project", name: "p", hooks: { Stop: [{ hooks: [{ type: "command", command: "validate" }] }] } }],
    });
    const input = { ...baseInput, stop_hook_active: false, last_assistant_message: "done" };
    const first = await engine.dispatch("Stop", input, { occurrenceId: "run1:stop:1" });
    const replay = await engine.dispatch("Stop", input, { occurrenceId: "run1:stop:1" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(replay.continuation).toEqual(first.continuation);
    await engine.dispatch("Stop", input, { occurrenceId: "run1:stop:2" });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("reports a missing host capability as a hook error, never as silent success", async () => {
    const engine = new HookEngine({
      projectDir: "/repo",
      host: {},
      sources: [{ source: "project", name: "p", hooks: { PreToolUse: [{ hooks: [{ type: "http", url: "https://policy.test", onFailure: "block" }] }] } }],
    });
    const result = await engine.dispatch("PreToolUse", { ...baseInput, tool_name: "Bash", tool_input: { command: "ls" } });
    expect(result.permissionDecision).toBe("deny");
  });

  it("disableAllHooks cannot disable managed policy hooks", async () => {
    const runCommand = vi.fn(async () => cmd(0));
    const hooks = (command: string) => ({ Stop: [{ hooks: [{ type: "command" as const, command }] }] });
    const engine = new HookEngine({
      projectDir: "/repo",
      host: host(runCommand),
      disableAllHooks: true,
      sources: [
        { source: "policy", name: "org", hooks: hooks("managed") },
        { source: "project", name: "p", hooks: hooks("project") },
      ],
    });
    await engine.dispatch("Stop", { ...baseInput, stop_hook_active: false, last_assistant_message: "x" });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]![0].command).toBe("managed");
  });
});

describe("templating", () => {
  it("interpolates only allowed env vars in HTTP headers", () => {
    const allowed: Record<string, string> = { MY_TOKEN: "t0k" };
    expect(interpolateHeader("Bearer $MY_TOKEN / ${OTHER}", (name) => allowed[name] ?? "")).toBe("Bearer t0k / ");
  });
  it("substitutes ${path} from hook input in MCP tool input", () => {
    expect(substituteInputTemplates({ file_path: "${tool_input.file_path}", n: 1 }, { tool_input: { file_path: "/a.ts" } }))
      .toEqual({ file_path: "/a.ts", n: 1 });
  });
});
