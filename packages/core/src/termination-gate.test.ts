import { describe, expect, it } from "vitest";
import { TerminationGate, validateTerminationGatePolicy } from "./termination-gate.js";

const policy = { maxCycles: 2, maxDurationMs: 1000, maxTokens: 100 };

describe("termination state for Stop-hook continuations", () => {
  it("renders Stop hook feedback and counts cycles across a serialized resume", () => {
    const gate = new TerminationGate(policy, undefined, () => 10);
    gate.beginAttempt();
    expect(gate.decide({ action: "continue", feedback: "src/index.ts:3 missing import" }, 2))
      .toBe("Stop hook feedback:\nsrc/index.ts:3 missing import");
    const restored = new TerminationGate(policy, JSON.parse(JSON.stringify(gate.snapshot())), () => 20);
    restored.beginAttempt();
    restored.decide({ action: "continue", feedback: "second" }, 3);
    restored.beginAttempt();
    expect(() => restored.decide({ action: "continue", feedback: "third" }, 4)).toThrow(/cycles/);
  });

  it("never accepts an unvalidated result when an explicit budget is exhausted", () => {
    const gate = new TerminationGate(policy, undefined, () => 10);
    gate.beginAttempt();
    expect(() => gate.decide({ action: "continue", feedback: "repair" }, 0)).toThrow(/turns/);
    const tokens = new TerminationGate(policy, undefined, () => 10);
    tokens.recordUsage({ totalTokens: 100 });
    expect(() => tokens.assertAvailable()).toThrow(/tokens/);
    const elapsed = new TerminationGate(policy, { version: 1, cycles: 1, startedAt: 0, tokens: 3, attempts: 1, policy }, () => 1001);
    expect(() => elapsed.assertAvailable()).toThrow(/time/);
  });

  it("enforces no extra limit when the policy sets none (reference behavior)", () => {
    const gate = new TerminationGate({}, undefined, () => 10);
    expect(gate.remainingMs).toBe(Infinity);
    expect(gate.remainingTokens).toBe(Infinity);
    gate.recordUsage({});
    for (let cycle = 0; cycle < 50; cycle++) {
      gate.beginAttempt();
      expect(gate.decide({ action: "continue", feedback: "again" }, 10)).toContain("again");
    }
    gate.beginAttempt();
    expect(gate.decide({ action: "allow" }, 10)).toBeUndefined();
  });

  it("refuses corrupt checkpoints and keeps the more restrictive policy on resume", () => {
    expect(() => new TerminationGate(policy, { version: 1, cycles: -1 } as any)).toThrow();
    const gate = new TerminationGate(policy);
    const restored = new TerminationGate({ maxCycles: 20, maxDurationMs: 60_000, maxTokens: 5000 }, gate.snapshot());
    expect(restored.policy).toEqual(policy);
    expect(() => restored.recordUsage({})).toThrow(/usage/);
  });

  it("validates optional limits against their ceilings", () => {
    expect(validateTerminationGatePolicy({})).toEqual({});
    expect(validateTerminationGatePolicy({ maxCycles: 3 })).toEqual({ maxCycles: 3 });
    expect(() => validateTerminationGatePolicy({ maxCycles: 0 })).toThrow();
    expect(() => validateTerminationGatePolicy({ maxTokens: 1.5 })).toThrow();
  });
});
