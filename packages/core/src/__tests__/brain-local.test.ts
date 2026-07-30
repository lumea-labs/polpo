import { describe, expect, it, vi } from "vitest";
import {
  BrainStoreConflictError,
  BrainStoreValidationError,
  InMemoryBrainStore,
  PlainTextBrainParser,
  chunkBrainSections,
  createBrainIngestionJob,
  createBrainSource,
  createBrainSourceVersion,
  ingestBrainSource,
  retrieveBrain,
  type BrainAccessPolicy,
  type BrainActorContext,
  type BrainEmbeddingProvider,
  type BrainReranker,
  type BrainScope,
} from "../brain/index.js";

const projectA = { kind: "project", subjectId: "project-a" } as const;
const projectB = { kind: "project", subjectId: "project-b" } as const;
const at = "2026-07-28T12:00:00.000Z";
const actor: BrainActorContext = {
  actor: "agent",
  actorId: "support",
  agentName: "support",
  projectId: "project-a",
};
const allow: BrainAccessPolicy = {
  authorize: async () => ({ allowed: true, reason: "test" }),
};

function source(
  id: string,
  scope: BrainScope = projectA,
  label = "Support guide",
) {
  return createBrainSource({
    id,
    scope,
    type: "paste",
    label,
    trust: "user_provided",
  }, { now: () => at });
}

function version(sourceId: string, name: string) {
  return createBrainSourceVersion({
    sourceId,
    version: name,
  }, { now: () => at });
}

async function seed(
  store: InMemoryBrainStore,
  input: {
    sourceId?: string;
    scope?: BrainScope;
    version?: string;
    content?: string;
    label?: string;
  } = {},
) {
  const sourceId = input.sourceId ?? "source-1";
  const scope = input.scope ?? projectA;
  const versionName = input.version ?? "v1";
  await store.createSource(source(sourceId, scope, input.label));
  await store.createVersion(scope, version(sourceId, versionName));
  return ingestBrainSource({
    ref: { scope, sourceId },
    version: versionName,
    body: {
      kind: "text",
      text: input.content ?? "Billing refunds are processed within five days.",
    },
    contentType: "text/plain",
    actor,
  }, {
    sourceStore: store,
    versionStore: store,
    chunkStore: store,
    accessPolicy: allow,
    parsers: [new PlainTextBrainParser()],
    now: () => at,
  });
}

