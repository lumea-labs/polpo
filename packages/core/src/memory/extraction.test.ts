import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryExtractionStore,
  MemoryAuthorizationError,
  MemoryConflictError,
  MemoryContractError,
  createMemoryExtractionCandidate,
  normalizeMemoryExtractionAuditEvent,
  normalizeMemoryExtractionCandidate,
  type CreateMemoryExtractionCandidateInput,
  type MemoryExtractionStoreContext,
} from "./index.js";

const now = "2026-07-28T12:00:00.000Z";
const later = "2026-07-28T12:01:00.000Z";

function context(
  namespace = "project-a",
  externalUserId = "user-a",
): MemoryExtractionStoreContext {
  return {
    namespace,
    access: {
      projectId: namespace,
      agentName: "assistant",
      externalUserId,
      sessionId: "session-a",
    },
  };
}

function input(
  overrides: Partial<CreateMemoryExtractionCandidateInput> = {},
): CreateMemoryExtractionCandidateInput {
  return {
    idempotencyKey: "run-a:message-a:0",
    scope: {
      kind: "user",
      subjectId: "user-a",
      agentName: "assistant",
    },
    kind: "preference",
    content: "Prefers concise weekly summaries.",
    confidence: 0.92,
    source: {
      runId: "run-a",
      sessionId: "session-a",
      messageIds: ["message-a"],
    },
    ...overrides,
  };
}

function candidate(
  overrides: Partial<CreateMemoryExtractionCandidateInput> = {},
) {
  return createMemoryExtractionCandidate(input(overrides), {
    createId: () => "candidate-a",
    now: () => now,
  });
}

describe("Memory extraction candidate contract", () => {
  it("creates only pending proposals with extraction provenance", () => {
    const value = candidate();

    expect(value).toMatchObject({
      id: "candidate-a",
      idempotencyKey: "run-a:message-a:0",
      status: "pending",
      revision: 1,
      proposal: { action: "create" },
      provenance: {
        source: "extraction",
        runId: "run-a",
        sessionId: "session-a",
        messageId: "message-a",
      },
      createdAt: now,
      updatedAt: now,
    });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.source.messageIds)).toBe(true);
  });

  it("normalizes whitespace, message ids, findings, and immutable metadata", () => {
    const value = createMemoryExtractionCandidate(input({
      idempotencyKey: "  delivery-a  ",
      content: "  Prefers   concise summaries.  ",
      summary: "  Summary  ",
      source: {
        runId: " run-a ",
        messageIds: [" message-b ", "message-a", "message-b"],
      },
      sensitiveFindings: [
        { code: "custom_secret", start: 8, length: 4 },
        { code: "bad code", start: -1, length: -1 },
      ],
      metadata: { extractor: "small-model" },
    }), {
      createId: () => "candidate-a",
      now: () => now,
    });

    expect(value.idempotencyKey).toBe("delivery-a");
    expect(value.content).toBe("Prefers   concise summaries.");
    expect(value.summary).toBe("Summary");
    expect(value.source.messageIds).toEqual(["message-a", "message-b"]);
    expect(value.sensitiveFindings).toEqual([
      { code: "custom_sensitive_content", start: 0, length: 0 },
      { code: "custom_secret", start: 8, length: 4 },
    ]);
    expect(value.metadata).toEqual({ extractor: "small-model" });
    expect(Object.isFrozen(value.metadata)).toBe(true);
  });

  it.each([
    ["missing source references", { source: {} }],
    ["missing idempotency key", { idempotencyKey: " " }],
    ["invalid confidence", { confidence: Number.NaN }],
    ["unknown kind", { kind: "instruction" as never }],
    ["empty content", { content: " " }],
    ["unknown metadata value", { metadata: { nested: new Date() } }],
  ])("rejects %s", (_label, override) => {
    expect(() => candidate(override as never)).toThrow(MemoryContractError);
  });

  it("requires a target for duplicate and supersede proposals", () => {
    expect(() => candidate({
      proposal: { action: "duplicate" } as never,
    })).toThrow(MemoryContractError);
    expect(() => candidate({
      proposal: {
        action: "create",
        existingMemoryId: "memory-a",
      } as never,
    })).toThrow(MemoryContractError);
  });

  it("adds deterministic sensitive-content findings even when omitted", () => {
    const value = candidate({
      content: "Use api_key=abcdefghijklmnop1234 for the next call.",
    });
    expect(value.sensitiveFindings.map((finding) => finding.code)).toContain(
      "credential_assignment",
    );
  });

  it("rejects malformed restored candidates instead of activating them", () => {
    const value = candidate();
    expect(() => normalizeMemoryExtractionCandidate({
      ...value,
      status: "applied",
    })).toThrow(MemoryContractError);
    expect(() => normalizeMemoryExtractionCandidate({
      ...value,
      updatedAt: "not-a-date",
    })).toThrow(MemoryContractError);
  });

  it.each([
    ["pending", 2],
    ["approved", 1],
    ["rejected", 3],
    ["applied", 2],
  ] as const)("rejects a %s candidate with revision %s", (status, revision) => {
    const value = candidate();
    const decision = status === "pending"
      ? undefined
      : {
          decision: status === "rejected" ? "reject" : "approve",
          decidedBy: { actor: "user", actorId: "reviewer-a" },
          decidedAt: now,
          ...(status === "rejected" ? { reason: "Rejected." } : {}),
        };
    expect(() => normalizeMemoryExtractionCandidate({
      ...value,
      status,
      revision,
      ...(decision ? { decision } : {}),
      ...(status === "applied"
        ? { appliedMemoryId: "memory-a", appliedAt: now }
        : {}),
    })).toThrow(MemoryContractError);
  });

  it("rejects audit fields that do not belong to the event type", () => {
    expect(() => normalizeMemoryExtractionAuditEvent({
      id: "audit-a",
      candidateId: "candidate-a",
      type: "approved",
      at: now,
      reviewer: { actor: "user", actorId: "reviewer-a" },
      memoryId: "memory-a",
    })).toThrow(MemoryContractError);
    expect(() => normalizeMemoryExtractionAuditEvent({
      id: "audit-b",
      candidateId: "candidate-a",
      type: "applied",
      at: now,
      reviewer: { actor: "system", actorId: "worker-a" },
      memoryId: "memory-a",
    })).toThrow(MemoryContractError);
  });

  it("keeps metadata keys inert and rejects normalized duplicates", () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as
      Record<string, unknown>;
    const value = candidate({ metadata: polluted });

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.hasOwn(value.metadata, "__proto__")).toBe(true);
    expect(value.metadata.__proto__).toEqual({ polluted: true });
    expect(() => candidate({
      metadata: { " key ": "first", key: "second" },
    })).toThrow(MemoryContractError);
  });
});

