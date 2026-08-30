import { describe, expect, it } from "vitest";
import {
  normalizeCanonicalTurnCommitted,
  type CanonicalTurnCommitted,
} from "./canonical-turn.js";

function turn(overrides: Partial<CanonicalTurnCommitted> = {}): CanonicalTurnCommitted {
  return {
    turnId: "turn-1",
    requestId: "request-1",
    runId: "run-1",
    sessionId: "session-1",
    agentName: "assistant",
    surface: "chat",
    terminalStatus: "succeeded",
    userMessage: { id: "user-message", role: "user" },
    assistantMessage: { id: "assistant-message", role: "assistant" },
    trustedInvocation: {
      externalUserId: "external-user",
      scope: { key: "site-1", version: "2" },
    },
    learningPolicy: {
      mode: "suggest",
      surfaces: ["chat", "channel"],
      kinds: ["fact", "preference"],
    },
    occurredAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("canonical turn contract", () => {
  it("normalizes and freezes identifier-only successful turn metadata", () => {
    const normalized = normalizeCanonicalTurnCommitted(turn({
      turnId: " turn-1 ",
      occurredAt: "2026-08-30T02:00:00+02:00",
    }));

    expect(normalized.turnId).toBe("turn-1");
    expect(normalized.occurredAt).toBe("2026-08-30T00:00:00.000Z");
    expect(normalized).not.toHaveProperty("content");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.trustedInvocation)).toBe(true);
    expect(Object.isFrozen(normalized.learningPolicy?.kinds)).toBe(true);
  });

  it("allows waiting and failed turns without an assistant message", () => {
    expect(normalizeCanonicalTurnCommitted(turn({
      terminalStatus: "waiting",
      assistantMessage: undefined,
    })).assistantMessage).toBeUndefined();
    expect(normalizeCanonicalTurnCommitted(turn({
      terminalStatus: "failed",
      assistantMessage: undefined,
    })).assistantMessage).toBeUndefined();
  });

  it.each([
    { surface: "task" },
    { terminalStatus: "done" },
    { terminalStatus: "succeeded", assistantMessage: undefined },
    { userMessage: { id: "user-message", role: "assistant" } },
    { trustedInvocation: { scope: { key: " " } } },
    { occurredAt: "not-a-date" },
    { learningPolicy: { mode: "off", surfaces: ["chat"], kinds: ["fact"] } },
    { learningPolicy: { mode: "suggest", surfaces: [], kinds: ["fact"] } },
    { learningPolicy: { mode: "suggest", surfaces: ["chat"], kinds: ["unknown"] } },
  ])("rejects malformed or unsupported turn metadata %#", (override) => {
    expect(() => normalizeCanonicalTurnCommitted(turn(
      override as Partial<CanonicalTurnCommitted>,
    ))).toThrow();
  });
});
