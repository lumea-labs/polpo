import { describe, expect, it } from "vitest";
import {
  BrainIngestionError,
  InMemoryBrainStore,
  PlainTextBrainParser,
  createBrainSource,
  createBrainSourceVersion,
  ingestBrainSource,
  readBrainSource,
  type BrainAccessPolicy,
  type BrainActorContext,
  type BrainScope,
} from "../brain/index.js";

const projectA = { kind: "project", subjectId: "project-a" } as const;
const projectB = { kind: "project", subjectId: "project-b" } as const;
const actor: BrainActorContext = {
  actor: "agent",
  actorId: "support",
  agentName: "support",
  projectId: "project-a",
};

const allow: BrainAccessPolicy = {
  authorize: async () => ({ allowed: true, reason: "test" }),
};

async function seed(
  store: InMemoryBrainStore,
  input: {
    scope?: BrainScope;
    sourceId?: string;
    version?: string;
    content?: string;
  } = {},
) {
  const scope = input.scope ?? projectA;
  const sourceId = input.sourceId ?? "source-1";
  const version = input.version ?? "v1";
  await store.createSource(createBrainSource({
    id: sourceId,
    scope,
    type: "paste",
    label: "Runbook",
    trust: "user_provided",
  }, { now: () => "2026-07-28T12:00:00.000Z" }));
  await store.createVersion(scope, createBrainSourceVersion({
    sourceId,
    version,
  }, { now: () => "2026-07-28T12:00:00.000Z" }));
  await ingestBrainSource({
    ref: { scope, sourceId },
    version,
    body: {
      kind: "text",
      text: input.content ?? "Refunds are reviewed within five business days.",
    },
    contentType: "text/plain",
    actor,
  }, {
    sourceStore: store,
    versionStore: store,
    chunkStore: store,
    accessPolicy: allow,
    parsers: [new PlainTextBrainParser()],
    now: () => "2026-07-28T12:00:01.000Z",
    maxChunkCharacters: 24,
    overlapCharacters: 0,
  });
}

describe("readBrainSource", () => {
  it("reads the current indexed version with immutable citation-bearing chunks", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);

    const result = await readBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
    });

    expect(result.source.currentVersion).toBe("v1");
    expect(result.version.version).toBe("v1");
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].citation).toMatchObject({
      sourceId: "source-1",
      version: "v1",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.chunks)).toBe(true);
  });

  it("requires an exact scope when identical source ids exist", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, { scope: projectA, content: "Project A secret." });
    await seed(store, { scope: projectB, content: "Project B secret." });

    const result = await readBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
    });

    expect(result.chunks.map((chunk) => chunk.content).join(" ")).toContain(
      "Project A",
    );
    expect(result.chunks.map((chunk) => chunk.content).join(" ")).not.toContain(
      "Project B",
    );
  });

  it("fails closed when access is denied or the policy throws", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    const policies: BrainAccessPolicy[] = [
      { authorize: async () => ({ allowed: false, reason: "denied" }) },
      { authorize: async () => { throw new Error("policy unavailable"); } },
    ];

    for (const accessPolicy of policies) {
      await expect(readBrainSource({
        ref: { scope: projectA, sourceId: "source-1" },
        actor,
      }, {
        sourceStore: store,
        versionStore: store,
        chunkStore: store,
        accessPolicy,
      })).rejects.toMatchObject({
        code: "access_denied",
      });
    }
  });

  it("supports an explicit prior version without changing the visible version", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, { version: "v1", content: "Original policy." });
    await store.createVersion(projectA, createBrainSourceVersion({
      sourceId: "source-1",
      version: "v2",
    }, { now: () => "2026-07-28T12:01:00.000Z" }));
    await ingestBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      version: "v2",
      body: { kind: "text", text: "Updated policy." },
      contentType: "text/plain",
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
      parsers: [new PlainTextBrainParser()],
      now: () => "2026-07-28T12:01:01.000Z",
    });

    const prior = await readBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      version: "v1",
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
    });

    expect(prior.version.version).toBe("v1");
    expect(prior.chunks.map((chunk) => chunk.content).join(" ")).toContain(
      "Original policy",
    );
    await expect(store.getSource({
      scope: projectA,
      sourceId: "source-1",
    })).resolves.toMatchObject({ currentVersion: "v2" });
  });

  it("applies offset, chunk limit, and token budget without partial chunks", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, {
      content: "alpha alpha alpha alpha beta beta beta beta gamma gamma gamma gamma",
    });

    const result = await readBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      actor,
      offset: 1,
      limit: 2,
      tokenBudget: 8,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
    });

    expect(result.chunks.length).toBeLessThanOrEqual(2);
    expect(result.nextOffset === undefined || result.nextOffset > 1).toBe(true);
  });

  it("does not return content deleted while authorization is in flight", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const policy: BrainAccessPolicy = {
      authorize: async () => {
        await waiting;
        return { allowed: true, reason: "test" };
      },
    };

    const pending = readBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: policy,
    });
    await store.deleteSource({ scope: projectA, sourceId: "source-1" });
    release();

    await expect(pending).rejects.toBeInstanceOf(BrainIngestionError);
    await expect(pending).rejects.toMatchObject({ code: "source_not_found" });
  });
});
