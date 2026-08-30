import { describe, expect, it, vi } from "vitest";
import type { CanonicalTurnCommitted } from "../canonical-turn.js";
import {
  DeterministicMemoryConsolidationPolicy,
  InMemoryMemoryExtractionStore,
  InMemoryMemoryItemStore,
  MemoryContractError,
  MemoryLearningService,
  createMemoryItem,
  evaluateMemoryTurnEligibility,
  type MemoryExtractor,
  type MemoryExtractionStoreContext,
  type MemoryStoreContext,
} from "./index.js";

const now = "2026-08-30T12:00:00.000Z";

function turn(overrides: Partial<CanonicalTurnCommitted> = {}): CanonicalTurnCommitted {
  return {
    turnId: "turn-1",
    requestId: "request-1",
    runId: "run-1",
    sessionId: "session-1",
    agentName: "assistant",
    surface: "chat",
    terminalStatus: "succeeded",
    userMessage: { id: "user-message-1", role: "user" },
    assistantMessage: { id: "assistant-message-1", role: "assistant" },
    trustedInvocation: { externalUserId: "user-1" },
    occurredAt: now,
    ...overrides,
  };
}

const itemContext: MemoryStoreContext = {
  namespace: "project-1",
  access: {
    projectId: "project-1",
    agentName: "assistant",
    externalUserId: "user-1",
    sessionId: "session-1",
  },
  surface: "chat",
  now,
};

const candidateContext: MemoryExtractionStoreContext = {
  namespace: "project-1",
  access: itemContext.access,
};

function extractor(candidates: unknown[]): MemoryExtractor {
  return {
    revision: "extractor-v1",
    extract: vi.fn(async () => ({ candidates })) as MemoryExtractor["extract"],
  };
}

function service(candidateValues: unknown[], itemStore = new InMemoryMemoryItemStore()) {
  const candidateStore = new InMemoryMemoryExtractionStore({ now: () => now });
  const memoryExtractor = extractor(candidateValues);
  return {
    candidateStore,
    itemStore,
    memoryExtractor,
    learning: new MemoryLearningService({
      extractor: memoryExtractor,
      policy: new DeterministicMemoryConsolidationPolicy({ itemStore }),
      candidateStore,
      itemStore,
      now: () => now,
    }),
  };
}

function processInput(overrides: Record<string, unknown> = {}) {
  return {
    turn: turn(),
    userContent: "I prefer concise weekly summaries.",
    assistantContent: "I will keep them concise.",
    mode: "suggest" as const,
    surfaces: ["chat", "channel"] as const,
    kinds: ["fact", "preference", "style", "open_thread"] as const,
    candidateContext,
    itemContext,
    ...overrides,
  };
}

describe("automatic Memory turn eligibility", () => {
  it.each([
    ["learning_off", { mode: "off" }],
    ["surface_disabled", { surfaces: ["channel"] }],
    ["turn_not_succeeded", { turn: turn({ terminalStatus: "failed" }) }],
    ["missing_external_user", { turn: turn({ trustedInvocation: {} }) }],
    ["missing_visible_messages", {
      turn: turn({ assistantMessage: undefined }),
    }],
  ])("rejects %s turns", (reason, override) => {
    const values = override as {
      turn?: CanonicalTurnCommitted;
      mode?: "off";
      surfaces?: readonly ("chat" | "channel")[];
    };
    expect(evaluateMemoryTurnEligibility({
      turn: values.turn ?? turn(),
      mode: values.mode ?? "suggest",
      surfaces: values.surfaces ?? ["chat", "channel"],
    })).toMatchObject({ eligible: false, reason });
  });

  it("creates only the trusted external-user plus agent scope", () => {
    expect(evaluateMemoryTurnEligibility({
      turn: turn(),
      mode: "automatic",
      surfaces: ["chat"],
    })).toEqual({
      eligible: true,
      scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
    });
  });
});

