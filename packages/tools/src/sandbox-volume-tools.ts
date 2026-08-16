import { Type } from "@sinclair/typebox";
import type { PolpoTool } from "@polpo-ai/core";

const SandboxVolumeCheckpointSchema = Type.Object({
  volume: Type.Optional(Type.String({
    minLength: 1,
    description: "Name of one attached hydrated volume. Omit to checkpoint every eligible volume.",
  })),
}, { additionalProperties: false });

/** Host-bound tool for explicit persistence of hydrated volume changes. */
export function createSandboxVolumeCheckpointTool(
  checkpoint: (name?: string) => Promise<void>,
): PolpoTool<typeof SandboxVolumeCheckpointSchema> {
  return {
    name: "sandbox_volume_checkpoint",
    label: "Checkpoint Sandbox Volume",
    description:
      "Persist changes made to manually managed hydrated sandbox volumes. "
      + "Call this after completing a consistent set of filesystem updates.",
    requiresSandbox: true,
    parameters: SandboxVolumeCheckpointSchema,
    async execute(_toolCallId, params) {
      await checkpoint(params.volume);
      return {
        content: [{
          type: "text",
          text: params.volume
            ? `Sandbox volume checkpointed: ${params.volume}`
            : "Sandbox volumes checkpointed.",
        }],
        details: {
          checkpointed: true,
          ...(params.volume ? { volume: params.volume } : {}),
        },
      };
    },
  };
}
