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
  lifecycle: { onRelease: "pool" as const, idleTtlMinutes: 30 },
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
  ])("rejects malformed policy %#", (sandbox) => {
    expect(RuntimeSandboxSchema.safeParse(sandbox).success).toBe(false);
  });
});
