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