describe("InMemoryBrainStore", () => {
  it("isolates identical source ids by explicit scope", async () => {
    const store = new InMemoryBrainStore();
    await store.createSource(source("same", projectA, "A"));
    await store.createSource(source("same", projectB, "B"));

    await expect(store.getSource({ scope: projectA, sourceId: "same" }))
      .resolves.toMatchObject({ label: "A" });
    await expect(store.getSource({ scope: projectB, sourceId: "same" }))
      .resolves.toMatchObject({ label: "B" });
    await expect(store.getSource({
      scope: { kind: "project", subjectId: "project-c" },
      sourceId: "same",
    })).resolves.toBeNull();
  });

  it("rejects unscoped list and candidate searches", async () => {
    const store = new InMemoryBrainStore();
    await expect(store.listSources({ scopes: [] })).rejects.toBeInstanceOf(
      BrainStoreValidationError,
    );
    await expect(store.searchCandidates({
      sources: [{
        scope: { kind: "project", subjectId: "" },
        sourceId: "source-1",
      }],
      query: "billing",
      limit: 5,
    })).rejects.toBeInstanceOf(BrainStoreValidationError);
    await expect(store.searchCandidates({
      sources: [],
      query: "billing",
      limit: 5,
    })).resolves.toEqual([]);
  });

  it("rejects duplicate sources only inside the same scope", async () => {
    const store = new InMemoryBrainStore();
    await store.createSource(source("source-1"));
    await expect(store.createSource(source("source-1"))).rejects.toBeInstanceOf(
      BrainStoreConflictError,
    );
    await expect(store.createSource(source("source-1", projectB))).resolves
      .toMatchObject({ scope: projectB });
  });

  it("atomically rejects malformed chunk replacements", async () => {
    const store = new InMemoryBrainStore();
    await store.createSource(source("source-1"));
    await store.createVersion(projectA, version("source-1", "v1"));
    const valid = chunkBrainSections({
      source: source("source-1"),
      version: "v1",
      sections: [{ content: "First valid chunk." }],
      createId: () => "chunk-1",
    });
    await store.replaceVersionChunks({
      scope: projectA,
      sourceId: "source-1",
      version: "v1",
      chunks: valid,
    });

    await expect(store.replaceVersionChunks({
      scope: projectA,
      sourceId: "source-1",
      version: "v1",
      chunks: [
        valid[0],
        { ...valid[0], id: "chunk-2", index: 0 },
      ],
    })).rejects.toBeInstanceOf(BrainStoreValidationError);
    await expect(store.listVersionChunks({
      scope: projectA,
      sourceId: "source-1",
      version: "v1",
    })).resolves.toEqual(valid);
  });

  it("publishes an indexed version and preserves citations in keyword results", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);

    const stored = await store.getSource({ scope: projectA, sourceId: "source-1" });
    expect(stored).toMatchObject({
      status: "indexed",
      currentVersion: "v1",
    });
    const results = await store.searchCandidates({
      sources: [{ scope: projectA, sourceId: "source-1" }],
      query: "billing refunds",
      limit: 5,
    });
    expect(results).toHaveLength(1);
    expect(results[0].chunk.citation).toMatchObject({
      sourceId: "source-1",
      version: "v1",
      chunkId: results[0].chunk.id,
    });
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("keeps the previous indexed version visible when reindex parsing fails", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, { content: "Stable billing policy." });
    await store.createVersion(projectA, version("source-1", "v2"));

    await expect(ingestBrainSource({
      ref: { scope: projectA, sourceId: "source-1" },
      version: "v2",
      body: { kind: "text", text: "new content" },
      contentType: "application/x-broken",
      actor,
    }, {
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      accessPolicy: allow,
      parsers: [new PlainTextBrainParser()],
      now: () => "2026-07-28T12:01:00.000Z",
    })).rejects.toThrow(/parser/i);

    await expect(store.getSource({
      scope: projectA,
      sourceId: "source-1",
    })).resolves.toMatchObject({
      status: "indexed",
      currentVersion: "v1",
    });
    await expect(store.getVersion({
      scope: projectA,
      sourceId: "source-1",
      version: "v2",
    })).resolves.toMatchObject({ status: "failed" });
    const results = await store.searchCandidates({
      sources: [{ scope: projectA, sourceId: "source-1" }],
      query: "stable billing",
      limit: 5,
    });
    expect(results.map((result) => result.chunk.version)).toEqual(["v1"]);
  });

  it("makes deletion immediately invisible to retrieval", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    await store.deleteSource({ scope: projectA, sourceId: "source-1" });

    await expect(store.searchCandidates({
      sources: [{ scope: projectA, sourceId: "source-1" }],
      query: "billing",
      limit: 5,
    })).resolves.toEqual([]);
  });

  it("exports and restores an immutable validated snapshot", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    const snapshot = store.snapshot();
    const restored = new InMemoryBrainStore({ snapshot });
    const first = await restored.searchCandidates({
      sources: [{ scope: projectA, sourceId: "source-1" }],
      query: "billing",
      limit: 5,
    });

    expect(first).toHaveLength(1);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => new InMemoryBrainStore({
      snapshot: {
        ...snapshot,
        version: 999 as 1,
      },
    })).toThrow(BrainStoreValidationError);
  });

  it("restores versions with identical source ids into their exact scopes", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, {
      sourceId: "shared",
      scope: projectA,
      content: "Project A billing policy.",
    });
    await seed(store, {
      sourceId: "shared",
      scope: projectB,
      content: "Project B retention policy.",
    });

    const restored = new InMemoryBrainStore({ snapshot: store.snapshot() });
    await expect(restored.searchCandidates({
      sources: [{ scope: projectA, sourceId: "shared" }],
      query: "billing",
      limit: 5,
    })).resolves.toHaveLength(1);
    await expect(restored.searchCandidates({
      sources: [{ scope: projectA, sourceId: "shared" }],
      query: "retention",
      limit: 5,
    })).resolves.toEqual([]);
    await expect(restored.searchCandidates({
      sources: [{ scope: projectB, sourceId: "shared" }],
      query: "retention",
      limit: 5,
    })).resolves.toHaveLength(1);
  });
});

