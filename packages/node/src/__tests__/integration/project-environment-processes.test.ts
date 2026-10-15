import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PolpoClient, type ProjectEnvironment } from "@polpo-ai/sdk";

// Uses compiled runtime packages, two actual Node processes and separate SQLite
// files. This proves restart/data isolation, not managed compute capacity.
const roots: string[] = [];
const children: ChildProcess[] = [];
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const fallback = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { await exited; } finally { clearTimeout(fallback); }
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => stop(child)));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(environment: ProjectEnvironment) {
  const root = await mkdtemp(join(tmpdir(), `polpo-${environment}-`));
  roots.push(root);
  await mkdir(join(root, ".polpo"));
  await writeFile(join(root, ".polpo", "project.json"), JSON.stringify({
    schemaVersion: 2, project: "environment-fixture",
    settings: { storage: "sqlite", logLevel: "quiet" },
  }));
  return root;
}

async function boot(workDir: string, environment: ProjectEnvironment, key: string) {
  const child = fork(new URL("../fixtures/environment-runtime.mjs", import.meta.url), [workDir, environment], {
    execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: process.env.PATH, POLPO_TEST_API_KEY: key, POLPO_VAULT_KEY: createHash("sha256").update(key).digest("hex") },
  });
  children.push(child);
  let diagnostics = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", bytes => {
    diagnostics = `${diagnostics}${String(bytes)}`.slice(-6000);
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime startup timed out: ${diagnostics}`)), 20_000);
    child.once("message", message => {
      clearTimeout(timeout);
      const ready = message as { environment: string; port: number; pid: number };
      if (ready.environment !== environment || ready.pid !== child.pid || !ready.port) reject(new Error("Wrong runtime readiness identity"));
      else resolve(ready.port);
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Runtime exited (${code}): ${diagnostics}`)); });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return { child, baseUrl, client: new PolpoClient({ baseUrl, apiKey: key, environment }) };
}

describe("Development and Production in real self-hosted processes", () => {
  it("keeps SQLite state, sessions and files separate across a Development crash/restart", async () => {
    const devRoot = await directory("development");
    const prodRoot = await directory("production");
    let dev = await boot(devRoot, "development", "development-fixture-key");
    const prod = await boot(prodRoot, "production", "production-fixture-key");
    expect(dev.child.pid).not.toBe(prod.child.pid);
    expect((await dev.client.getHealth()).status).toBe("ok");
    expect((await prod.client.getHealth()).status).toBe("ok");

    const devTask = await dev.client.createTask({ title: "Same name", description: "Development", assignTo: "support", draft: true });
    const prodTask = await prod.client.createTask({ title: "Same name", description: "Production", assignTo: "support", draft: true });
    await dev.client.saveMemory("development-only memory");
    await prod.client.saveMemory("production-only memory");
    await dev.client.uploadFile(devRoot, new Blob(["development file"]), "same.txt");
    await prod.client.uploadFile(prodRoot, new Blob(["production file"]), "same.txt");
    const sessionResponse = await fetch(`${dev.baseUrl}/environments/development/api/v1/chat/sessions/import`, {
      method: "POST", headers: { authorization: "Bearer development-fixture-key", "content-type": "application/json" },
      body: JSON.stringify({ agent: "support", title: "Private session", messages: [{ role: "user", content: "development conversation" }] }),
    });
    expect(sessionResponse.status).toBe(201);
    const sessionId = (await sessionResponse.json()).data.sessionId;
    await expect(prod.client.getTask(devTask.id)).rejects.toThrow();
    await expect(prod.client.getSessionMessages(sessionId)).rejects.toThrow();
    await expect(prod.client.readFile(join(devRoot, "same.txt"))).rejects.toThrow();
    expect((await fetch(`${dev.baseUrl}/environments/production/api/v1/tasks`, { headers: { authorization: "Bearer development-fixture-key" } })).status).toBe(404);

    const oldPid = dev.child.pid;
    await stop(dev.child, "SIGKILL");
    expect((await prod.client.getTasks()).map(task => task.id)).toEqual([prodTask.id]);
    expect((await prod.client.getMemory()).content).toBe("production-only memory");
    dev = await boot(devRoot, "development", "development-fixture-key");
    expect(dev.child.pid).not.toBe(oldPid);
    expect((await dev.client.getTasks()).map(task => task.id)).toEqual([devTask.id]);
    expect((await dev.client.getMemory()).content).toBe("development-only memory");
    expect((await dev.client.getSessionMessages(sessionId)).messages[0].content).toBe("development conversation");
    expect(await (await dev.client.readFile(join(devRoot, "same.txt"))).text()).toBe("development file");
    expect(await (await prod.client.readFile(join(prodRoot, "same.txt"))).text()).toBe("production file");
    expect((await stat(join(devRoot, ".polpo", "state.db"))).size).toBeGreaterThan(0);
    expect((await stat(join(prodRoot, ".polpo", "state.db"))).size).toBeGreaterThan(0);
  }, 60_000);
});
