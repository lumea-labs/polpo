import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@polpo-ai/core/types";
import { FileApprovalStore } from "../file-approval-store.js";
import { withProjectFileTransaction } from "../project-file-transaction.js";

const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "polpo-approval-store-"));
  directories.push(dir);
  return { dir, store: new FileApprovalStore(dir), other: new FileApprovalStore(dir) };
}
function request(id = "approval-a"): ApprovalRequest {
  return { id, gateId: "review", gateName: "Review", taskId: "task-a", status: "pending",
    payload: { task: { description: "Original work" } }, requestedAt: "2026-10-11T12:00:00.000Z" };
}
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("coordinated file approvals", () => {
  it("reads legacy arrays and preserves unrelated requests written by another store", async () => {
    const { dir, store, other } = fixture();
    writeFileSync(join(dir, "approvals.json"), JSON.stringify([request("legacy")]));
    await store.upsert(request("a"));
    await other.upsert(request("b"));
    expect((await store.list()).map(r => r.id)).toEqual(["legacy", "a", "b"]);
    expect(await other.list()).toEqual(await new FileApprovalStore(dir).list());
  });

  it("never restores a deleted request on another write or close", async () => {
    const { dir, store, other } = fixture();
    await store.upsert(request());
    expect(await other.delete("approval-a")).toBe(true);
    await store.upsert(request("b"));
    await other.close();
    await store.close();
    expect((await new FileApprovalStore(dir).list()).map(r => r.id)).toEqual(["b"]);
    expect(await store.delete("absent")).toBe(false);
  });

  it("does not expose mutable cached snapshots from input, get or filtered lists", async () => {
    const { store } = fixture();
    const input = request();
    await store.upsert(input);
    input.status = "approved";
    (input.payload as any).task.description = "Input changed";
    const first = (await store.get(input.id))!;
    expect(first).toEqual(request());
    first.status = "rejected";
    (first.payload as any).task.description = "Read changed";
    (await store.list("pending"))[0].status = "timeout";
    (await store.listByTask("task-a"))[0].payload = "Other edit";
    expect(await store.get(input.id)).toEqual(request());
  });

  it.each(["broken-json", "null", "{}", "[null]", '[{"id":"incomplete"}]',
    JSON.stringify([request(), request()]), JSON.stringify([{ ...request(), status: "unknown" }])])(
    "rejects malformed persisted approvals without replacing the original file (%s)", async raw => {
      const { dir, store } = fixture();
      const path = join(dir, "approvals.json");
      writeFileSync(path, raw);
      for (const action of [() => store.list(), () => store.get("approval-a"), () => store.listByTask("task-a"),
        () => store.upsert(request("new")), () => store.delete("approval-a")]) {
        await expect(action()).rejects.toThrow(/Invalid stored approval/);
        expect(readFileSync(path, "utf8")).toBe(raw);
      }
      await store.close();
      expect(readFileSync(path, "utf8")).toBe(raw);
    });

  it("reports an unreadable destination instead of acknowledging a lost approval", async () => {
    const { dir, store } = fixture();
    mkdirSync(join(dir, "approvals.json"));
    await expect(store.upsert(request())).rejects.toThrow();
    await expect(store.list()).rejects.toThrow();
  });

  it("propagates serialization failures and preserves the last durable state", async () => {
    const { dir, store } = fixture();
    await store.upsert(request());
    const before = readFileSync(join(dir, "approvals.json"), "utf8");
    await expect(store.upsert({ ...request("invalid"), payload: 1n })).rejects.toThrow();
    expect(readFileSync(join(dir, "approvals.json"), "utf8")).toBe(before);
    expect(await store.list()).toEqual([request()]);
  });

  it("refuses symlink destinations without changing the external data", async () => {
    const { dir, store } = fixture();
    const outside = join(fixture().dir, "external.json");
    writeFileSync(outside, JSON.stringify([request()]));
    symlinkSync(outside, join(dir, "approvals.json"));
    await expect(store.list()).rejects.toThrow(/Symbolic links/);
    await expect(store.upsert(request("new"))).rejects.toThrow(/Symbolic links/);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual([request()]);
  });

  it("recovers a committed project journal before returning any approval", async () => {
    const { dir, store, other } = fixture();
    await store.upsert(request());
    // Use the actual coordinator directory, then simulate an interrupted commit.
    withProjectFileTransaction(dir, () => {});
    const before = readFileSync(join(dir, "approvals.json"), "utf8");
    const resolved = { ...request(), status: "approved", resolvedAt: "2026-10-11T12:01:00.000Z" };
    writeFileSync(join(dir, ".runtime/agent-store/pending.json"), JSON.stringify({ version: 1, changes: [
      { path: "approvals.json", before, after: JSON.stringify([resolved]) },
    ] }));
    expect(await other.get("approval-a")).toEqual(resolved);
    expect(await store.list("pending")).toEqual([]);
  });
});