describe("Brain ingestion jobs", () => {
  function job(id = "job-1", dedupeKey = "source-1:v1") {
    return createBrainIngestionJob({
      id,
      scope: projectA,
      sourceId: "source-1",
      version: "v1",
      operation: "ingest",
      dedupeKey,
      maxAttempts: 2,
    }, { now: () => at });
  }

  it("deduplicates enqueue delivery by scope and dedupe key", async () => {
    const store = new InMemoryBrainStore();
    await expect(store.enqueueJob(job())).resolves.toMatchObject({ created: true });
    await expect(store.enqueueJob(job("job-duplicate"))).resolves.toMatchObject({
      created: false,
      job: { id: "job-1" },
    });
    await expect(store.enqueueJob(createBrainIngestionJob({
      ...job("job-b"),
      scope: projectB,
    }))).resolves.toMatchObject({ created: true });
  });

  it("claims a job once and rejects stale claim tokens", async () => {
    let id = 0;
    const store = new InMemoryBrainStore({
      createId: () => `claim-${++id}`,
    });
    await store.enqueueJob(job());
    const claimInput = {
      scope: projectA,
      workerId: "worker-1",
      now: at,
      leaseMs: 60_000,
    };
    const [first, second] = await Promise.all([
      store.claimNextJob(claimInput),
      store.claimNextJob(claimInput),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const claimed = first ?? second!;
    expect(claimed).toMatchObject({
      status: "processing",
      attempt: 1,
      claimedBy: "worker-1",
    });

    await expect(store.completeJob({
      scope: projectA,
      jobId: claimed.id,
      claimToken: "stale",
      now: "2026-07-28T12:00:30.000Z",
    })).rejects.toBeInstanceOf(BrainStoreConflictError);
    await expect(store.completeJob({
      scope: projectA,
      jobId: claimed.id,
      claimToken: claimed.claimToken!,
      now: "2026-07-28T12:00:30.000Z",
    })).resolves.toMatchObject({ status: "completed" });
  });

  it("requeues retryable failures and terminally fails after max attempts", async () => {
    let id = 0;
    const store = new InMemoryBrainStore({
      createId: () => `claim-${++id}`,
    });
    await store.enqueueJob(job());
    const first = await store.claimNextJob({
      scope: projectA,
      workerId: "worker",
      now: at,
      leaseMs: 1_000,
    });
    const pending = await store.failJob({
      scope: projectA,
      jobId: first!.id,
      claimToken: first!.claimToken!,
      now: "2026-07-28T12:00:00.500Z",
      retryAt: "2026-07-28T12:01:00.000Z",
      failure: { code: "timeout", message: "Timed out", retryable: true },
    });
    expect(pending).toMatchObject({ status: "pending", attempt: 1 });
    expect(await store.claimNextJob({
      scope: projectA,
      workerId: "worker",
      now: "2026-07-28T12:00:59.999Z",
      leaseMs: 1_000,
    })).toBeNull();

    const second = await store.claimNextJob({
      scope: projectA,
      workerId: "worker",
      now: "2026-07-28T12:01:00.000Z",
      leaseMs: 1_000,
    });
    const failed = await store.failJob({
      scope: projectA,
      jobId: second!.id,
      claimToken: second!.claimToken!,
      now: "2026-07-28T12:01:00.500Z",
      failure: { code: "timeout", message: "Timed out", retryable: true },
    });
    expect(failed).toMatchObject({ status: "failed", attempt: 2 });
  });

  it("terminally fails an expired final lease instead of orphaning the job", async () => {
    const store = new InMemoryBrainStore({ createId: () => "claim-final" });
    await store.enqueueJob(createBrainIngestionJob({
      ...job(),
      maxAttempts: 1,
    }));
    const claimed = await store.claimNextJob({
      scope: projectA,
      workerId: "worker",
      now: at,
      leaseMs: 1_000,
    });
    expect(claimed).toMatchObject({ status: "processing", attempt: 1 });

    await expect(store.claimNextJob({
      scope: projectA,
      workerId: "other-worker",
      now: "2026-07-28T12:00:01.001Z",
      leaseMs: 1_000,
    })).resolves.toBeNull();
    await expect(store.getJob({
      scope: projectA,
      jobId: claimed!.id,
    })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "lease_exhausted", retryable: false },
    });
  });
});