describe("MemoryLearningService", () => {
  const preference = {
    kind: "preference" as const,
    content: "Prefers concise weekly summaries.",
    confidence: 0.96,
    evidence: "user" as const,
  };

  it("keeps valid suggestions pending without mutating active Memory", async () => {
    const { learning, candidateStore, itemStore } = service([preference]);

    const result = await learning.process(processInput());

    expect(result).toMatchObject({ eligible: true, appliedMemoryIds: [] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      status: "pending",
      idempotencyKey: "turn-1:extractor-v1:deterministic-v1:0",
      source: {
        turnId: "turn-1",
        extractorRevision: "extractor-v1",
        policyRevision: "deterministic-v1",
      },
      scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
    });
    expect(await candidateStore.list({}, candidateContext)).toHaveLength(1);
    expect(await itemStore.list({}, itemContext)).toEqual([]);
  });

  it("auto-applies only high-confidence safe user evidence", async () => {
    const { learning, itemStore } = service([preference]);

    const result = await learning.process(processInput({ mode: "automatic" }));

    expect(result.candidates[0]?.status).toBe("applied");
    expect(result.appliedMemoryIds).toHaveLength(1);
    expect(await itemStore.list({}, itemContext)).toEqual([
      expect.objectContaining({
        id: result.appliedMemoryIds[0],
        status: "active",
        content: preference.content,
        provenance: expect.objectContaining({
          source: "extraction",
          sourceId: "turn-1",
          messageId: "user-message-1",
        }),
      }),
    ]);
  });

  it("rejects secret-like content and never creates active Memory", async () => {
    const { learning, itemStore } = service([{
      ...preference,
      content: "Use api_key=abcdefghijklmnop1234 for deployments.",
    }]);

    const result = await learning.process(processInput({ mode: "automatic" }));

    expect(result.candidates[0]).toMatchObject({
      status: "rejected",
      decision: { reason: "sensitive_content" },
    });
    expect(await itemStore.list({}, itemContext)).toEqual([]);
  });

  it("rejects exact duplicates without producing a second active item", async () => {
    const itemStore = new InMemoryMemoryItemStore();
    await itemStore.create(createMemoryItem({
      id: "existing-1",
      scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
      kind: "preference",
      content: preference.content,
      provenance: { source: "explicit", actor: "user", sourceId: "request-0" },
    }, { now: () => now }), itemContext);
    const { learning } = service([preference], itemStore);

    const result = await learning.process(processInput({ mode: "automatic" }));

    expect(result.candidates[0]).toMatchObject({
      status: "rejected",
      proposal: { action: "duplicate", existingMemoryId: "existing-1" },
      decision: { reason: "exact_duplicate" },
    });
    expect(await itemStore.list({}, itemContext)).toHaveLength(1);
  });

  it("rejects a delayed supersede after a newer explicit correction", async () => {
    const itemStore = new InMemoryMemoryItemStore();
    await itemStore.create(createMemoryItem({
      id: "newer-preference",
      scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
      kind: "preference",
      content: "Prefers detailed summaries.",
      provenance: { source: "explicit", actor: "user", sourceId: "request-new" },
    }, { now: () => "2026-08-30T12:05:00.000Z" }), itemContext);
    const { learning } = service([{
      ...preference,
      existingMemoryId: "newer-preference",
    }], itemStore);

    const result = await learning.process(processInput({ mode: "automatic" }));

    expect(result.candidates[0]).toMatchObject({
      status: "rejected",
      decision: { reason: "stale_extraction" },
    });
    expect((await itemStore.get("newer-preference", itemContext))?.status).toBe("active");
  });

  it("is idempotent across duplicate jobs and extractor retries", async () => {
    const { learning, candidateStore, itemStore } = service([preference]);

    const first = await learning.process(processInput({ mode: "automatic" }));
    const replay = await learning.process(processInput({ mode: "automatic" }));

    expect(replay.appliedMemoryIds).toEqual(first.appliedMemoryIds);
    expect(await candidateStore.list({}, candidateContext)).toHaveLength(1);
    expect(await itemStore.list({}, itemContext)).toHaveLength(1);
  });

  it.each([
    ["assistant-only evidence", [{ ...preference, evidence: "assistant" }]],
    ["unknown kind", [{ ...preference, kind: "instruction" }]],
    ["NaN confidence", [{ ...preference, confidence: Number.NaN }]],
    ["unknown field", [{ ...preference, scope: { kind: "org" } }]],
    ["too many candidates", Array.from({ length: 21 }, () => preference)],
  ])("fails closed on malformed extractor output: %s", async (_label, values) => {
    const { learning } = service(values);
    await expect(learning.process(processInput({ mode: "automatic" })))
      .rejects.toThrow(MemoryContractError);
  });

  it("does not invoke the extractor for an untrusted end-user", async () => {
    const { learning, memoryExtractor } = service([preference]);
    const result = await learning.process(processInput({
      turn: turn({ trustedInvocation: {} }),
    }));

    expect(result).toMatchObject({ eligible: false, reason: "missing_external_user" });
    expect(memoryExtractor.extract).not.toHaveBeenCalled();
  });
});
