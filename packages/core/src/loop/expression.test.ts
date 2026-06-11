import { describe, it, expect } from "vitest";
import { evaluateExpression, SafeExpressionEvaluator } from "./expression.js";

const ctx = {
  data: { task: { assignTo: "deployer", status: "done" }, mission: { allPassed: true } },
  task: { assignTo: "deployer", status: "done" },
  mission: { allPassed: true },
  assess: { riskClass: "substandard", score: 0.42 },
  build: { passed: true, attempts: 3 },
};

describe("evaluateExpression", () => {
  it("empty → true (unconditional)", () => {
    expect(evaluateExpression(undefined, ctx)).toBe(true);
    expect(evaluateExpression("  ", ctx)).toBe(true);
  });

  it("strict === / !== (gate-style)", () => {
    expect(evaluateExpression("task.assignTo === 'deployer'", ctx)).toBe(true);
    expect(evaluateExpression("task.assignTo !== 'coder'", ctx)).toBe(true);
    expect(evaluateExpression("task.status === 'pending'", ctx)).toBe(false);
  });

  it("loose == / != with nullish (x != null = 'is set')", () => {
    expect(evaluateExpression("assess.riskClass != null", ctx)).toBe(true);
    expect(evaluateExpression("assess.missing != null", ctx)).toBe(false);
    expect(evaluateExpression("assess.missing == null", ctx)).toBe(true);
  });

  it("numeric comparisons + boolean precedence + parens", () => {
    expect(evaluateExpression("build.attempts >= 5", ctx)).toBe(false);
    expect(evaluateExpression("assess.score <= 0.5 && build.passed == true", ctx)).toBe(true);
    expect(evaluateExpression("build.passed == false || assess.riskClass == 'substandard'", ctx)).toBe(true);
    expect(evaluateExpression("false || true && false", {})).toBe(false);
    expect(evaluateExpression("(false || true) && true", {})).toBe(true);
    expect(evaluateExpression("!(task.status === 'pending')", ctx)).toBe(true);
  });

  it("nested data paths (gate payload shape)", () => {
    expect(evaluateExpression("data.task.assignTo === 'deployer'", ctx)).toBe(true);
    expect(evaluateExpression("data.mission.allPassed == true", ctx)).toBe(true);
  });

  it("is NOT eval — no globals, no function calls", () => {
    expect(evaluateExpression("process != null", ctx)).toBe(false); // path miss, not the Node global
    expect(() => evaluateExpression("constructor('return process')", ctx)).toThrow();
    expect(() => evaluateExpression("task.assignTo.length > 0", ctx)).not.toThrow(); // .length is just a path → undefined
    expect(evaluateExpression("task.assignTo.length > 0", ctx)).toBe(false);
  });

  it("throws on malformed expressions", () => {
    expect(() => evaluateExpression("build.passed ==", ctx)).toThrow();
    expect(() => evaluateExpression("&&&", ctx)).toThrow();
  });
});

describe("SafeExpressionEvaluator (fail-closed wrapper)", () => {
  const ev = new SafeExpressionEvaluator();
  it("malformed → false (never throws)", () => {
    expect(ev.evaluate("build.passed ==", ctx)).toBe(false);
    expect(ev.evaluate("task.assignTo === 'deployer'", ctx)).toBe(true);
  });
});
