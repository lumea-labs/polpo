import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryMemoryExtractionStore,
  InMemoryMemoryItemStore,
  createMemoryExtractionCandidate,
  type MemoryExtractionCandidate,
  type MemoryExtractionStoreContext,
  type MemoryStoreContext,
} from "@polpo-ai/core";
import { memoryCandidateRoutes } from "./memory-candidates.js";

const access = {
  projectId: "project-1",
  agentName: "assistant",
  externalUserId: "user-1",
} as const;
const candidateContext: MemoryExtractionStoreContext = {
  namespace: "project-1",
  access,
};
const itemContext: MemoryStoreContext = {
  namespace: "project-1",
  access,
  surface: "api",
};

function candidate(
  id: string,
  createdAt: string,
  content = `Preference ${id}`,
): MemoryExtractionCandidate {
  return createMemoryExtractionCandidate({
    idempotencyKey: `turn-${id}:extractor-v1:policy-v1:0`,
    scope: { kind: "user", subjectId: "user-1", agentName: "assistant" },
    kind: "preference",
    content,
    source: { turnId: `turn-${id}`, messageIds: [`message-${id}`] },
  }, { createId: () => id, now: () => createdAt });
}

async function fixture() {
  const extraction = new InMemoryMemoryExtractionStore();
  const items = new InMemoryMemoryItemStore();
  const app = new Hono();
  app.route("/", memoryCandidateRoutes(() => ({
    memoryExtractionStore: extraction,
    memoryItemStore: items,
    resolveMemoryContext: () => itemContext,
    resolveMemoryReviewer: () => ({ actor: "user", actorId: "reviewer-1" }),
  })));
  return { app, extraction, items };
}

describe("memoryCandidateRoutes", () => {
  it("lists candidates with opaque filter-bound pagination", async () => {
    const { app, extraction } = await fixture();
    await extraction.propose(candidate("candidate-1", "2020-08-30T10:00:00.000Z"), candidateContext);
    await extraction.propose(candidate("candidate-2", "2020-08-30T11:00:00.000Z"), candidateContext);
    await extraction.propose(candidate("candidate-3", "2020-08-30T12:00:00.000Z"), candidateContext);

    const first = await app.request("/agents/assistant/memory/candidates?limit=2");
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.data.candidates.map((value: any) => value.id)).toEqual([
      "candidate-3",
      "candidate-2",
    ]);
    expect(firstBody.data.nextCursor).toMatch(/^mc1\./u);

    const list = vi.spyOn(extraction, "list");
    const second = await app.request(
      `/agents/assistant/memory/candidates?limit=2&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect((await second.json() as any).data).toMatchObject({
      candidates: [{ id: "candidate-1" }],
      nextCursor: null,
    });
    expect(list).toHaveBeenCalledWith({
      after: {
        createdAt: "2020-08-30T11:00:00.000Z",
        id: "candidate-2",
      },
      limit: 3,
    }, candidateContext);
    const mismatched = await app.request(
      `/agents/assistant/memory/candidates?statuses=pending&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
    );
    expect(mismatched.status).toBe(400);
  });

  it("uses the host-authenticated reviewer and rejects body identity injection", async () => {
    const { app, extraction } = await fixture();
    await extraction.propose(candidate("candidate-1", "2020-08-30T10:00:00.000Z"), candidateContext);

    const injected = await app.request(
      "/agents/assistant/memory/candidates/candidate-1/decision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          decidedBy: { actor: "system", actorId: "attacker" },
        }),
      },
    );
    expect(injected.status).toBe(400);

    const approved = await app.request(
      "/agents/assistant/memory/candidates/candidate-1/decision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", expectedRevision: 1 }),
      },
    );
    expect(approved.status).toBe(200);
    expect((await approved.json() as any).data.candidate).toMatchObject({
      status: "approved",
      decision: { decidedBy: { actor: "user", actorId: "reviewer-1" } },
    });
  });

  it("applies an approved candidate idempotently and preserves audit", async () => {
    const { app, extraction, items } = await fixture();
    await extraction.propose(candidate(
      "candidate-1",
      "2020-08-30T10:00:00.000Z",
      "The user prefers concise answers.",
    ), candidateContext);
    await extraction.decide("candidate-1", {
      decision: "approve",
      decidedBy: { actor: "user", actorId: "reviewer-1" },
      expectedRevision: 1,
    }, candidateContext);

    const apply = () => app.request(
      "/agents/assistant/memory/candidates/candidate-1/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect((await apply()).status).toBe(200);
    expect((await apply()).status).toBe(200);
    expect(await items.list({}, itemContext)).toHaveLength(1);

    const audit = await app.request(
      "/agents/assistant/memory/candidates/candidate-1/audit",
    );
    expect((await audit.json() as any).data.events.map((event: any) => event.type))
      .toEqual(["proposed", "approved", "applied"]);
  });

  it("fails closed for stale revisions, unauthorized agents, and missing stores", async () => {
    const { app, extraction } = await fixture();
    await extraction.propose(candidate("candidate-1", "2020-08-30T10:00:00.000Z"), candidateContext);
    const stale = await app.request(
      "/agents/assistant/memory/candidates/candidate-1/decision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve", expectedRevision: 99 }),
      },
    );
    expect(stale.status).toBe(409);

    const forbidden = await app.request("/agents/other/memory/candidates");
    expect(forbidden.status).toBe(403);

    const unavailable = memoryCandidateRoutes(() => ({
      resolveMemoryContext: () => itemContext,
    }));
    expect((await unavailable.request("/agents/assistant/memory/candidates")).status).toBe(503);
  });
});
