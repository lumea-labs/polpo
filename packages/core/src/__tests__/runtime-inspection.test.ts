import { describe, expect, it } from "vitest";
import {
  createRuntimeContextAccounting,
  normalizeRuntimeContextAccountingSegmentCategory,
} from "../runtime-inspection/index.js";
import {
  RUNTIME_CONTEXT_ACCOUNTING_SEGMENT_KINDS,
  RUNTIME_CONTEXT_SEGMENT_KINDS,
} from "../index.js";

describe("runtime context accounting", () => {
  it("aggregates prompt, tool, conversation, attachment, and retrieval segments", () => {
    const accounting = createRuntimeContextAccounting([
      {
        id: "base",
        label: "Core instructions",
        category: "instructions",
        kind: "prompt",
        tokens: 120,
        characters: 480,
      },
      {
        id: "memory",
        label: "Memory",
        category: "memory",
        kind: "retrieval",
        tokens: 30,
        items: 3,
      },
      {
        id: "tools",
        label: "Tool definitions",
        category: "tools",
        kind: "tool-schema",
        tokens: 75,
        items: 5,
      },
      {
        id: "history",
        label: "Conversation",
        category: "conversation",
        kind: "message",
        tokens: 40,
      },
      {
        id: "files",
        label: "Attachments",
        category: "attachments",
        kind: "attachment",
        tokens: 20,
        items: 2,
      },
    ]);

    expect(accounting).toEqual({
      version: 1,
      segments: expect.any(Array),
      categories: [
        { category: "instructions", tokens: 120, segments: 1 },
        { category: "memory", tokens: 30, segments: 1 },
        { category: "tools", tokens: 75, segments: 1 },
        { category: "conversation", tokens: 40, segments: 1 },
        { category: "attachments", tokens: 20, segments: 1 },
      ],
      totals: {
        promptTokens: 120,
        toolSchemaTokens: 75,
        messageTokens: 40,
        attachmentTokens: 20,
        retrievalTokens: 30,
        totalTokens: 285,
      },
    });
    expect(Object.isFrozen(accounting)).toBe(true);
    expect(Object.isFrozen(accounting.segments)).toBe(true);
    expect(Object.isFrozen(accounting.segments[0])).toBe(true);
    expect(Object.isFrozen(accounting.categories)).toBe(true);
    expect(Object.isFrozen(accounting.totals)).toBe(true);
  });

  it("keeps Memory and Brain as separate inspector categories", () => {
    const accounting = createRuntimeContextAccounting([
      {
        id: "memory",
        label: "Agent memory",
        category: "memory",
        kind: "retrieval",
        tokens: 12,
      },
      {
        id: "brain",
        label: "Company Brain",
        category: "brain",
        kind: "retrieval",
        tokens: 31,
      },
    ]);

    expect(accounting.categories).toEqual([
      { category: "memory", tokens: 12, segments: 1 },
      { category: "brain", tokens: 31, segments: 1 },
    ]);
  });

  it("normalizes unknown future categories without crashing older inspectors", () => {
    expect(normalizeRuntimeContextAccountingSegmentCategory("future-category"))
      .toBe("other");
    expect(normalizeRuntimeContextAccountingSegmentCategory(null)).toBe("other");
    expect(normalizeRuntimeContextAccountingSegmentCategory("brain"))
      .toBe("brain");
  });

  it("keeps accounting and retrieval segment kinds distinct in the root API", () => {
    expect(RUNTIME_CONTEXT_ACCOUNTING_SEGMENT_KINDS).toContain("tool-schema");
    expect(RUNTIME_CONTEXT_SEGMENT_KINDS).toEqual(["memory", "brain"]);
  });

  it.each([
    {
      name: "negative tokens",
      segments: [{ id: "a", label: "A", category: "other", kind: "prompt", tokens: -1 }],
    },
    {
      name: "fractional tokens",
      segments: [{ id: "a", label: "A", category: "other", kind: "prompt", tokens: 1.5 }],
    },
    {
      name: "infinite tokens",
      segments: [{ id: "a", label: "A", category: "other", kind: "prompt", tokens: Infinity }],
    },
    {
      name: "empty id",
      segments: [{ id: "", label: "A", category: "other", kind: "prompt", tokens: 1 }],
    },
    {
      name: "empty label",
      segments: [{ id: "a", label: "", category: "other", kind: "prompt", tokens: 1 }],
    },
    {
      name: "duplicate ids",
      segments: [
        { id: "a", label: "A", category: "other", kind: "prompt", tokens: 1 },
        { id: "a", label: "B", category: "other", kind: "prompt", tokens: 1 },
      ],
    },
    {
      name: "non-boolean deferred marker",
      segments: [{
        id: "a",
        label: "A",
        category: "other",
        kind: "prompt",
        tokens: 1,
        deferred: "yes",
      }],
    },
  ])("rejects $name", ({ segments }) => {
    expect(() => createRuntimeContextAccounting(segments as never)).toThrow();
  });

  it("rejects totals that overflow JavaScript safe integers", () => {
    expect(() => createRuntimeContextAccounting([
      {
        id: "a",
        label: "A",
        category: "instructions",
        kind: "prompt",
        tokens: Number.MAX_SAFE_INTEGER,
      },
      {
        id: "b",
        label: "B",
        category: "instructions",
        kind: "prompt",
        tokens: 1,
      },
    ])).toThrow(/safe integer/i);
  });

  it("bounds the number of accounting segments", () => {
    const segments = Array.from({ length: 10_001 }, (_, index) => ({
      id: `segment-${index}`,
      label: `Segment ${index}`,
      category: "other" as const,
      kind: "prompt" as const,
      tokens: 0,
    }));
    expect(() => createRuntimeContextAccounting(segments)).toThrow(/at most/i);
  });

  it("does not retain caller-owned mutable segment objects", () => {
    const source = {
      id: "base",
      label: "Base",
      category: "instructions" as const,
      kind: "prompt" as const,
      tokens: 10,
    };
    const accounting = createRuntimeContextAccounting([source]);
    source.label = "Mutated";
    source.tokens = 999;

    expect(accounting.segments[0]).toMatchObject({ label: "Base", tokens: 10 });
  });
});
