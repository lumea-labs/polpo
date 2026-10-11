import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentStore } from "../file-agent-store.js";

const directories: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(async () => {
  for (const child of children) { const done = once(child, "close"); child.kill("SIGKILL"); await done; }
  children.clear();
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
async function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "polpo-file-process-"));
  directories.push(root);
  const dir = join(root, ".polpo");
  if (!legacy) mkdirSync(join(dir, "agents"), { recursive: true });
  const store = new FileAgentStore(dir);
  await store.createAgent({ name: "support", role: "before", systemPrompt: "Before" }, "default");
  const snapshot = (await store.getAgentSnapshot("support"))!;
  const mutation = { expected: snapshot.revision, mutationId: "process-mutation", patch: { set: { role: "after", systemPrompt: "After" } } };
  return { dir, store, mutation, snapshot };
}
async function worker(dir: string, mode: string, parameter = "") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/file-store-process.mjs", import.meta.url)), dir, mode, parameter]);
  children.add(child);
  const messages: any[] = [];
  let output = "", errors = "";
  const waiting: Array<{ predicate: (message: any) => boolean; resolve: (value: any) => void; reject: (reason: Error) => void }> = [];
  child.stderr.on("data", data => { errors += data; });
  child.stdout.on("data", data => {
    output += data;
    while (output.includes("\n")) {
      const end = output.indexOf("\n");
      const message = JSON.parse(output.slice(0, end));
      output = output.slice(end + 1);
      messages.push(message);
      for (const waiter of [...waiting]) if (waiter.predicate(message)) { waiting.splice(waiting.indexOf(waiter), 1); waiter.resolve(message); }
    }
  });
  const closed = new Promise<void>(resolve => child.on("close", () => {
    children.delete(child);
    for (const waiter of waiting.splice(0)) waiter.reject(new Error(`Child exited before its checkpoint: ${errors}`));
    resolve();
  }));
  const next = (predicate: (message: any) => boolean): Promise<any> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => waiting.push({ predicate, resolve, reject }));
  };
  await next(m => m.ready);
  return { child, next, closed, start: (input: unknown) => child.stdin.write(JSON.stringify(input)),
    kill: async () => { child.kill("SIGKILL"); await closed; } };
}

describe("real file-store processes", () => {
  it("fails explicitly if the OS-lock dependency is unavailable", async () => {
    const { dir } = await fixture();
    const child = await worker(dir, "unavailable");
    child.start({});
    expect(await child.next(m => m.error)).toEqual({ error: "file_coordinator_unavailable" });
    await child.closed;
  });

  it("serializes a built CLI skill assignment with a built runtime update", async () => {
    const { dir, store } = await fixture();
    mkdirSync(join(dir, "skills/mail"), { recursive: true });
    writeFileSync(join(dir, "skills/mail/SKILL.md"), "---\nname: mail\ndescription: Mail\n---\nMail");
    const [cli, runtime] = await Promise.all([worker(dir, "skills"), worker(dir, "merge")]);
    cli.start(["mail"]); runtime.start({ role: "Runtime changed" });
    expect(await cli.next(m => m.ok || m.error)).toMatchObject({ ok: true });
    expect(await runtime.next(m => m.ok || m.error)).toMatchObject({ ok: true });
    await Promise.all([cli.closed, runtime.closed]);
    expect(await store.getAgent("support")).toMatchObject({ role: "Runtime changed", skills: ["mail"] });
  });
  it("gives two simultaneous CAS writers one winner, and preserves independent ordinary patches", async () => {
    const { dir, store, mutation } = await fixture();
    const [a, b] = await Promise.all([worker(dir, "cas"), worker(dir, "cas")]);
    a.start(mutation);
    b.start({ ...mutation, mutationId: "other", patch: { set: { role: "other" } } });
    const results = await Promise.all([a.next(m => m.ok || m.error), b.next(m => m.ok || m.error)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.error)).toEqual([{ error: "agent_revision_conflict" }]);
    await Promise.all([a.closed, b.closed]);
    const [c, d] = await Promise.all([worker(dir, "merge"), worker(dir, "merge")]);
    c.start({ role: "merged" }); d.start({ skills: ["mail"] });
    await Promise.all([c.closed, d.closed]);
    expect(await store.getAgent("support")).toMatchObject({ role: "merged", skills: ["mail"] });
  });

  it("keeps a live lock exclusive and recovers it immediately when its owner is killed", async () => {
    const { dir, mutation, store } = await fixture();
    const holder = await worker(dir, "hold");
    holder.start({}); await holder.next(m => m.locked);
    const contender = await worker(dir, "cas");
    let completed = false;
    const result = contender.next(m => m.ok || m.error).then(value => { completed = true; return value; });
    contender.start(mutation);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(completed).toBe(false);
    await holder.kill();
    expect(await result).toMatchObject({ ok: true });
    await contender.closed;
    expect((await store.getAgent("support"))?.role).toBe("after");
  });

  it("recovers configuration, prompt, identity and receipt after every filesystem checkpoint", async () => {
    const baseline = await fixture();
    const counter = await worker(baseline.dir, "count");
    counter.start(baseline.mutation);
    const { checkpoints } = await counter.next(m => m.ok);
    await counter.closed;
    expect(checkpoints).toBeGreaterThan(8);
    for (let index = 1; index <= checkpoints; index++) {
      const { dir, store, mutation, snapshot } = await fixture();
      const crashed = await worker(dir, "crash", String(index));
      crashed.start(mutation);
      await crashed.next(m => m.checkpoint);
      await crashed.kill();
      const current = (await store.getAgentSnapshot("support"))!;
      expect(current.revision.incarnation).toBe(snapshot.revision.incarnation);
      expect(["before", "after"]).toContain(current.agent.role);
      expect(current.agent.systemPrompt).toBe(current.agent.role === "before" ? "Before" : "After");
      const receipt = await store.compareAndSwapAgent("support", mutation);
      expect(receipt.snapshot.revision.version).toBe(snapshot.revision.version + 1);
      expect(receipt.snapshot.agent).toMatchObject({ role: "after", systemPrompt: "After" });
      expect(JSON.parse(readFileSync(join(dir, "agents/support/agent.json"), "utf8")).role).toBe("after");
    }
  }, 30_000);

  it("does not clobber a manual edit found in a committed recovery journal", async () => {
    const { dir, store, mutation } = await fixture();
    // Journal rename is the second checkpoint; after it the intent is visible.
    const crashed = await worker(dir, "crash", "3");
    crashed.start(mutation); await crashed.next(m => m.checkpoint); await crashed.kill();
    writeFileSync(join(dir, "agents/support/instructions.md"), "Manual");
    await expect(store.getAgentSnapshot("support")).rejects.toMatchObject({ code: "file_transaction_conflict" });
    expect(readFileSync(join(dir, "agents/support/instructions.md"), "utf8")).toBe("Manual");
  });

  it("recovers legacy-to-directory migration at every checkpoint without losing identity", async () => {
    const baseline = await fixture(true);
    const counter = await worker(baseline.dir, "migrate-count");
    counter.start({});
    const { checkpoints } = await counter.next(m => m.ok);
    await counter.closed;
    for (let index = 1; index <= checkpoints; index++) {
      const { dir, store, snapshot } = await fixture(true);
      const child = await worker(dir, "migrate-crash", String(index));
      child.start({});
      await child.next(m => m.checkpoint);
      await child.kill();
      const current = (await store.getAgentSnapshot("support"))!;
      expect(current.revision.incarnation).toBe(snapshot.revision.incarnation);
      expect(current.agent).toEqual(snapshot.agent);
    }
  }, 30_000);
});
