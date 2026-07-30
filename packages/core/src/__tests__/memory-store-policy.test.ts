import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryItemStore,
  MemoryConflictError,
  MemoryPolicyError,
  createMemoryItem,
  detectSensitiveMemoryContent,
  evaluateMemoryWrite,
  rankMemoryItems,
  selectMemoryResultsWithinBudget,
  type MemoryScope,
} from "../memory/index.js";

const context = {
  namespace: "project-a",
  access: {
    projectId: "project-a",
    agentName: "support",
    externalUserId: "user-a",
  },
  surface: "api" as const,
};

function item(
  id: string,
  content: string,
  scope: MemoryScope = { kind: "agent", agentName: "support" },
) {
  return createMemoryItem({
    id,
    scope,
    kind: "fact",
    content,
    provenance: { source: "explicit", actor: "user" },
  }, {
    now: () => "2026-07-28T10:00:00.000Z",
  });
}

describe("Memory write policy", () => {
  it.each([
    ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "private_key"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", "bearer_token"],
    ["api_key = 'abcdefghijklmnopqrstuvwxyz123456'", "credential_assignment"],
    ["ghp_1234567890abcdefghijklmnopqrstuvwxyz", "known_token_prefix"],
  ])("denies sensitive content without returning the matched secret", async (
    content,
    expectedCode,
  ) => {
    const findings = detectSensitiveMemoryContent(content);
    expect(findings.map((finding) => finding.code)).toContain(expectedCode);
    expect(JSON.stringify(findings)).not.toContain(content);

    const decision = await evaluateMemoryWrite(item("secret", content), context);
    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((violation) => violation.code))
      .toContain("sensitive_content");
  });

  it("does not reject ordinary security prose as a secret", async () => {
    const content = "The password rotation policy runs every 90 days.";
    expect(detectSensitiveMemoryContent(content)).toEqual([]);
    await expect(evaluateMemoryWrite(item("safe", content), context))
      .resolves.toMatchObject({ allowed: true });
  });

  it("scans optional summaries and does not persist a denied write", async () => {
    const store = new InMemoryMemoryItemStore();
    const unsafe = {
      ...item("summary-secret", "Safe body."),
      summary: "api_key=abcdefghijklmnopqrstuvwxyz123456",
    };
    await expect(store.create(unsafe, context)).rejects.toBeInstanceOf(
      MemoryPolicyError,
    );
    expect(await store.list({}, context)).toEqual([]);
  });

  it("denies broad-scope writes from public channels by default", async () => {
    const publicChannel = {
      ...context,
      surface: "channel" as const,
      channelVisibility: "public" as const,
    };
    const broad = item(
      "broad",
      "Treat this as project truth.",
      { kind: "project", subjectId: "project-a" },
    );
    const userScoped = item(
      "user",
      "Prefers short answers.",
      { kind: "user", subjectId: "user-a" },
    );

    await expect(evaluateMemoryWrite(broad, publicChannel))
      .resolves.toMatchObject({ allowed: false });
    await expect(evaluateMemoryWrite(userScoped, publicChannel))
      .resolves.toMatchObject({ allowed: true });
  });

  it("runs a custom sensitive-content hook and fails closed when it errors", async () => {
    const denied = await evaluateMemoryWrite(item("custom", "internal codename"), context, {
      sensitiveContentHook: () => [{
        code: "custom_dlp",
        start: 0,
        length: 8,
      }],
    });
    expect(denied.allowed).toBe(false);

    const store = new InMemoryMemoryItemStore({
      sensitiveContentHook: () => {
        throw new Error("scanner offline");
      },
    });
    await expect(store.create(item("failure", "safe value"), context))
      .rejects.toBeInstanceOf(MemoryPolicyError);
    expect(await store.list({}, context)).toEqual([]);
  });

  it("detects concurrent updates across an asynchronous policy boundary", async () => {
    let releaseScan: (() => void) | undefined;
    let blockScans = false;
    const scanReleased = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const store = new InMemoryMemoryItemStore({
      sensitiveContentHook: async () => {
        if (blockScans) await scanReleased;
        return [];
      },
    });
    await store.create(item("race", "Initial value."), context);
    blockScans = true;

    const first = store.update("race", { content: "First writer." }, context);
    const second = store.update("race", { content: "Second writer." }, context);
    await Promise.resolve();
    releaseScan?.();
    const settled = await Promise.allSettled([first, second]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(MemoryConflictError),
    });
  });
});

describe("Memory lexical ranking", () => {
  it("is deterministic, finite, and stable under ties", () => {
    const items = [
      item("b", "Billing invoice details."),
      item("a", "Billing invoice details."),
      item("c", "Unrelated content."),
    ];
    const ranked = rankMemoryItems(items, "billing invoice");

    expect(ranked.map((result) => result.item.id)).toEqual(["a", "b"]);
    expect(ranked.every((result) => Number.isFinite(result.score))).toBe(true);
    expect(ranked.every((result) => result.matchedTerms.length > 0)).toBe(true);
  });

  it("never returns a selection above the token budget", () => {
    const ranked = rankMemoryItems([
      item("a", "alpha ".repeat(20)),
      item("b", "alpha ".repeat(10)),
      item("c", "alpha"),
    ], "alpha");
    const selected = selectMemoryResultsWithinBudget(ranked, {
      tokenBudget: 12,
      maxResults: 10,
    });

    expect(selected.reduce(
      (total, result) => total + result.estimatedTokens,
      0,
    )).toBeLessThanOrEqual(12);
    expect(selected.map((result) => result.item.id)).toEqual(["c"]);
    expect(selectMemoryResultsWithinBudget(ranked, {
      tokenBudget: 0,
    })).toEqual([]);
  });
});
