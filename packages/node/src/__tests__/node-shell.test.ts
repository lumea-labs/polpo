import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeShell } from "../adapters/node-shell.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-node-shell-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 20));
}

describe("self-hosted NodeShell", () => {
  it("reports a timeout as a failure and kills background children", { timeout: 20_000 }, async () => {
    const pidFile = join(dir, "child.pid");
    const result = await new NodeShell().execute(`sleep 60 & echo $! > ${pidFile}; wait`, { timeout: 300 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toMatch(/timed out/i);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    await waitFor(() => !isAlive(childPid));
    expect(isAlive(childPid)).toBe(false);
  });

  it("kills the process tree when the abort signal fires", { timeout: 20_000 }, async () => {
    const pidFile = join(dir, "child.pid");
    const controller = new AbortController();
    const pending = new NodeShell().execute(`sleep 60 & echo $! > ${pidFile}; wait`, { signal: controller.signal });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(130);
    await waitFor(() => !isAlive(childPid));
    expect(isAlive(childPid)).toBe(false);
  });

  it("still runs commands under /bin/sh with exit codes preserved", async () => {
    const result = await new NodeShell().execute("echo ok; exit 3", { cwd: dir });
    expect(result.stdout.trim()).toBe("ok");
    expect(result.exitCode).toBe(3);
  });
});
