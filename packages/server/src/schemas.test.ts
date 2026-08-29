import { describe, expect, it } from "vitest";
import {
  AddAgentSchema,
  CreateTaskSchema,
  RuntimeSandboxSchema,
  UpdateAgentSchema,
  UpdateTaskSchema,
} from "./schemas.js";

const lifecycle = {
  isolation: "fresh" as const,
  lifecycle: {
    onRelease: "pool" as const,
    stopAfterIdleMinutes: 30,
    deleteAfterStopMinutes: 45,
  },
};

describe("shared runtime sandbox schema", () => {
  it("is reused by agent and task mutation surfaces", () => {
    expect(AddAgentSchema.parse({ name: "builder", sandbox: lifecycle }).sandbox)
      .toEqual(lifecycle);
    expect(UpdateAgentSchema.parse({ sandbox: lifecycle }).sandbox).toEqual(lifecycle);
    expect(CreateTaskSchema.parse({
      title: "Build",
      description: "Build the app",
      assignTo: "builder",
      sandbox: lifecycle,
    }).sandbox).toEqual(lifecycle);
    expect(UpdateTaskSchema.parse({ sandbox: lifecycle }).sandbox).toEqual(lifecycle);
  });

  it("accepts explicit project-scoped shared isolation", () => {
    expect(RuntimeSandboxSchema.parse({ isolation: "shared" })).toEqual({
      isolation: "shared",
    });
  });

  it("accepts strict named volume selections", () => {
    expect(RuntimeSandboxSchema.parse({
      volumes: [
        { name: "workspace", access: "read-write", writeBack: "auto" },
        { name: "reference-data", access: "read-only" },
      ],
    })).toEqual({
      volumes: [
        { name: "workspace", access: "read-write", writeBack: "auto" },
        { name: "reference-data", access: "read-only" },
      ],
    });
  });

  it.each([
    { volumes: null },
    { volumes: ["workspace"] },
    { volumes: [{ name: "" }] },
    { volumes: [{ name: "Workspace" }] },
    { volumes: [{ name: "../workspace" }] },
    { volumes: [{ name: "workspace", access: "owner" }] },
    { volumes: [{ name: "workspace", writeBack: "sometimes" }] },
    { volumes: [{ name: "workspace", access: "read-only", writeBack: "auto" }] },
    { volumes: [{ name: "workspace", unknown: true }] },
    { volumes: [{ name: "workspace" }, { name: "workspace" }] },
  ])("rejects malformed volume selection %#", (sandbox) => {
    expect(RuntimeSandboxSchema.safeParse(sandbox).success).toBe(false);
  });

  it.each([
    null,
    [],
    "fresh",
    { lifecycle: null },
    { lifecycle: [] },
    { lifecycle: { idleTtlMinutes: Number.NaN } },
    { lifecycle: { idleTtlMinutes: Number.POSITIVE_INFINITY } },
    { lifecycle: { onRelease: "destroy", idleTtlMinutes: 1 } },
    { lifecycle: { stopAfterIdleMinutes: 0 } },
    { lifecycle: { deleteAfterStopMinutes: -1 } },
    { lifecycle: { onRelease: "destroy", stopAfterIdleMinutes: 1 } },
    { lifecycle: { onRelease: "destroy", deleteAfterStopMinutes: 0 } },
    { lifecycle: { idleTtlMinutes: 30, stopAfterIdleMinutes: 30 } },
    { lifecycle: { idleTtlMinutes: 30, deleteAfterStopMinutes: 0 } },
  ])("rejects malformed policy %#", (sandbox) => {
    expect(RuntimeSandboxSchema.safeParse(sandbox).success).toBe(false);
  });
});

