import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VersionedAgentStore } from "@polpo-ai/core/agent-store";
import { FileAgentStore } from "../file-agent-store.js";
import { FileTeamStore } from "../file-team-store.js";
import { migrateProjectLayoutV2, reconcileProjectAgentFiles, writeProjectAgent } from "../project-layout-files.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture(directory: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "polpo-agent-version-"));
  directories.push(dir);
  if (directory) mkdirSync(join(dir, "agents"));
  return { dir, store: new FileAgentStore(dir) as VersionedAgentStore };
}
describe.each([false, true])("versioned agent files, directory=%s", directory => {
  it("persists explicit unset and null patches, including runtime-only timestamps", async () => {
    const { store } = fixture(directory);
    await store.createAgent({ name: "support", skills: ["mail"] }, "default");
    const initial = (await store.getAgentSnapshot("support"))!;
    const receipt = await store.compareAndSwapAgent("support", {
      expected: initial.revision, mutationId: "unset-fields", patch: { unset: ["skills", "createdAt"], set: { role: null, systemPrompt: null } },
    });
    const current = (await store.getAgentSnapshot("support"))!;
    expect(current).toEqual(receipt.snapshot);
    expect(current.agent).not.toHaveProperty("skills");
    expect(current.agent).not.toHaveProperty("createdAt");
    expect(current.agent.role).toBeNull();
    expect(current.agent.systemPrompt).toBeNull();
    await store.updateAgent("support", { role: "Later" });
    expect(await store.getAgent("support")).not.toHaveProperty("createdAt");
    expect((await store.getAgent("support"))?.systemPrompt).toBeNull();
  });
  it("persists identity outside authored configuration and fences stale writes/deletes", async () => {
    const { dir, store } = fixture(directory);
    await store.createAgent({ name: "support", role: "Support" }, "default");
    const initial = (await store.getAgentSnapshot("support"))!;
    const mutation = { mutationId: "update-role", expected: initial.revision, patch: { set: { role: "New" } } };
    const receipt = await store.compareAndSwapAgent("support", mutation);
    expect(receipt.snapshot.revision).toEqual({ ...initial.revision, version: initial.revision.version + 1 });
    expect(await new FileAgentStore(dir).compareAndSwapAgent("support", mutation)).toEqual(receipt);
    await expect(store.compareAndSwapAgent("support", { ...mutation, patch: { set: { role: "Other" } } }))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
    await expect(store.deleteAgentIfRevision("support", initial.revision)).rejects.toMatchObject({ code: "agent_revision_conflict" });
    expect(readFileSync(join(dir, directory ? "agents/support/agent.json" : "agents.json"), "utf8"))
      .not.toContain(initial.revision.incarnation);
    await store.deleteAgentIfRevision("support", receipt.snapshot.revision);
    await store.createAgent({ name: "support", role: "New" }, "default");
    expect((await store.getAgentSnapshot("support"))!.revision.incarnation).not.toBe(initial.revision.incarnation);
    await expect(store.compareAndSwapAgent("support", mutation)).rejects.toMatchObject({ code: "agent_revision_conflict" });
  });

  it("does not recover an old receipt after another update and never mutates its caller", async () => {
    const { store } = fixture(directory);
    const agent = { name: "support", role: "Support" };
    await store.createAgent(agent, "default");
    expect(agent).toEqual({ name: "support", role: "Support" });
    const initial = (await store.getAgentSnapshot("support"))!;
    const mutation = { mutationId: "noop", expected: initial.revision, patch: {} };
    await store.compareAndSwapAgent("support", mutation);
    await store.updateAgent("support", { role: "Changed" });
    await expect(store.compareAndSwapAgent("support", mutation)).rejects.toMatchObject({ code: "agent_revision_conflict" });
  });

  it("coordinates team rename/delete and volatile cleanup with agent identity", async () => {
    const { dir, store } = fixture(directory);
    const teams = new FileTeamStore(dir);
    await teams.createTeam({ name: "ops", agents: [] });
    await store.createAgent({ name: "support", volatile: true, missionGroup: "one" }, "ops");
    const first = (await store.getAgentSnapshot("support"))!;
    await teams.renameTeam("ops", "success");
    const renamed = (await store.getAgentSnapshot("support"))!;
    expect(renamed.teamName).toBe("success");
    expect(renamed.revision.incarnation).toBe(first.revision.incarnation);
    expect(renamed.revision.version).toBeGreaterThan(first.revision.version);
    expect(await store.cleanupVolatileAgents("one")).toBe(1);
    await store.createAgent({ name: "support" }, "success");
    await teams.deleteTeam("success");
    expect(await store.getAgentSnapshot("support")).toBeUndefined();
  });
});

it("uses the same revision for public directory writers and preserves identity through migration", async () => {
  const { dir, store } = fixture(false);
  await store.createAgent({ name: "support", role: "Support" }, "default");
  const initial = (await store.getAgentSnapshot("support"))!;
  migrateProjectLayoutV2(dir);
  expect((await store.getAgentSnapshot("support"))!.revision.incarnation).toBe(initial.revision.incarnation);
  const before = (await store.getAgentSnapshot("support"))!;
  writeProjectAgent(dir, { ...before.agent, skills: ["mail"] }, before.teamName);
  const after = (await store.getAgentSnapshot("support"))!;
  expect(after.revision).toEqual({ ...before.revision, version: before.revision.version + 1 });
  await expect(store.compareAndSwapAgent("support", { expected: before.revision, mutationId: "stale-cli", patch: {} }))
    .rejects.toMatchObject({ code: "agent_revision_conflict" });
});

it("fails closed on uncoordinated edits instead of accepting the old revision", async () => {
  const { dir, store } = fixture(true);
  await store.createAgent({ name: "support", role: "Support" }, "default");
  const old = (await store.getAgentSnapshot("support"))!;
  writeFileSync(join(dir, "agents/support/instructions.md"), "Manual edit");
  await expect(store.getAgentSnapshot("support")).rejects.toMatchObject({ code: "file_transaction_conflict" });
  reconcileProjectAgentFiles(dir);
  const reconciled = (await store.getAgentSnapshot("support"))!;
  expect(reconciled.agent.systemPrompt).toBe("Manual edit");
  expect(reconciled.revision.incarnation).not.toBe(old.revision.incarnation);
  // Even unchanged content cannot prove that an offline delete/recreate did
  // not happen: explicit reconciliation never preserves old authorization.
  reconcileProjectAgentFiles(dir);
  expect((await store.getAgentSnapshot("support"))!.revision.incarnation).not.toBe(reconciled.revision.incarnation);
});
