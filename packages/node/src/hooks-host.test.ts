import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookEngine } from "@polpo-ai/core/runtime-hooks";
import { createNodeHookHost, isPublicAddress, runCommandThroughShell, runHttpHook, runLocalCommand } from "./hooks-host.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) server.close();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "polpo-hooks-host-"));
  dirs.push(dir);
  return dir;
}

const request = (command: string, extra: Partial<Parameters<typeof runLocalCommand>[0]> = {}) => ({
  event: "PreToolUse" as const,
  handler: { type: "command" as const, command },
  command,
  shell: "bash" as const,
  stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/build" } }),
  env: { CLAUDE_PROJECT_DIR: "/repo" },
  cwd: tmpdir(),
  timeoutMs: 10_000,
  signal: new AbortController().signal,
  ...extra,
});

describe("local command hooks", () => {
  it("delivers the event JSON on stdin, exports env and returns exit code, stdout and stderr", async () => {
    const result = await runLocalCommand(request(`input=$(cat); echo "$input" | grep -q 'rm -rf' && echo "Blocked: $CLAUDE_PROJECT_DIR" >&2 && exit 2; exit 0`));
    expect(result).toMatchObject({ exitCode: 2, stderr: "Blocked: /repo\n" });
  });

  it("runs exec form without a shell: arguments pass verbatim", async () => {
    const result = await runLocalCommand(request("node", { argv: ["-e", "process.stdout.write(process.argv[1])", "$HOME `x` 'q'"] }));
    expect(result).toMatchObject({ exitCode: 0, stdout: "$HOME `x` 'q'" });
  });

  it("reports a missing executable as a start error", async () => {
    const result = await runLocalCommand(request("definitely-not-a-binary-polpo", { argv: [] }));
    expect(result.startError).toBeDefined();
  });

  it("kills the whole process tree when aborted (timeout)", async () => {
    const dir = tmp();
    const marker = join(dir, "child-survived");
    const controller = new AbortController();
    const pending = runLocalCommand(request(`(sleep 2; touch ${marker}) & sleep 30`, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses to honor a capture held open by a background child", async () => {
    const result = await runLocalCommand(request(`echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'; sleep 5 &`));
    expect(result.suspectCapture).toBe(true);
  });

  it("does not flag a background child whose output is redirected", async () => {
    const result = await runLocalCommand(request(`echo ok; sleep 5 >/dev/null 2>&1 &`));
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok\n" });
    expect(result.suspectCapture).toBeUndefined();
  });

  it("bounds captured output", async () => {
    const result = await runLocalCommand(request(`head -c 3000000 /dev/zero | tr '\\0' 'a'`));
    expect(result.stdout.length).toBe(1024 * 1024);
  });

  it("closes stdin so hooks reading it never hang", async () => {
    const result = await runLocalCommand(request(`cat > /dev/null; echo done`));
    expect(result.stdout).toBe("done\n");
  });
});

describe("command hooks through a sandbox Shell", () => {
  it("pipes the event JSON through base64 and preserves exit semantics", async () => {
    const { NodeShell } = await import("./adapters/node-shell.js");
    const shell = new NodeShell();
    const result = await runCommandThroughShell(shell, request(`jq -r .tool_input.command 2>/dev/null || node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_input.command))'; exit 2`));
    expect(result.exitCode).toBe(2);
    expect(result.stdout.trim()).toBe("rm -rf /tmp/build");
  });
});

describe("HTTP hooks", () => {
  async function server(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const instance = createServer(handler);
    servers.push(instance);
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
    const address = instance.address() as { port: number };
    return `http://127.0.0.1:${address.port}/hook`;
  }

  it("refuses private destinations under the default public policy", async () => {
    const url = await server((_req, res) => res.end("{}"));
    const result = await runHttpHook({ event: "PreToolUse", handler: { type: "http", url }, url, headers: {}, body: "{}", timeoutMs: 1_000, signal: new AbortController().signal }, { destinations: "public", lookup: (async () => []) as never });
    expect(result.error).toMatch(/public addresses/);
  });

  it("POSTs the event JSON and returns status and body when private destinations are allowed", async () => {
    let received = "";
    const url = await server((req, res) => {
      req.on("data", (chunk) => { received += chunk; });
      req.on("end", () => res.end(JSON.stringify({ decision: "block", reason: "nope" })));
    });
    const result = await runHttpHook({ event: "Stop", handler: { type: "http", url }, url, headers: { "content-type": "application/json" }, body: '{"hook_event_name":"Stop"}', timeoutMs: 1_000, signal: new AbortController().signal }, { destinations: "any", lookup: (async () => []) as never });
    expect(received).toBe('{"hook_event_name":"Stop"}');
    expect(result).toMatchObject({ status: 200, body: '{"decision":"block","reason":"nope"}' });
  });

  it("does not follow redirects", async () => {
    const url = await server((_req, res) => { res.statusCode = 302; res.setHeader("location", "http://169.254.169.254/"); res.end(); });
    const result = await runHttpHook({ event: "Stop", handler: { type: "http", url }, url, headers: {}, body: "{}", timeoutMs: 1_000, signal: new AbortController().signal }, { destinations: "any", lookup: (async () => []) as never });
    expect(result.status).toBe(302);
  });

  it("aborts a slow endpoint at the timeout", async () => {
    const url = await server(() => { /* never responds */ });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runHttpHook({ event: "Stop", handler: { type: "http", url }, url, headers: {}, body: "{}", timeoutMs: 100, signal: controller.signal }, { destinations: "any", lookup: (async () => []) as never });
    expect(result.timedOut).toBe(true);
  });

  it.each([
    ["8.8.8.8", true], ["10.0.0.1", false], ["127.0.0.1", false], ["169.254.169.254", false], ["100.64.0.1", false],
    ["::1", false], ["::ffff:127.0.0.1", false], ["::ffff:7f00:1", false], ["::ffff:0.0.0.0", false], ["64:ff9b::a00:1", false],
    ["fd00::1", false], ["fe80::1", false], ["fec0::1", false], ["2002:a00:1::", false], ["2606:4700::1111", true],
  ])("isPublicAddress(%s) → %j", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("end to end with the engine", () => {
  it("a copied Claude Code PreToolUse script blocks rm -rf exactly as documented", async () => {
    const dir = tmp();
    const script = join(dir, "block-rm.sh");
    writeFileSync(script, `#!/bin/bash
COMMAND=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).tool_input.command))')
if echo "$COMMAND" | grep -q 'rm -rf'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Destructive command blocked by hook"}}'
else
  exit 0
fi
`, { mode: 0o755 });
    const engine = new HookEngine({
      projectDir: dir,
      host: createNodeHookHost(),
      sources: [{ source: "project", name: "p", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", if: "Bash(rm *)", command: "${CLAUDE_PROJECT_DIR}/block-rm.sh", args: [] }] }] } }],
    });
    const permissionContext = { cwd: dir, projectDir: dir };
    const blocked = await engine.dispatch("PreToolUse", { session_id: "s", cwd: dir, tool_name: "Bash", tool_input: { command: "rm -rf /tmp/build" }, tool_use_id: "t" }, { permissionContext });
    expect(blocked).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: "Destructive command blocked by hook" });
    const allowed = await engine.dispatch("PreToolUse", { session_id: "s", cwd: dir, tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t2" }, { permissionContext });
    expect(allowed.permissionDecision).toBeUndefined();
    expect(readFileSync(script, "utf8")).toContain("rm -rf");
  });
});
