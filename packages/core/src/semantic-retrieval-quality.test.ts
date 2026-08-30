import { describe, expect, it } from "vitest";
import {
  evaluateSemanticRetrievalQualityGate,
  rerankTextCandidates,
  runSemanticRetrievalEval,
  type SemanticRetrievalEvalCase,
  type TextReranker,
} from "./semantic-retrieval.js";

const cases: readonly SemanticRetrievalEvalCase[] = [
  {
    id: "exact",
    query: "invoice INV-2048",
    relevantIds: ["invoice-2048"],
    tags: ["exact_identifier"],
  },
  {
    id: "paraphrase",
    query: "get my money back",
    relevantIds: ["refund-policy", "refund-faq"],
    tags: ["paraphrase"],
  },
  {
    id: "abstain",
    query: "founder's favorite constellation",
    relevantIds: [],
    tags: ["abstention"],
  },
  {
    id: "isolation",
    query: "quarterly plan",
    relevantIds: ["public-plan"],
    forbiddenIds: ["other-tenant-plan"],
    tags: ["cross_scope"],
  },
];

describe("semantic retrieval quality evaluation", () => {
  it("computes ranking, exact-id, abstention, isolation, and latency metrics", async () => {
    const report = await runSemanticRetrievalEval(cases, async ({ id }) => {
      switch (id) {
        case "exact":
          return { resultIds: ["noise", "invoice-2048"], durationMs: 10 };
        case "paraphrase":
          return {
            resultIds: ["refund-policy", "noise", "refund-faq"],
            durationMs: 20,
          };
        case "abstain":
          return { resultIds: [], durationMs: 30 };
        default:
          return {
            resultIds: ["public-plan", "other-tenant-plan"],
            durationMs: 40,
          };
      }
    });

    expect(report).toMatchObject({
      cases: 4,
      retrievalCases: 3,
      hits: 3,
      recallAtK: 1,
      mrr: (0.5 + 1 + 1) / 3,
      abstentionCases: 1,
      abstentionFalsePositives: 0,
      forbiddenResultCount: 1,
      failedCaseIds: [],
      failureRate: 0,
      exactIdentifier: { cases: 1, hits: 1, recallAtK: 1 },
      latencyMs: { p50: 20, p95: 40, max: 40 },
    });
    expect(report.ndcgAtK).toBeCloseTo((
      (1 / Math.log2(3))
      + ((1 + (1 / Math.log2(4))) / (1 + (1 / Math.log2(3))))
      + 1
    ) / 3);
    expect(report.caseReports.find(({ id }) => id === "isolation"))
      .toMatchObject({ forbiddenResultIds: ["other-tenant-plan"] });
    expect(JSON.stringify(report)).not.toContain("quarterly plan");
  });

  it("preserves the simple retriever contract and old top-level metrics", async () => {
    const report = await runSemanticRetrievalEval([
      { id: "hit", query: "refund", relevantIds: ["refund"] },
      { id: "miss", query: "shipping", relevantIds: ["delivery"] },
    ], async ({ id }) => id === "hit" ? ["refund"] : ["other"]);

    expect(report).toMatchObject({
      cases: 2,
      hits: 1,
      recallAtK: 0.5,
      missedCaseIds: ["miss"],
    });
  });

  it("classifies retriever failures per case but never converts abort into a report", async () => {
    const report = await runSemanticRetrievalEval([
      { id: "failed", query: "refund", relevantIds: ["refund"] },
    ], async () => {
      throw new Error("provider leaked source content here");
    });
    expect(report).toMatchObject({
      failures: 1,
      failedCaseIds: ["failed"],
      failureRate: 1,
    });
    expect(JSON.stringify(report)).not.toContain("provider leaked");

    await expect(runSemanticRetrievalEval([
      { id: "aborted", query: "refund", relevantIds: ["refund"] },
    ], async () => {
      throw Object.assign(new Error("cancelled"), { name: "AbortError" });
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    [[
      { id: "duplicate", query: "a", relevantIds: ["one"] },
      { id: "duplicate", query: "b", relevantIds: ["two"] },
    ], "duplicate"],
    [[
      { id: "overlap", query: "a", relevantIds: ["same"], forbiddenIds: ["same"] },
    ], "both relevant and forbidden"],
    [[
      { id: "empty", query: "a", relevantIds: [] },
    ], "abstention"],
    [[
      { id: "bad-abstain", query: "a", relevantIds: ["one"], tags: ["abstention"] },
    ], "must not define relevant"],
  ])("rejects malformed case manifests %#", async (manifest, message) => {
    await expect(runSemanticRetrievalEval(
      manifest as readonly SemanticRetrievalEvalCase[],
      async () => [],
    )).rejects.toThrow(message);
  });

  it("rejects duplicate, unknown, over-limit, and non-canonical result identities", async () => {
    const oneCase = [{ id: "case", query: "q", relevantIds: ["one"] }] as const;
    await expect(runSemanticRetrievalEval(oneCase, async () => ["one", "one"]))
      .rejects.toThrow("duplicate");
    await expect(runSemanticRetrievalEval(
      [{ ...oneCase[0], limit: 1 }],
      async () => ["one", "two"],
    )).rejects.toThrow("limit");
    await expect(runSemanticRetrievalEval(oneCase, async () => ["e\u0301"]))
      .rejects.toThrow("Unicode-normalized");
    await expect(runSemanticRetrievalEval(oneCase, async () => ({
      resultIds: ["one"],
      fallbackReason: "provider returned its raw error",
    }))).rejects.toThrow("sanitized reason code");
  });
});

describe("semantic retrieval quality gates", () => {
  it("blocks exact-id regression and forbidden output despite aggregate uplift", async () => {
    const baseline = await runSemanticRetrievalEval(cases, async ({ id }) => ({
      resultIds: id === "abstain"
        ? []
        : id === "exact"
          ? ["invoice-2048"]
          : id === "paraphrase"
            ? ["noise"]
            : ["public-plan"],
      durationMs: 10,
    }));
    const candidate = await runSemanticRetrievalEval(cases, async ({ id }) => ({
      resultIds: id === "abstain"
        ? []
        : id === "exact"
          ? ["noise"]
          : id === "paraphrase"
            ? ["refund-policy"]
            : ["public-plan", "other-tenant-plan"],
      durationMs: 12,
    }));

    const gate = evaluateSemanticRetrievalQualityGate({
      baseline,
      candidate,
      policy: {
        minimumRecallAtK: 0.5,
        maximumRecallAtKRegression: 0,
        maximumExactIdentifierRecallRegression: 0,
        maximumForbiddenResults: 0,
      },
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "exact_identifier_regression",
      "forbidden_results",
    ]));
  });

  it("passes a non-regressing candidate and rejects invalid policy", async () => {
    const report = await runSemanticRetrievalEval(cases, async ({ id }) => ({
      resultIds: id === "abstain"
        ? []
        : id === "exact"
          ? ["invoice-2048"]
          : id === "paraphrase"
            ? ["refund-policy", "refund-faq"]
            : ["public-plan"],
      durationMs: 8,
    }));
    expect(evaluateSemanticRetrievalQualityGate({
      baseline: report,
      candidate: report,
      policy: {
        minimumRecallAtK: 1,
        minimumMrr: 1,
        minimumNdcgAtK: 1,
        maximumP95LatencyMs: 10,
      },
    })).toMatchObject({ passed: true, failures: [] });

    expect(() => evaluateSemanticRetrievalQualityGate({
      baseline: report,
      candidate: report,
      policy: { minimumMrr: 1.1 },
    })).toThrow("minimumMrr");
  });

  it("refuses to compare reports from different case manifests", async () => {
    const baseline = await runSemanticRetrievalEval([
      { id: "one", query: "one", relevantIds: ["one"] },
    ], async () => ["one"]);
    const candidate = await runSemanticRetrievalEval([
      { id: "two", query: "two", relevantIds: ["two"] },
    ], async () => ["two"]);
    expect(() => evaluateSemanticRetrievalQualityGate({ baseline, candidate }))
      .toThrow("same case manifest");
    const changedJudgement = await runSemanticRetrievalEval([
      { id: "one", query: "one", relevantIds: ["different"] },
    ], async () => ["different"]);
    expect(() => evaluateSemanticRetrievalQualityGate({
      baseline,
      candidate: changedJudgement,
    })).toThrow("same case manifest");
    expect(() => evaluateSemanticRetrievalQualityGate({
      baseline,
      candidate: { ...baseline, recallAtK: Number.NaN },
    })).toThrow("candidate.recallAtK");
  });
});

describe("shared text reranker", () => {
  const candidates = [
    { id: "a", text: "Alpha" },
    { id: "b", text: "Beta" },
    { id: "c", text: "Gamma" },
  ] as const;

  it("returns a bounded immutable ranking with usage", async () => {
    const reranker: TextReranker = {
      rerank: async () => ({
        ranking: [{ id: "b", score: 0.9 }, { id: "a", score: 0.8 }],
        usage: { tokens: 3 },
      }),
    };
    const outcome = await rerankTextCandidates({
      query: "beta first",
      candidates,
      limit: 2,
      failureMode: "strict",
    }, reranker);
    expect(outcome.ranking).toEqual([
      { candidate: candidates[1], score: 0.9 },
      { candidate: candidates[0], score: 0.8 },
    ]);
    expect(outcome.usage).toEqual({ tokens: 3 });
    expect(Object.isFrozen(outcome.ranking)).toBe(true);
  });

  it.each([
    [[{ id: "unknown", score: 1 }, { id: "a", score: 0 }], "unknown"],
    [[{ id: "a", score: 1 }, { id: "a", score: 0 }], "duplicate"],
    [[{ id: "a", score: Number.NaN }, { id: "b", score: 0 }], "finite"],
    [[{ id: "a", score: 1 }], "exactly 2"],
  ])("falls back on malformed provider output %#", async (ranking, reason) => {
    const reranker: TextReranker = {
      rerank: async () => ({ ranking }),
    };
    const outcome = await rerankTextCandidates({
      query: "test",
      candidates,
      limit: 2,
      failureMode: "fallback",
    }, reranker);
    expect(outcome.fallbackReason).toBe("reranker_invalid_output");
    expect(outcome.ranking.map(({ candidate }) => candidate.id)).toEqual(["a", "b"]);

    await expect(rerankTextCandidates({
      query: "test",
      candidates,
      limit: 2,
      failureMode: "strict",
    }, reranker)).rejects.toThrow(reason);
  });

  it("propagates cancellation instead of silently falling back", async () => {
    const reranker: TextReranker = {
      rerank: async () => {
        throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      },
    };
    await expect(rerankTextCandidates({
      query: "test",
      candidates,
      limit: 2,
      failureMode: "fallback",
    }, reranker)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("bounds a provider that ignores cancellation and classifies timeout", async () => {
    const reranker: TextReranker = {
      rerank: async () => new Promise(() => undefined),
    };
    const outcome = await rerankTextCandidates({
      query: "test",
      candidates,
      limit: 2,
      timeoutMs: 1,
      failureMode: "fallback",
    }, reranker);
    expect(outcome.fallbackReason).toBe("reranker_timeout");

    const controller = new AbortController();
    const pending = rerankTextCandidates({
      query: "test",
      candidates,
      limit: 2,
      timeoutMs: 10_000,
      failureMode: "fallback",
      signal: controller.signal,
    }, reranker);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not classify a provider TypeError as malformed output", async () => {
    const outcome = await rerankTextCandidates({
      query: "test",
      candidates,
      limit: 2,
      failureMode: "fallback",
    }, {
      rerank: async () => {
        throw new TypeError("network library failed");
      },
    });
    expect(outcome.fallbackReason).toBe("reranker_unavailable");
  });
});
