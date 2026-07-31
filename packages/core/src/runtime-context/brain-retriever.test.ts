import { describe, expect, it, vi } from "vitest";
import type {
  BrainReadService,
  BrainRetrievalResult,
  BrainServiceContext,
} from "../brain/index.js";
import { createBrainRuntimeContextRetriever } from "./brain-retriever.js";

const context: BrainServiceContext = {
  actor: {
    actor: "agent",
    actorId: "support",
    orgId: "org-a",
    projectId: "project-a",
    agentName: "support",
  },
  readScopes: [{ kind: "project", subjectId: "project-a" }],
  writeScopes: [],
};

function result(
  overrides: Partial<BrainRetrievalResult> = {},
): BrainRetrievalResult {
  return {
    scope: { kind: "project", subjectId: "project-a" },
    chunk: {
      id: "chunk-a",
      sourceId: "handbook",
      version: "v3",
      index: 2,
      content: "Refunds require manager approval.",
      citation: {
        sourceId: "handbook",
        version: "v3",
        chunkId: "chunk-a",
        label: "Support handbook",
        uri: "https://docs.example.com/support",
        locator: "Refund policy",
        capturedAt: "2026-07-30T09:00:00.000Z",
      },
      tokenCount: 8,
      metadata: {},
    },
    score: 0.91,
    scores: { keyword: 0.91 },
    trust: "trusted",
    ...overrides,
  };
}

function input(signal?: AbortSignal) {
  return {
    agentName: "support",
    query: "What is the refund policy?",
    surface: "agent" as const,
    source: "request" as const,
    tokenBudget: 700,
    runId: "run-a",
    sessionId: "session-a",
    requestId: "request-a",
    ...(signal ? { signal } : {}),
  };
}

describe("createBrainRuntimeContextRetriever", () => {
  it("maps ACL-filtered Brain results into cited runtime entries", async () => {
    const search = vi.fn(async () => [result()]);
    const service = { search } as unknown as BrainReadService;
    const resolveContext = vi.fn(async () => context);
    const retrieve = createBrainRuntimeContextRetriever({
      service,
      resolveContext,
      maxResults: 12,
    });

    await expect(retrieve(input())).resolves.toEqual({
      segments: [{
        kind: "brain",
        entries: [{
          id: "chunk-a",
          content: "Refunds require manager approval.",
          source: {
            type: "brain",
            id: "handbook",
            label: "Support handbook",
            reference: "https://docs.example.com/support",
          },
          timestamp: "2026-07-30T09:00:00.000Z",
          version: "v3",
          trust: "trusted",
          citation: {
            handle: "handbook@v3#chunk-a",
            sourceId: "handbook",
            version: "v3",
            uri: "https://docs.example.com/support",
            label: "Support handbook",
          },
          score: 0.91,
          estimatedTokens: 8,
        }],
      }],
    });
    expect(resolveContext).toHaveBeenCalledWith(input());
    expect(search).toHaveBeenCalledWith(context, {
      query: "What is the refund policy?",
      limit: 12,
      tokenBudget: 700,
    });
  });

  it("uses a controlled timestamp and locator when optional citation fields are absent", async () => {
    const value = result({
      chunk: {
        ...result().chunk,
        citation: {
          sourceId: "handbook",
          version: "v3",
          chunkId: "chunk-a",
          label: "Support handbook",
          locator: "Page 7",
        },
        tokenCount: undefined,
      },
    });
    const retrieve = createBrainRuntimeContextRetriever({
      service: {
        search: vi.fn(async () => [value]),
      } as unknown as BrainReadService,
      resolveContext: () => context,
      now: () => "2026-07-31T10:00:00.000Z",
    });

    const response = await retrieve(input());
    expect(response.segments[0]?.entries[0]).toMatchObject({
      source: { reference: "Page 7" },
      timestamp: "2026-07-31T10:00:00.000Z",
    });
    expect(response.segments[0]?.entries[0]?.citation).not.toHaveProperty("uri");
    expect(response.segments[0]?.entries[0]).not.toHaveProperty(
      "estimatedTokens",
    );
  });

  it("returns no Brain segment when retrieval has no authorized result", async () => {
    const retrieve = createBrainRuntimeContextRetriever({
      service: {
        search: vi.fn(async () => []),
      } as unknown as BrainReadService,
      resolveContext: () => context,
    });

    await expect(retrieve(input())).resolves.toEqual({ segments: [] });
  });

  it("honors aborts before and after the service boundary", async () => {
    const before = new AbortController();
    before.abort();
    const searchBefore = vi.fn();
    const retrieveBefore = createBrainRuntimeContextRetriever({
      service: { search: searchBefore } as unknown as BrainReadService,
      resolveContext: () => context,
    });
    await expect(retrieveBefore(input(before.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(searchBefore).not.toHaveBeenCalled();

    const after = new AbortController();
    const retrieveAfter = createBrainRuntimeContextRetriever({
      service: {
        search: vi.fn(async () => {
          after.abort();
          return [result()];
        }),
      } as unknown as BrainReadService,
      resolveContext: () => context,
    });
    await expect(retrieveAfter(input(after.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
