import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAgentStore } from "@polpo-ai/file-stores";
import { pullProject } from "../src/util/pull.js";

const confirm = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({ confirm, isCancel: () => false }));
const directories: string[] = [];
afterEach(() => { confirm.mockReset(); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
async function fixture(legacy: boolean) {
  const root = mkdtempSync(join(tmpdir(), "polpo-pull-cas-"));
  directories.push(root);
  const dir = join(root, ".polpo");
  if (!legacy) mkdirSync(join(dir, "agents"), { recursive: true });
  const store = new FileAgentStore(dir);
  await store.createAgent({ name: "support", role: "Before", systemPrompt: "Before prompt" }, "default");
  const client = { async get(path: string) {
    return { status: 200, data: { data: path === "/v1/agents" ? [{ name: "support", role: "Remote", systemPrompt: "Remote prompt" }] : [] } };
  } };
  return { dir, store, client };
}
describe.each([false, true])("pull CAS, legacy=%s", legacy => {
  it("does not overwrite a runtime update made while the user answers the prompt", async () => {
    const { dir, store, client } = await fixture(legacy);
    confirm.mockImplementationOnce(async () => { await store.updateAgent("support", { role: "Concurrent" }); return true; });
    confirm.mockResolvedValue(true);
    const result = await pullProject(client as any, dir, { force: false, interactive: true });
    expect(result.errors).toContainEqual(expect.stringContaining("changed while awaiting the pull decision"));
    expect(result.pulled.some(label => label.startsWith("agent"))).toBe(false);
    expect(await store.getAgent("support")).toMatchObject({ role: "Concurrent", systemPrompt: "Before prompt" });
  });

  it("updates config and prompt together and invalidates the earlier revision", async () => {
    const { dir, store, client } = await fixture(legacy);
    const before = (await store.getAgentSnapshot("support"))!;
    const result = await pullProject(client as any, dir, { force: true, interactive: false });
    expect(result.errors).toEqual([]);
    const after = (await store.getAgentSnapshot("support"))!;
    expect(after.agent).toMatchObject({ role: "Remote", systemPrompt: "Remote prompt" });
    expect(after.revision.incarnation).toBe(before.revision.incarnation);
    expect(after.revision.version).toBe(before.revision.version + 1);
    await expect(store.compareAndSwapAgent("support", { expected: before.revision, mutationId: "stale", patch: {} }))
      .rejects.toMatchObject({ code: "agent_revision_conflict" });
  });
});
