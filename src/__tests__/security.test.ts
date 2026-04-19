import { describe, it, expect } from "vitest";
import {
  redactAgentConfig,
  redactTeam,
  redactPolpoState,
  redactPolpoConfig,
  sanitizeTranscriptEntry,
  SENSITIVE_PARAM_RE,
} from "../server/security.js";
import type { AgentConfig, Team, PolpoState, PolpoConfig } from "../core/types.js";

// ── redactAgentConfig ──
// NOTE: Vault credentials are no longer stored on AgentConfig — they live
// in the encrypted vault store. redactAgentConfig is a pass-through now.

describe("redactAgentConfig", () => {
  it("returns agent unchanged (pass-through — vault no longer inline)", () => {
    const agent: AgentConfig = {
      name: "alice",
      role: "dev",
      identity: { displayName: "Alice", title: "Engineer" },
    };

    const result = redactAgentConfig(agent);
    expect(result).toBe(agent); // same reference — pass-through
    expect(result.name).toBe("alice");
    expect(result.role).toBe("dev");
    expect(result.identity?.displayName).toBe("Alice");
  });

  it("returns agent unchanged when no vault (still pass-through)", () => {
    const agent: AgentConfig = { name: "bob", role: "qa" };
    const result = redactAgentConfig(agent);
    expect(result).toBe(agent);
  });
});

// ── redactTeam ──

describe("redactTeam", () => {
  it("returns team unchanged (pass-through)", () => {
    const team: Team = {
      name: "alpha",
      agents: [
        { name: "a1" },
        { name: "a2", role: "dev" },
        { name: "a3" },
      ],
    };

    const result = redactTeam(team);
    expect(result).toBe(team); // same reference
    expect(result.name).toBe("alpha");
    expect(result.agents).toHaveLength(3);
  });
});

// ── redactPolpoState ──

describe("redactPolpoState", () => {
  it("returns state unchanged (pass-through)", () => {
    const state: PolpoState = {
      project: "test",
      teams: [{
        name: "t",
        agents: [{ name: "x" }],
      }],
      tasks: [],
      processes: [],
    };

    const result = redactPolpoState(state);
    expect(result).toBe(state); // same reference
    expect(result.project).toBe("test");
  });
});

// ── redactPolpoConfig ──

describe("redactPolpoConfig", () => {
  it("returns config as-is — providers no longer contain secrets", () => {
    const config = {
      version: "1",
      project: "test",
      teams: [{
        name: "t",
        agents: [{ name: "a" }],
      }],
      tasks: [],
      settings: { maxRetries: 3, workDir: ".", logLevel: "normal" as const },
      providers: {
        ollama: { baseUrl: "http://localhost:11434" },
        custom: { baseUrl: "https://my-vllm.example.com/v1", api: "openai-completions" as const },
      },
    } as PolpoConfig;

    const result = redactPolpoConfig(config);

    // Same reference — pass-through
    expect(result).toBe(config);
    expect(result.providers!.ollama.baseUrl).toBe("http://localhost:11434");
    expect(result.providers!.custom.baseUrl).toBe("https://my-vllm.example.com/v1");
  });

  it("handles config without providers", () => {
    const config = {
      version: "1",
      project: "test",
      teams: [{ name: "t", agents: [] }],
      tasks: [],
      settings: { maxRetries: 1, workDir: ".", logLevel: "quiet" as const },
    } as PolpoConfig;

    const result = redactPolpoConfig(config);
    expect(result).toBe(config);
    expect(result.providers).toBeUndefined();
  });
});

// ── sanitizeTranscriptEntry ──

