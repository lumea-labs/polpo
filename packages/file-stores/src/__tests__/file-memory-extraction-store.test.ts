import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryExtractionCandidate,
  type MemoryExtractionStoreContext,
} from "@polpo-ai/core/memory";
import {
  FileMemoryExtractionStore,
} from "../file-memory-extraction-store.js";
import { MemoryStoreCorruptionError } from "../file-memory-item-store.js";

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "polpo-memory-candidates-"));
  directories.push(value);
  return value;
}

function context(): MemoryExtractionStoreContext {
  return {
    namespace: "project-1",
    access: { projectId: "project-1", agentName: "assistant", externalUserId: "user-1" },
  };
}

function candidate() {
  return createMemoryExtractionCandidate({
    idempotencyKey: "turn-1:extractor-v1:policy-v1:0",
    scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
    kind: "preference",
    content: "The user prefers concise answers.",
    source: { turnId: "turn-1", messageIds: ["message-user-1"] },
  }, {
    createId: () => "candidate-1",
    now: () => "2020-08-30T10:00:00.000Z",
  });
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("FileMemoryExtractionStore", () => {
  it("persists candidates, decisions, and audit across process restarts", async () => {
    const root = directory();
    const first = new FileMemoryExtractionStore(root);
    await first.propose(candidate(), context());
    await first.decide("candidate-1", {
      decision: "approve",
      decidedBy: { actor: "user", actorId: "reviewer-1" },
      expectedRevision: 1,
    }, context());
    await first.close();

    const second = new FileMemoryExtractionStore(root);
    await expect(second.get("candidate-1", context())).resolves.toMatchObject({
      status: "approved",
      revision: 2,
    });
    await expect(second.listAudit("candidate-1", context())).resolves.toEqual([
      expect.objectContaining({ type: "proposed" }),
      expect.objectContaining({
        type: "approved",
        reviewer: expect.objectContaining({ actorId: "reviewer-1" }),
      }),
    ]);
    expect(JSON.parse(readFileSync(join(root, "memory-candidates.json"), "utf8")))
      .toMatchObject({ version: 1 });
  });

  it("serializes concurrent mutations without losing a candidate", async () => {
    const store = new FileMemoryExtractionStore(directory());
    const second = createMemoryExtractionCandidate({
      idempotencyKey: "turn-2:extractor-v1:policy-v1:0",
      scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
      kind: "fact",
      content: "The user works in Rome.",
      source: { turnId: "turn-2" },
    }, { createId: () => "candidate-2" });

    await Promise.all([
      store.propose(candidate(), context()),
      store.propose(second, context()),
    ]);
    await expect(store.list({}, context())).resolves.toHaveLength(2);
  });

  it("fails closed and does not overwrite a corrupt snapshot", async () => {
    const root = directory();
    const path = join(root, "broken.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "not-json"));
    const store = new FileMemoryExtractionStore(root, { fileName: "broken.json" });

    await expect(store.list({}, context())).rejects.toBeInstanceOf(MemoryStoreCorruptionError);
    expect(readFileSync(path, "utf8")).toBe("not-json");
  });
});