describe("agent create/update schema parity", () => {
  it("accepts authored fields on both mutation surfaces", () => {
    const authored = {
      role: "Builder",
      model: "openai/gpt-5",
      allowedPaths: ["/workspace"],
      allowedTools: ["bash"],
      maxTurns: 20,
      maxConcurrency: 2,
      reasoning: "high" as const,
      emailAllowedDomains: ["example.com"],
      mcpServers: {
        docs: { type: "http" as const, url: "https://example.com/mcp" },
      },
    };
    expect(AddAgentSchema.parse({ name: "builder", ...authored }))
      .toMatchObject(authored);
    expect(UpdateAgentSchema.parse(authored)).toMatchObject(authored);
  });

  it("rejects unsupported reasoning values consistently", () => {
    expect(AddAgentSchema.safeParse({ name: "builder", reasoning: "extreme" }).success)
      .toBe(false);
    expect(UpdateAgentSchema.safeParse({ reasoning: "extreme" }).success)
      .toBe(false);
  });

  it.each(["auto", "direct", "progressive"] as const)(
    "accepts the %s agent tool-loading mode on create and update",
    (mode) => {
      const toolLoading = { mode };

      expect(AddAgentSchema.parse({ name: "builder", toolLoading }).toolLoading)
        .toEqual(toolLoading);
      expect(UpdateAgentSchema.parse({ toolLoading }).toolLoading)
        .toEqual(toolLoading);
    },
  );

  it.each([
    null,
    {},
    { mode: null },
    { mode: "model-controlled" },
    { mode: "automatic" },
    { mode: "auto", unknown: true },
  ])("rejects malformed agent tool-loading settings %#", (toolLoading) => {
    expect(AddAgentSchema.safeParse({ name: "builder", toolLoading }).success)
      .toBe(false);
    expect(UpdateAgentSchema.safeParse({ toolLoading }).success).toBe(false);
  });

  it("accepts typed Memory capabilities on create and update", () => {
    const memory = {
      tools: {
        search: true,
        remember: true,
        update: true,
        forget: true,
        writeScope: "invocation-user" as const,
        writableKinds: ["fact", "preference"] as const,
      },
    };

    expect(AddAgentSchema.parse({ name: "support", memory }).memory)
      .toEqual(memory);
    expect(UpdateAgentSchema.parse({ memory }).memory).toEqual(memory);
  });

  it.each([
    null,
    [],
    { unknown: true },
    { tools: null },
    { tools: [] },
    { tools: { unknown: true } },
    { tools: { search: "yes" } },
    { tools: { writeScope: "project" } },
    { tools: { writableKinds: ["secret"] } },
    { tools: { remember: true } },
    { tools: { forget: true, writableKinds: [] } },
  ])("rejects malformed typed Memory settings %#", (memory) => {
    expect(AddAgentSchema.safeParse({ name: "support", memory }).success)
      .toBe(false);
    expect(UpdateAgentSchema.safeParse({ memory }).success).toBe(false);
  });
});

describe("agent chat interaction schema", () => {
  it("accepts agent-scoped chat preferences on create and update", () => {
    const chat = {
      allowUserQuestions: false,
      suggestions: {
        enabled: true,
        maxItems: 4,
        guidance: "Prefer concrete next actions.",
      },
    } as const;

    expect(AddAgentSchema.parse({ name: "support", chat }).chat).toEqual(chat);
    expect(UpdateAgentSchema.parse({ chat }).chat).toEqual(chat);
  });

  it("accepts per-chat and per-channel tool restrictions", () => {
    const input = {
      allowedTools: ["read", "bash", "ask_user_question"],
      chat: { allowedTools: ["read", "ask_user_question"] },
      channels: { allowedTools: ["ask_user_question"] },
    };

    expect(AddAgentSchema.parse({ name: "policy-agent", ...input })).toMatchObject(input);
    expect(UpdateAgentSchema.parse(input)).toMatchObject(input);
  });

  it.each([
    null,
    [],
    { unknown: true },
    { allowUserQuestions: "yes" },
    { suggestions: null },
    { suggestions: { enabled: "yes" } },
    { suggestions: { maxItems: 1 } },
    { suggestions: { maxItems: 5 } },
    { suggestions: { guidance: "x".repeat(501) } },
    { suggestions: { unknown: true } },
  ])("rejects malformed agent chat preferences %#", (chat) => {
    expect(UpdateAgentSchema.safeParse({ chat }).success).toBe(false);
  });
});