describe("sanitizeTranscriptEntry", () => {
  it("redacts smtp_pass and Authorization in tool_use input", () => {
    const entry = {
      type: "tool_use",
      tool: "email_send",
      input: {
        to: "alice@example.com",
        subject: "Hello",
        smtp_pass: "secret123",
        auth_token: "Bearer xyz",
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    const input = result.input as Record<string, unknown>;
    expect(input.to).toBe("alice@example.com");
    expect(input.subject).toBe("Hello");
    expect(input.smtp_pass).toBe("[REDACTED]");
    expect(input.auth_token).toBe("[REDACTED]");
  });

  it("does not touch entry without sensitive input", () => {
    const entry = {
      type: "tool_use",
      tool: "read",
      input: { path: "/foo/bar.ts" },
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry); // same reference — unchanged
  });

  it("does not modify tool_result entries", () => {
    const entry = {
      type: "tool_result",
      toolId: "123",
      content: "password: abc123",
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry);
  });

  it("does not modify assistant entries", () => {
    const entry = {
      type: "assistant",
      text: "The password is secret",
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry);
  });

  it("handles tool_use without input", () => {
    const entry = { type: "tool_use", tool: "ls" };
    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry);
  });

  it("does not mutate original entry", () => {
    const entry = {
      type: "tool_use",
      tool: "http_fetch",
      input: { url: "https://api.example.com", api_key: "real-key" },
    };

    sanitizeTranscriptEntry(entry);
    expect((entry.input as any).api_key).toBe("real-key");
  });

  it("matches various sensitive parameter names", () => {
    for (const key of ["password", "secret", "token", "api_key", "auth_header", "credential_id", "smtp_pass"]) {
      expect(SENSITIVE_PARAM_RE.test(key)).toBe(true);
    }
    for (const key of ["url", "path", "to", "subject", "body", "method"]) {
      expect(SENSITIVE_PARAM_RE.test(key)).toBe(false);
    }
  });

  // ── Nested object redaction (Bug fix: previously only top-level keys) ──

  it("redacts secrets nested inside child objects", () => {
    const entry = {
      type: "tool_use",
      tool: "http_fetch",
      input: {
        url: "https://api.example.com",
        config: {
          password: "hunter2",
          database_token: "sk-secret-123",
          retries: 3,
        },
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    const input = result.input as Record<string, unknown>;
    expect(input.url).toBe("https://api.example.com");
    const config = input.config as Record<string, unknown>;
    expect(config.password).toBe("[REDACTED]");
    expect(config.database_token).toBe("[REDACTED]");
    expect(config.retries).toBe(3);
  });

  it("redacts secrets deeply nested (3+ levels)", () => {
    const entry = {
      type: "tool_use",
      tool: "deploy",
      input: {
        service: "web",
        env: {
          production: {
            credentials: {
              api_key: "real-key",
              secret: "real-secret",
            },
            region: "us-east-1",
          },
        },
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    const creds = ((result.input as any).env.production.credentials) as Record<string, unknown>;
    expect(creds.api_key).toBe("[REDACTED]");
    expect(creds.secret).toBe("[REDACTED]");
    expect((result.input as any).env.production.region).toBe("us-east-1");
  });

  it("redacts secrets inside arrays of objects", () => {
    const entry = {
      type: "tool_use",
      tool: "multi_request",
      input: {
        requests: [
          { url: "https://a.com", auth_token: "tok-1" },
          { url: "https://b.com", auth_token: "tok-2" },
          { url: "https://c.com" },
        ],
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    const requests = (result.input as any).requests as Array<Record<string, unknown>>;
    expect(requests[0].url).toBe("https://a.com");
    expect(requests[0].auth_token).toBe("[REDACTED]");
    expect(requests[1].auth_token).toBe("[REDACTED]");
    expect(requests[2].url).toBe("https://c.com");
  });

  it("handles mixed nesting: top-level + nested secrets", () => {
    const entry = {
      type: "tool_use",
      tool: "email",
      input: {
        smtp_pass: "top-level-secret",
        server: {
          auth_token: "nested-secret",
          host: "smtp.example.com",
        },
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    const input = result.input as Record<string, unknown>;
    expect(input.smtp_pass).toBe("[REDACTED]");
    expect((input.server as any).auth_token).toBe("[REDACTED]");
    expect((input.server as any).host).toBe("smtp.example.com");
  });

  it("does not mutate nested objects in original entry", () => {
    const entry = {
      type: "tool_use",
      tool: "deploy",
      input: {
        config: { password: "real-pass", host: "db.local" },
      },
    };

    sanitizeTranscriptEntry(entry);
    // Original must be untouched
    expect((entry.input as any).config.password).toBe("real-pass");
  });

  it("returns entry unchanged when nested objects have no secrets", () => {
    const entry = {
      type: "tool_use",
      tool: "deploy",
      input: {
        config: { host: "db.local", port: 5432 },
        options: { verbose: true },
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry); // same reference — no redaction needed
  });
});
