import { describe, expect, it } from "vitest";
import {
  MemoryContractError,
  assertMemoryStatusTransition,
  canAccessMemoryScope,
  createMemoryDedupeIdentity,
  createMemoryItem,
  isMemoryItemExpired,
  isMemoryItemRetrievable,
  memoryScopeKey,
  normalizeMemoryItem,
  normalizeMemoryScope,
  renderMemoryItemsMarkdown,
  type CreateMemoryItemInput,
  type MemoryItem,
} from "../memory/index.js";

const fixedFactory = {
  createId: () => "memory-1",
  now: () => "2026-07-28T12:00:00.000Z",
};

function input(
  overrides: Partial<CreateMemoryItemInput> = {},
): CreateMemoryItemInput {
  return {
    scope: { kind: "agent", agentName: "support" },
    kind: "fact",
    content: "The customer uses annual billing.",
    provenance: {
      source: "explicit",
      actor: "user",
      sourceId: "message-1",
    },
    ...overrides,
  };
}

describe("typed Memory contracts", () => {
  it("creates a validated immutable item with deterministic defaults", () => {
    const item = createMemoryItem(input(), fixedFactory);

    expect(item).toEqual({
      id: "memory-1",
      scope: { kind: "agent", agentName: "support" },
      kind: "fact",
      content: "The customer uses annual billing.",
      provenance: {
        source: "explicit",
        actor: "user",
        sourceId: "message-1",
      },
      status: "active",
      createdAt: "2026-07-28T12:00:00.000Z",
      updatedAt: "2026-07-28T12:00:00.000Z",
    });
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.scope)).toBe(true);
    expect(Object.isFrozen(item.provenance)).toBe(true);
  });

  it.each([
    [{ kind: "org", subjectId: "org-1" }],
    [{ kind: "project", subjectId: "project-1" }],
    [{ kind: "agent", agentName: "support" }],
    [{ kind: "user", subjectId: "external-user-1", agentName: "support" }],
    [{ kind: "channel", subjectId: "telegram:123" }],
    [{ kind: "session", subjectId: "session-1" }],
  ])("normalizes valid scope %#", (scope) => {
    expect(normalizeMemoryScope(scope)).toEqual(scope);
  });

  it.each([
    undefined,
    null,
    {},
    { kind: "org" },
    { kind: "project", subjectId: "" },
    { kind: "agent" },
    { kind: "agent", agentName: "" },
    { kind: "user" },
    { kind: "channel", subjectId: " " },
    { kind: "session" },
    { kind: "global" },
  ])("rejects ambiguous or malformed scope %#", (scope) => {
    expect(() => normalizeMemoryScope(scope)).toThrow(MemoryContractError);
  });

  it("authorizes scopes only against the matching caller dimension", () => {
    const access = {
      orgId: "org-1",
      projectId: "project-1",
      agentName: "support",
      externalUserId: "external-user-1",
      channelId: "telegram:123",
      sessionId: "session-1",
    };
    expect(canAccessMemoryScope({ kind: "org", subjectId: "org-1" }, access)).toBe(true);
    expect(canAccessMemoryScope({ kind: "project", subjectId: "project-1" }, access)).toBe(true);
    expect(canAccessMemoryScope({ kind: "agent", agentName: "support" }, access)).toBe(true);
    expect(canAccessMemoryScope({
      kind: "user",
      subjectId: "external-user-1",
      agentName: "support",
    }, access)).toBe(true);
    expect(canAccessMemoryScope({ kind: "channel", subjectId: "telegram:123" }, access)).toBe(true);
    expect(canAccessMemoryScope({ kind: "session", subjectId: "session-1" }, access)).toBe(true);

    expect(canAccessMemoryScope({
      kind: "user",
      subjectId: "external-user-1",
      agentName: "sales",
    }, access)).toBe(false);
    expect(canAccessMemoryScope({
      kind: "user",
      subjectId: "external-user-1",
    }, { projectId: "project-1" })).toBe(false);
    expect(canAccessMemoryScope({
      kind: "project",
      subjectId: "project-2",
    }, access)).toBe(false);
  });

  it("never treats an omitted external user as project-wide access", () => {
    expect(canAccessMemoryScope(
      { kind: "user", subjectId: "same-user" },
      { projectId: "project-a", agentName: "support" },
    )).toBe(false);
  });

  it("creates stable, scope-aware exact dedupe identities", () => {
    const first = createMemoryDedupeIdentity({
      scope: { kind: "user", subjectId: "user-1", agentName: "support" },
      kind: "preference",
      content: "  Prefers   concise\u00a0answers. ",
    });
    const equivalent = createMemoryDedupeIdentity({
      scope: { kind: "user", subjectId: "user-1", agentName: "support" },
      kind: "preference",
      content: "prefers concise answers.",
    });
    const otherUser = createMemoryDedupeIdentity({
      scope: { kind: "user", subjectId: "user-2", agentName: "support" },
      kind: "preference",
      content: "prefers concise answers.",
    });

    expect(first).toBe(equivalent);
    expect(first).not.toBe(otherUser);
    expect(memoryScopeKey({
      kind: "user",
      subjectId: "user-1",
      agentName: "support",
    })).toBe('["user","user-1","support"]');
  });

  it.each([
    ["pending", "active", true],
    ["pending", "deleted", true],
    ["active", "superseded", true],
    ["active", "deleted", true],
    ["superseded", "deleted", true],
    ["active", "pending", false],
    ["superseded", "active", false],
    ["deleted", "active", false],
  ] as const)("enforces %s -> %s status transitions", (from, to, allowed) => {
    if (allowed) {
      expect(() => assertMemoryStatusTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertMemoryStatusTransition(from, to)).toThrow(
        MemoryContractError,
      );
    }
  });

  it("allows idempotent lifecycle writes", () => {
    expect(() => assertMemoryStatusTransition("active", "active")).not.toThrow();
    expect(() => assertMemoryStatusTransition("deleted", "deleted")).not.toThrow();
  });

  it("filters expired, pending, superseded, and deleted items from retrieval", () => {
    const active = createMemoryItem(input({
      expiresAt: "2026-07-28T13:00:00.000Z",
    }), fixedFactory);
    const expired = createMemoryItem(input({
      expiresAt: "2026-07-28T11:59:59.999Z",
    }), fixedFactory);
    const pending = createMemoryItem(input({ status: "pending" }), fixedFactory);

    expect(isMemoryItemExpired(active, fixedFactory.now())).toBe(false);
    expect(isMemoryItemRetrievable(active, fixedFactory.now())).toBe(true);
    expect(isMemoryItemExpired(expired, fixedFactory.now())).toBe(true);
    expect(isMemoryItemRetrievable(expired, fixedFactory.now())).toBe(false);
    expect(isMemoryItemRetrievable(pending, fixedFactory.now())).toBe(false);
    expect(() => isMemoryItemExpired(
      { expiresAt: "not-a-date" },
      fixedFactory.now(),
    )).toThrow(MemoryContractError);
  });

  it("normalizes persisted items and rejects malformed or future kinds safely", () => {
    const item = createMemoryItem(input(), fixedFactory);
    expect(normalizeMemoryItem(JSON.parse(JSON.stringify(item)))).toEqual(item);

    for (const invalid of [
      { ...item, kind: "unknown-future-kind" },
      { ...item, confidence: Number.NaN },
      { ...item, confidence: 1.1 },
      { ...item, content: "" },
      { ...item, createdAt: "not-a-date" },
      { ...item, updatedAt: "2026-07-27T12:00:00.000Z" },
      { ...item, provenance: { source: "run" } },
    ]) {
      expect(() => normalizeMemoryItem(invalid)).toThrow(MemoryContractError);
    }
  });

  it("rejects empty and oversized content at the contract boundary", () => {
    expect(() => createMemoryItem(input({ content: " " }), fixedFactory)).toThrow();
    expect(() => createMemoryItem(input({ content: "x".repeat(32_001) }), fixedFactory)).toThrow();
  });

  it("renders a deterministic active-only markdown compatibility view", () => {
    const first = createMemoryItem(input({
      kind: "preference",
      content: "Use concise answers.",
    }), { createId: () => "b", now: () => "2026-07-28T11:00:00.000Z" });
    const second = createMemoryItem(input({
      kind: "fact",
      content: "Annual billing is enabled.",
    }), { createId: () => "a", now: () => "2026-07-28T10:00:00.000Z" });
    const pending = createMemoryItem(input({
      content: "Do not render me.",
      status: "pending",
    }), { createId: () => "c", now: () => "2026-07-28T09:00:00.000Z" });

    expect(renderMemoryItemsMarkdown([first, pending, second])).toBe(
      [
        "- **Fact:** Annual billing is enabled.",
        "- **Preference:** Use concise answers.",
      ].join("\n"),
    );
  });

  it("indents multiline content inside one compatibility list item", () => {
    const item = createMemoryItem(input({
      content: "First line\nSecond line",
    }), fixedFactory);
    expect(renderMemoryItemsMarkdown([item])).toBe(
      "- **Fact:** First line\n  Second line",
    );
  });

  it("copies caller-owned inputs instead of retaining mutable references", () => {
    const scope = { kind: "agent" as const, agentName: "support" };
    const provenance = {
      source: "explicit" as const,
      actor: "user" as const,
      sourceId: "message-1",
    };
    const item = createMemoryItem(input({ scope, provenance }), fixedFactory);
    scope.agentName = "mutated";
    provenance.sourceId = "mutated";

    expect(item.scope).toEqual({ kind: "agent", agentName: "support" });
    expect(item.provenance.sourceId).toBe("message-1");
  });

  it("renders no markdown block when there are no retrievable items", () => {
    const deleted = {
      ...createMemoryItem(input(), fixedFactory),
      status: "deleted",
    } as MemoryItem;
    expect(renderMemoryItemsMarkdown([deleted])).toBe("");
  });
});