describe("Brain ingestion and retrieval", () => {
  it("chunks deterministically with bounded overlap and stable citations", () => {
    let id = 0;
    const chunks = chunkBrainSections({
      source: source("source-1"),
      version: "v1",
      sections: [{
        locator: "chapter 1",
        content: "Sentence one. ".repeat(400),
      }],
      maxCharacters: 240,
      overlapCharacters: 40,
      createId: () => `chunk-${++id}`,
    });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk, index) => (
      chunk.index === index
      && chunk.content.length <= 240
      && chunk.citation.chunkId === chunk.id
      && chunk.citation.locator?.startsWith("chapter 1")
    ))).toBe(true);
    expect(() => chunkBrainSections({
      source: source("source-1"),
      version: "v1",
      sections: [{ content: "text" }],
      maxCharacters: 100,
      overlapCharacters: 100,
    })).toThrow(BrainStoreValidationError);
  });

  it("authorizes every source before candidate ranking", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, { sourceId: "allowed", content: "Allowed billing guide." });
    await seed(store, { sourceId: "denied", content: "Denied secret billing guide." });
    const search = vi.spyOn(store, "searchCandidates");
    const policy: BrainAccessPolicy = {
      authorize: async ({ source }) => ({
        allowed: source.id === "allowed",
        reason: source.id === "allowed" ? "grant" : "deny",
      }),
    };

    const results = await retrieveBrain({
      query: "billing guide",
      scopes: [projectA],
      actor,
      limit: 10,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: policy,
    });

    expect(results.map((result) => result.chunk.sourceId)).toEqual(["allowed"]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      sources: [{ scope: projectA, sourceId: "allowed" }],
    }));
  });

  it("never sends a same-id source from a denied scope to the reranker", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, {
      sourceId: "shared",
      scope: projectA,
      content: "Allowed billing guide.",
    });
    await seed(store, {
      sourceId: "shared",
      scope: projectB,
      content: "Denied billing secret.",
    });
    let reranked: readonly { readonly scope: BrainScope }[] = [];
    const reranker: BrainReranker = {
      rerank: async ({ results }) => {
        reranked = results;
        return results;
      },
    };
    const policy: BrainAccessPolicy = {
      authorize: async ({ source }) => ({
        allowed: source.scope.subjectId === projectA.subjectId,
        reason: "scope grant",
      }),
    };

    const results = await retrieveBrain({
      query: "billing",
      scopes: [projectA, projectB],
      actor,
      limit: 5,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: policy,
      reranker,
    });

    expect(reranked).toHaveLength(1);
    expect(reranked[0].scope).toEqual(projectA);
    expect(results).toHaveLength(1);
    expect(results[0].scope).toEqual(projectA);
  });

  it("fails closed when access policy throws or returns malformed data", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);

    for (const authorize of [
      async () => {
        throw new Error("policy offline");
      },
      async () => ({ allowed: "yes" }) as never,
    ]) {
      await expect(retrieveBrain({
        query: "billing",
        scopes: [projectA],
        actor,
        limit: 5,
        tokenBudget: 1_000,
      }, {
        sourceStore: store,
        chunkStore: store,
        accessPolicy: { authorize },
      })).resolves.toEqual([]);
    }
  });

  it("rechecks authorization after ranking before returning content", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    let calls = 0;
    const policy: BrainAccessPolicy = {
      authorize: async () => ({
        allowed: ++calls === 1,
        reason: calls === 1 ? "initial grant" : "revoked",
      }),
    };

    await expect(retrieveBrain({
      query: "billing",
      scopes: [projectA],
      actor,
      limit: 5,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: policy,
    })).resolves.toEqual([]);
  });

  it("drops sources deleted while a reranker is running", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    const reranker: BrainReranker = {
      rerank: async ({ results }) => {
        await store.deleteSource({ scope: projectA, sourceId: "source-1" });
        return results;
      },
    };

    await expect(retrieveBrain({
      query: "billing",
      scopes: [projectA],
      actor,
      limit: 5,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: allow,
      reranker,
    })).resolves.toEqual([]);
  });

  it("falls back to lexical order when embedding or reranking fails", async () => {
    const embedder: BrainEmbeddingProvider = {
      embed: async () => {
        throw new Error("embedding offline");
      },
    };
    const store = new InMemoryBrainStore({ embeddingProvider: embedder });
    await seed(store, {
      sourceId: "b",
      content: "Billing guide alpha.",
      label: "B",
    });
    await seed(store, {
      sourceId: "a",
      content: "Billing guide alpha.",
      label: "A",
    });
    const reranker: BrainReranker = {
      rerank: async () => {
        throw new Error("reranker offline");
      },
    };

    const results = await retrieveBrain({
      query: "billing guide",
      scopes: [projectA],
      actor,
      limit: 10,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: allow,
      reranker,
      failureMode: "fallback",
    });

    expect(results.map((result) => result.chunk.sourceId)).toEqual(["a", "b"]);
  });

  it("rejects a reranker that drops citation identity in strict mode", async () => {
    const store = new InMemoryBrainStore();
    await seed(store);
    const reranker: BrainReranker = {
      rerank: async ({ results }) => [{
        ...results[0],
        chunk: {
          ...results[0].chunk,
          citation: {
            ...results[0].chunk.citation,
            sourceId: "other-source",
          },
        },
      }],
    };

    await expect(retrieveBrain({
      query: "billing",
      scopes: [projectA],
      actor,
      limit: 5,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: allow,
      reranker,
      failureMode: "strict",
    })).rejects.toThrow(/reranker/i);
  });

  it("enforces the final token budget and returns no segment for empty input", async () => {
    const store = new InMemoryBrainStore();
    await seed(store, {
      content: "billing ".repeat(800),
    });
    await expect(retrieveBrain({
      query: "billing",
      scopes: [projectA],
      actor,
      limit: 10,
      tokenBudget: 0,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: allow,
    })).resolves.toEqual([]);
    await expect(retrieveBrain({
      query: " ",
      scopes: [projectA],
      actor,
      limit: 10,
      tokenBudget: 1_000,
    }, {
      sourceStore: store,
      chunkStore: store,
      accessPolicy: allow,
    })).resolves.toEqual([]);
  });
});
