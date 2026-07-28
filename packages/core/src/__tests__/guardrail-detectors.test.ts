import { describe, expect, it } from "vitest";
import {
  RuntimeGuardrailEngine,
  createBoundedValuePolicy,
  createCrossScopePolicy,
  createDestructiveOperationPolicy,
  createPrivateNetworkPolicy,
  createSecretPatternPolicy,
  createToolArgumentsPolicy,
  type RuntimeGuardrailPolicy,
} from "../guardrails/index.js";

const evaluate = async (
  policy: RuntimeGuardrailPolicy,
  input: Record<string, unknown>,
) => new RuntimeGuardrailEngine([policy], {
  createId: () => "decision",
}).evaluate(input as any);

describe("guardrail detectors", () => {
  it("redacts known secret shapes recursively without flagging ordinary ids", async () => {
    const policy = createSecretPatternPolicy({
      phases: ["tool.after"],
      action: "redact",
    });
    const result = await evaluate(policy, {
      phase: "tool.after",
      value: {
        normalId: "proj_1234567890",
        normalSkId: "sk-document-identifier-123456789",
        github: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        nested: ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature"],
      },
      context: {},
    });

    expect(result.value).toEqual({
      normalId: "proj_1234567890",
      normalSkId: "sk-document-identifier-123456789",
      github: "[REDACTED]",
      nested: ["Bearer [REDACTED]"],
    });
    expect(result.decisions).toHaveLength(1);
  });

  it("recognizes destructive shell and SQL but not safe read-only commands", async () => {
    const policy = createDestructiveOperationPolicy();
    const destructive = await evaluate(policy, {
      phase: "tool.before",
      value: { command: "rm -rf /" },
      tool: { name: "bash", sideEffect: "write" },
      context: {},
    });
    const sql = await evaluate(policy, {
      phase: "tool.before",
      value: { query: "DROP DATABASE production;" },
      tool: { name: "run_sql", sideEffect: "write" },
      context: {},
    });
    const safe = await evaluate(policy, {
      phase: "tool.before",
      value: { command: "git status --short" },
      tool: { name: "bash", sideEffect: "read" },
      context: {},
    });

    expect(destructive.terminalAction).toBe("approval");
    expect(sql.terminalAction).toBe("approval");
    expect(safe.decisions).toEqual([]);
  });

  it("blocks private, loopback, link-local, and metadata network targets", async () => {
    const policy = createPrivateNetworkPolicy();
    for (const url of [
      "http://localhost:3000/admin",
      "http://127.0.0.1:8080",
      "http://10.0.0.2",
      "http://172.16.0.1",
      "http://192.168.1.4",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://100.64.0.1/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "https://service.internal/resource",
    ]) {
      const result = await evaluate(policy, {
        phase: "tool.before",
        value: { url },
        tool: { name: "http_request", sideEffect: "read" },
        context: {},
      });
      expect(result.terminalAction, url).toBe("block");
    }
  });

  it("allows public targets and ignores URL-looking text for non-network tools", async () => {
    const policy = createPrivateNetworkPolicy();
    const publicResult = await evaluate(policy, {
      phase: "tool.before",
      value: { url: "https://api.example.com/v1" },
      tool: { name: "http_request", sideEffect: "read" },
      context: {},
    });
    const nonNetwork = await evaluate(policy, {
      phase: "tool.before",
      value: { text: "http://127.0.0.1 is documented here" },
      tool: { name: "write_file", sideEffect: "write" },
      context: {},
    });

    expect(publicResult.decisions).toEqual([]);
    expect(nonNetwork.decisions).toEqual([]);
  });

  it("blocks direct private host arguments without leaking URL credentials or query data", async () => {
    const policy = createPrivateNetworkPolicy();
    const directHost = await evaluate(policy, {
      phase: "tool.before",
      value: { hostname: "127.0.0.1", port: 8080 },
      tool: { name: "connect_api", sideEffect: "read" },
      context: {},
    });
    const credentialedUrl = await evaluate(policy, {
      phase: "tool.before",
      value: {
        url: "http://admin:private@127.0.0.1/secret?token=must-not-leak",
      },
      tool: { name: "http_request", sideEffect: "read" },
      context: {},
    });

    expect(directHost.terminalAction).toBe("block");
    expect(credentialedUrl.terminalAction).toBe("block");
    expect(credentialedUrl.decisions[0]?.reason).toContain("127.0.0.1");
    expect(credentialedUrl.decisions[0]?.reason).not.toContain("private");
    expect(credentialedUrl.decisions[0]?.reason).not.toContain("must-not-leak");
  });

  it("blocks malformed root schemas and missing required tool arguments", async () => {
    const policy = createToolArgumentsPolicy();
    const malformed = await evaluate(policy, {
      phase: "tool.before",
      value: {},
      tool: {
        name: "broken",
        sideEffect: "read",
        schema: { type: "string" },
      },
      context: {},
    });
    const missing = await evaluate(policy, {
      phase: "tool.before",
      value: {},
      tool: {
        name: "search",
        sideEffect: "read",
        schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      context: {},
    });
    const valid = await evaluate(policy, {
      phase: "tool.before",
      value: { query: "polpo" },
      tool: {
        name: "search",
        sideEffect: "read",
        schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      context: {},
    });

    expect(malformed.terminalAction).toBe("block");
    expect(missing.terminalAction).toBe("block");
    expect(valid.decisions).toEqual([]);
  });

  it("enforces nested JSON Schema constraints and rejects unknown properties", async () => {
    const policy = createToolArgumentsPolicy();
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 3 },
        filters: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              score: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["score"],
          },
        },
      },
      required: ["query", "filters"],
    };

    for (const value of [
      { query: "ok", filters: [{ score: 0.5 }] },
      { query: "valid", filters: [] },
      { query: "valid", filters: [{ score: 2 }] },
      { query: "valid", filters: [{ score: 0.5, extra: true }] },
      { query: "valid", filters: [{ score: 0.5 }], extra: true },
    ]) {
      const result = await evaluate(policy, {
        phase: "tool.before",
        value,
        tool: { name: "search", sideEffect: "read", schema },
        context: {},
      });
      expect(result.terminalAction, JSON.stringify(value)).toBe("block");
    }

    const valid = await evaluate(policy, {
      phase: "tool.before",
      value: { query: "valid", filters: [{ score: 0.5 }] },
      tool: { name: "search", sideEffect: "read", schema },
      context: {},
    });
    expect(valid.decisions).toEqual([]);
  });

  it("unwraps AI SDK JSON Schema containers, including deferred schemas", async () => {
    const policy = createToolArgumentsPolicy();
    const schema = {
      jsonSchema: Promise.resolve({
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
        },
        required: ["query"],
        additionalProperties: false,
      }),
    };
    const valid = await evaluate(policy, {
      phase: "tool.before",
      value: { query: "select 1" },
      tool: { name: "mcp__db__run_sql", sideEffect: "write", schema },
      context: {},
    });
    const missing = await evaluate(policy, {
      phase: "tool.before",
      value: {},
      tool: { name: "mcp__db__run_sql", sideEffect: "write", schema },
      context: {},
    });

    expect(valid.terminalAction).toBeUndefined();
    expect(missing.terminalAction).toBe("block");
    expect(missing.decisions[0]?.reason).toContain("query");
  });

  it("fails closed for cyclic or rejected schema wrappers", async () => {
    const policy = createToolArgumentsPolicy();
    const cyclic: Record<string, unknown> = {};
    cyclic.jsonSchema = cyclic;

    for (const schema of [
      cyclic,
      { jsonSchema: Promise.reject(new Error("schema unavailable")) },
    ]) {
      const result = await evaluate(policy, {
        phase: "tool.before",
        value: {},
        tool: { name: "write", sideEffect: "write", schema },
        context: {},
      });
      expect(result.terminalAction).toBe("block");
      expect(result.decisions[0]?.reason).toBe("Tool parameter schema is malformed");
    }
  });

  it("fails closed when a tool schema cannot be compiled", async () => {
    const result = await evaluate(createToolArgumentsPolicy(), {
      phase: "tool.before",
      value: { query: "hello" },
      tool: {
        name: "search",
        sideEffect: "read",
        schema: {
          type: "object",
          properties: {
            query: { $ref: "#/$defs/missing" },
          },
        },
      },
      context: {},
    });

    expect(result.terminalAction).toBe("block");
    expect(result.decisions[0]?.reason).toContain("could not be validated");
  });

  it("blocks cross-scope context and ignores absent scope metadata", async () => {
    const policy = createCrossScopePolicy();
    const mismatch = await evaluate(policy, {
      phase: "tool.before",
      value: {},
      context: {
        scope: {
          expected: { projectId: "project-a", userId: "user-a" },
          actual: { projectId: "project-b", userId: "user-a" },
        },
      },
    });
    const absent = await evaluate(policy, {
      phase: "tool.before",
      value: {},
      context: {},
    });

    expect(mismatch.terminalAction).toBe("block");
    expect(absent.decisions).toEqual([]);
  });

  it("blocks oversized values without serializing cycles forever", async () => {
    const policy = createBoundedValuePolicy({
      phases: ["context"],
      maxCharacters: 12,
    });
    const oversized = await evaluate(policy, {
      phase: "context",
      value: "1234567890123",
      context: {},
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycle = await evaluate(policy, {
      phase: "context",
      value: cyclic,
      context: {},
    });

    expect(oversized.terminalAction).toBe("block");
    expect(cycle.terminalAction).toBe("block");
  });
});