describe("InMemoryMemoryExtractionStore", () => {
  it("makes duplicate delivery idempotent without duplicate audit events", async () => {
    let auditId = 0;
    const store = new InMemoryMemoryExtractionStore({
      createAuditId: () => `audit-${++auditId}`,
      now: () => now,
    });

    const first = await store.propose(candidate(), context());
    const replay = await store.propose(candidate(), context());

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.candidate.id).toBe(first.candidate.id);
    expect(await store.list({}, context())).toHaveLength(1);
    expect(await store.listAudit(first.candidate.id, context())).toHaveLength(1);
  });

  it("rejects reuse of an idempotency key for a different proposal", async () => {
    const store = new InMemoryMemoryExtractionStore();
    await store.propose(candidate(), context());

    await expect(store.propose(candidate({
      content: "A conflicting proposal.",
    }), context())).rejects.toThrow(MemoryConflictError);
  });

  it("isolates identical ids and idempotency keys by namespace", async () => {
    const store = new InMemoryMemoryExtractionStore();
    await store.propose(candidate(), context("project-a"));
    await store.propose(candidate(), context("project-b", "user-a"));

    expect(await store.list({}, context("project-a"))).toHaveLength(1);
    expect(await store.list({}, context("project-b", "user-a"))).toHaveLength(1);
  });

  it("isolates idempotency keys across authorized scopes in one namespace", async () => {
    const store = new InMemoryMemoryExtractionStore();
    await store.propose(candidate(), context());
    await store.propose(createMemoryExtractionCandidate(input({
      scope: {
        kind: "session",
        subjectId: "session-a",
        agentName: "assistant",
      },
    }), {
      createId: () => "candidate-session",
      now: () => now,
    }), context());

    expect(await store.list({}, context())).toHaveLength(2);
  });

  it("checks scope authorization before revealing ids or idempotency matches", async () => {
    const store = new InMemoryMemoryExtractionStore();
    await store.propose(candidate(), context());
    const denied = context("project-a", "user-b");

    await expect(store.get("candidate-a", denied)).rejects.toThrow(
      MemoryAuthorizationError,
    );
    await expect(store.propose(candidate(), denied)).rejects.toThrow(
      MemoryAuthorizationError,
    );
  });

  it("applies the pending → approved → applied lifecycle with audit", async () => {
    let clock = now;
    let auditId = 0;
    const store = new InMemoryMemoryExtractionStore({
      now: () => clock,
      createAuditId: () => `audit-${++auditId}`,
    });
    const proposed = await store.propose(candidate(), context());

    clock = later;
    const approved = await store.decide("candidate-a", {
      decision: "approve",
      decidedBy: { actor: "user", actorId: "reviewer-a" },
      reason: "Confirmed by the user.",
      expectedRevision: proposed.candidate.revision,
    }, context());
    expect(approved.status).toBe("approved");
    expect(approved.decision?.decidedAt).toBe(later);

    const applied = await store.markApplied("candidate-a", {
      memoryId: "memory-a",
      expectedRevision: approved.revision,
    }, context());
    expect(applied.status).toBe("applied");
    expect(applied.appliedMemoryId).toBe("memory-a");
    expect((await store.listAudit("candidate-a", context())).map(
      (event) => event.type,
    )).toEqual(["proposed", "approved", "applied"]);
    expect(() => new InMemoryMemoryExtractionStore({
      snapshot: store.snapshot(),
    })).not.toThrow();
  });

  it("keeps rejection terminal and records a reason", async () => {
    const store = new InMemoryMemoryExtractionStore({ now: () => now });
    await store.propose(candidate(), context());
    const rejected = await store.decide("candidate-a", {
      decision: "reject",
      decidedBy: { actor: "user", actorId: "reviewer-a" },
      reason: "This is not durable.",
    }, context());

    expect(rejected.status).toBe("rejected");
    expect(rejected.decision?.reason).toBe("This is not durable.");
    await expect(store.markApplied("candidate-a", {
      memoryId: "memory-a",
    }, context())).rejects.toThrow(MemoryConflictError);
  });

  it("requires a rejection reason for an auditable decision", async () => {
    const store = new InMemoryMemoryExtractionStore({ now: () => now });
    await store.propose(candidate(), context());

    await expect(store.decide("candidate-a", {
      decision: "reject",
      decidedBy: { actor: "user", actorId: "reviewer-a" },
    }, context())).rejects.toThrow(MemoryContractError);
    expect((await store.get("candidate-a", context()))?.status).toBe("pending");
  });

  it("uses optimistic concurrency so two reviewers cannot both decide", async () => {
    let clock = now;
    const store = new InMemoryMemoryExtractionStore({ now: () => clock });
    const proposed = await store.propose(candidate(), context());
    clock = later;

    await store.decide("candidate-a", {
      decision: "approve",
      decidedBy: { actor: "user", actorId: "reviewer-a" },
      expectedRevision: proposed.candidate.revision,
    }, context());
    await expect(store.decide("candidate-a", {
      decision: "reject",
      decidedBy: { actor: "user", actorId: "reviewer-b" },
      expectedRevision: proposed.candidate.revision,
    }, context())).rejects.toThrow(MemoryConflictError);
  });

  it("round-trips a validated snapshot without cross-namespace references", async () => {
    const store = new InMemoryMemoryExtractionStore({ now: () => now });
    await store.propose(candidate(), context());
    const restored = new InMemoryMemoryExtractionStore({
      snapshot: store.snapshot(),
      now: () => later,
    });

    expect(await restored.get("candidate-a", context())).toEqual(
      await store.get("candidate-a", context()),
    );
    expect(() => new InMemoryMemoryExtractionStore({
      snapshot: {
        version: 1,
        namespaces: [{
          namespace: "project-a",
          candidates: [candidate()],
          audit: [{
            id: "audit-orphan",
            candidateId: "missing",
            type: "proposed",
            at: now,
          }],
        }],
      },
    })).toThrow(MemoryContractError);

    expect(() => new InMemoryMemoryExtractionStore({
      snapshot: {
        version: 1,
        namespaces: [{
          namespace: "project-a",
          candidates: [{
            ...candidate(),
            status: "approved",
            revision: 2,
            decision: {
              decision: "approve",
              decidedBy: { actor: "user", actorId: "reviewer-a" },
              decidedAt: now,
            },
          }],
          audit: [{
            id: "audit-proposed",
            candidateId: "candidate-a",
            type: "proposed",
            at: now,
          }],
        }],
      },
    })).toThrow(MemoryContractError);
  });

  it("does not partially persist when an audit id collides", async () => {
    const store = new InMemoryMemoryExtractionStore({
      createAuditId: () => "audit-fixed",
      now: () => now,
    });
    await store.propose(candidate(), context());

    await expect(store.propose(createMemoryExtractionCandidate(input({
      idempotencyKey: "run-a:message-b:0",
      content: "A second candidate.",
      source: { runId: "run-a", messageIds: ["message-b"] },
    }), {
      createId: () => "candidate-b",
      now: () => now,
    }), context())).rejects.toThrow(MemoryConflictError);
    expect(await store.list({}, context())).toHaveLength(1);
  });
});
