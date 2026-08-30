import { describe, expect, it } from "vitest";
import {
  assertTextEmbeddingResult,
  cosineSimilarity,
  fuseHybridRankings,
  normalizeHybridRetrievalPolicy,
  normalizeTextEmbeddingIdentity,
  textEmbeddingIdentitiesEqual,
  runSemanticRetrievalEval,
} from "./semantic-retrieval.js";

const identity = {
  provider: "test",
  model: "embed-v1",
  dimensions: 3,
  revision: "2026-08-30",
};

describe("semantic retrieval contracts", () => {
  it("normalizes immutable embedding identity and compares every compatibility field", () => {
    const normalized = normalizeTextEmbeddingIdentity(identity);
    expect(normalized).toEqual(identity);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(textEmbeddingIdentitiesEqual(normalized, identity)).toBe(true);
    expect(textEmbeddingIdentitiesEqual(normalized, {
      ...identity,
      revision: "next",
    })).toBe(false);
    expect(textEmbeddingIdentitiesEqual(normalized, {
      ...identity,
      dimensions: 2,
    })).toBe(false);
  });

  it.each([
    [{ ...identity, dimensions: 0 }, "dimensions"],
    [{ ...identity, provider: "" }, "provider"],
    [{ ...identity, model: " " }, "model"],
    [{ ...identity, revision: "" }, "revision"],
  ])("rejects invalid embedding identity %#", (value, field) => {
    expect(() => normalizeTextEmbeddingIdentity(value)).toThrow(field);
  });

  it("validates vector count, dimensions, finite values, and identity", () => {
    const result = assertTextEmbeddingResult({
      vectors: [[1, 0, 0], [0, 1, 0]],
      identity,
      usage: { tokens: 4 },
    }, {
      expectedCount: 2,
      expectedIdentity: identity,
    });
    expect(result.vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(Object.isFrozen(result.vectors[0])).toBe(true);

    expect(() => assertTextEmbeddingResult({
      vectors: [[1, 0, 0]], identity,
    }, { expectedCount: 2, expectedIdentity: identity })).toThrow("count");
    expect(() => assertTextEmbeddingResult({
      vectors: [[1, 0]], identity,
    }, { expectedCount: 1, expectedIdentity: identity })).toThrow("dimensions");
    expect(() => assertTextEmbeddingResult({
      vectors: [[1, Number.NaN, 0]], identity,
    }, { expectedCount: 1, expectedIdentity: identity })).toThrow("finite");
    expect(() => assertTextEmbeddingResult({
      vectors: [[1, 0, 0]], identity: { ...identity, revision: "other" },
    }, { expectedCount: 1, expectedIdentity: identity })).toThrow("identity");
  });

  it("calculates bounded cosine similarity without accepting malformed vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
    expect(cosineSimilarity([Number.POSITIVE_INFINITY], [1])).toBe(0);
  });

  it("fuses independent rankings with RRF instead of adding incomparable scores", () => {
    const fused = fuseHybridRankings({
      lexical: [
        { id: "exact", score: 100 },
        { id: "both", score: 1 },
      ],
      semantic: [
        { id: "paraphrase", score: 0.99 },
        { id: "both", score: 0.9 },
      ],
      rrfConstant: 60,
    });

    expect(fused.map((result) => result.id)).toEqual([
      "both",
      "exact",
      "paraphrase",
    ]);
    expect(fused[0]).toMatchObject({
      ranks: { lexical: 2, semantic: 2 },
      scores: { lexical: 1, semantic: 0.9 },
      mode: "hybrid",
    });
    expect(fused[1]?.score).not.toBe(100 + 0);
  });

  it("deduplicates candidates, uses strongest duplicate score, and orders ties by id", () => {
    const fused = fuseHybridRankings({
      lexical: [
        { id: "z", score: 1 },
        { id: "a", score: 1 },
        { id: "a", score: 4 },
      ],
      semantic: [],
    });
    expect(fused.map((result) => result.id)).toEqual(["a", "z"]);
    expect(fused[0]?.scores.lexical).toBe(4);
    expect(fused.every((result) => result.mode === "lexical")).toBe(true);
  });

  it("rejects invalid ranker policy instead of producing unstable output", () => {
    expect(() => fuseHybridRankings({
      lexical: [],
      semantic: [],
      rrfConstant: 0,
    })).toThrow("rrfConstant");
    expect(() => fuseHybridRankings({
      lexical: [{ id: "a", score: Number.NaN }],
      semantic: [],
    })).toThrow("score");
  });

  it("normalizes bounded hybrid policy and rejects impossible rerank limits", () => {
    expect(normalizeHybridRetrievalPolicy()).toEqual({
      candidateLimit: 80,
      resultLimit: 20,
      rrfConstant: 60,
      rerankLimit: 0,
      timeoutMs: 1_500,
      failureMode: "fallback",
    });
    expect(() => normalizeHybridRetrievalPolicy({
      candidateLimit: 2,
      rerankLimit: 3,
    })).toThrow("rerankLimit");
  });

  it("produces machine-readable eval metrics without source content", async () => {
    const report = await runSemanticRetrievalEval([
      { id: "paraphrase", query: "money back", relevantIds: ["refund"] },
      { id: "missing", query: "shipping", relevantIds: ["delivery"] },
    ], async ({ id }) => id === "paraphrase" ? ["refund"] : ["other"]);
    expect(report).toMatchObject({
      cases: 2,
      hits: 1,
      recallAtK: 0.5,
      missedCaseIds: ["missing"],
    });
  });
});
