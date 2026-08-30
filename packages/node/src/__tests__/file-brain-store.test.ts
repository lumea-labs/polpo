import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileBrainStore,
  FileBrainStoreCorruptionError,
} from "../brain/index.js";
import {
  PlainTextBrainParser,
  createBrainIngestionJob,
  createBrainSource,
  createBrainSourceVersion,
  ingestBrainSource,
} from "@polpo-ai/core/brain";

const scope = { kind: "project", subjectId: "project-a" } as const;
const actor = {
  actor: "agent" as const,
  actorId: "support",
  projectId: "project-a",
};
const allow = {
  authorize: async () => ({ allowed: true, reason: "test" }),
};

describe("FileBrainStore", () => {
  it("persists an indexed source and restores citation-preserving search", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-file-brain-"));
    const path = join(dir, "brain.json");
    const store = new FileBrainStore(path);
    await store.createSource(createBrainSource({
      id: "source-1",
      scope,
      type: "paste",
      label: "Guide",
      trust: "user_provided",
    }, { now: () => "2026-07-28T12:00:00.000Z" }));
    await store.createVersion(scope, createBrainSourceVersion({
      sourceId: "source-1",
      version: "v1",
    }, { now: () => "2026-07-28T12:00:00.000Z" }));
    await ingestBrainSource({
      ref: { scope, sourceId: "source-1" },
      version: "v1",
      body: { kind: "text", text: "Refunds take five days." },
      contentType: "text/plain",
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
      parsers: [new PlainTextBrainParser()],
      now: () => "2026-07-28T12:00:01.000Z",
    });

    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const restored = new FileBrainStore(path);
    await expect(restored.searchCandidates({
      sources: [{ scope, sourceId: "source-1" }],
      query: "refunds",
      limit: 5,
    })).resolves.toMatchObject([{
      chunk: {
        sourceId: "source-1",
        version: "v1",
        citation: {
          sourceId: "source-1",
          version: "v1",
        },
      },
    }]);
  });

  it("does not silently discard corrupted durable state", () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-file-brain-corrupt-"));
    const path = join(dir, "brain.json");
    writeFileSync(path, "{\"version\":1,\"sources\":[", "utf8");

    expect(() => new FileBrainStore(path)).toThrow(
      FileBrainStoreCorruptionError,
    );
    expect(readFileSync(path, "utf8")).toBe("{\"version\":1,\"sources\":[");
  });

  it("writes durable state with owner-only permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-file-brain-mode-"));
    const path = join(dir, "brain.json");
    const store = new FileBrainStore(path);
    await store.createSource(createBrainSource({
      id: "source-1",
      scope,
      type: "paste",
      label: "Guide",
      trust: "user_provided",
    }));

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("persists lease heartbeats so a restored worker cannot double-claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-file-brain-lease-"));
    const path = join(dir, "brain.json");
    const store = new FileBrainStore(path, { createId: () => "claim-1" });
    await store.enqueueJob(createBrainIngestionJob({
      id: "job-1",
      scope,
      sourceId: "source-1",
      version: "v1",
      operation: "ingest",
      dedupeKey: "source-1:v1",
    }, { now: () => "2026-08-30T08:00:00.000Z" }));
    const claimed = await store.claimNextJob({
      scope,
      workerId: "worker-1",
      now: "2026-08-30T08:00:00.000Z",
      leaseMs: 1_000,
    });
    await store.renewJobLease({
      scope,
      jobId: claimed!.id,
      claimToken: claimed!.claimToken!,
      now: "2026-08-30T08:00:00.900Z",
      leaseMs: 1_000,
    });

    const restored = new FileBrainStore(path);
    await expect(restored.claimNextJob({
      scope,
      workerId: "worker-2",
      now: "2026-08-30T08:00:01.100Z",
      leaseMs: 1_000,
    })).resolves.toBeNull();
    await expect(restored.getJob({ scope, jobId: "job-1" })).resolves.toMatchObject({
      status: "processing",
      claimedBy: "worker-1",
      leaseExpiresAt: "2026-08-30T08:00:01.900Z",
    });
  });
});
