import { describe, expect, it, vi } from "vitest";
import { createSandboxVolumeCheckpointTool } from "../sandbox-volume-tools.js";

describe("createSandboxVolumeCheckpointTool", () => {
  it("checkpoints all eligible volumes when no name is supplied", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const tool = createSandboxVolumeCheckpointTool(checkpoint);

    await expect(tool.execute("call-1", {})).resolves.toMatchObject({
      details: { checkpointed: true },
    });
    expect(checkpoint).toHaveBeenCalledWith(undefined);
    expect(tool.requiresSandbox).toBe(true);
  });

  it("forwards an explicit volume name and propagates provider failures", async () => {
    const checkpoint = vi.fn(async () => {
      throw new Error("revision conflict");
    });
    const tool = createSandboxVolumeCheckpointTool(checkpoint);

    await expect(tool.execute("call-2", { volume: "workspace" }))
      .rejects.toThrow("revision conflict");
    expect(checkpoint).toHaveBeenCalledWith("workspace");
  });
});
