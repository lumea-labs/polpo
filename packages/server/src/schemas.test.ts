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
});
