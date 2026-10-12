import { z } from "zod";
import { McpRunnerLeasePayloadSchema } from "./mcp-runner.js";
import { CustomToolRunnerLeasePayloadSchema } from "./custom-tool-runner.js";

export const RUNNER_CAPABILITY_BOOTSTRAP_ARGUMENT = "--capabilities-stdin";
export const RUNNER_CAPABILITY_BOOTSTRAP_VERSION = 3;
export const RUNNER_CAPABILITY_BOOTSTRAP_READY = "POLPO_RUNNER_CAPABILITIES_READY_V3";
export const MAX_RUNNER_CAPABILITY_BOOTSTRAP_BYTES = 16 * 1024;
export const RUNNER_CAPABILITY_BOOTSTRAP_TIMEOUT_MS = 30_000;

const identifier = z.string().min(1).max(512)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const gatewayUrl = z.string().min(1).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});

/** One host-to-runner frame. Data, MCP and custom-tool protocols stay separate.
 * Never persist this payload in RunnerConfig or expose it to the model. */
export const RunnerCapabilityBootstrapPayloadSchema = z.object({
  version: z.literal(RUNNER_CAPABILITY_BOOTSTRAP_VERSION),
  agentName: identifier,
  agentIdentity: McpRunnerLeasePayloadSchema.shape.agentIdentity.optional(),
  runId: identifier,
  sandboxId: identifier,
  mcp: McpRunnerLeasePayloadSchema.safeExtend({ url: gatewayUrl }).optional(),
  customTools: CustomToolRunnerLeasePayloadSchema.safeExtend({ url: gatewayUrl }).optional(),
  data: z.object({
    url: gatewayUrl,
    token: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),
    agentName: identifier,
    sandboxId: identifier,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (!value.mcp && !value.data && !value.customTools) context.addIssue({ code: "custom", message: "Missing runner capability" });
  for (const binding of [value.mcp, value.data, value.customTools]) {
    if (binding && (binding.agentName !== value.agentName || binding.sandboxId !== value.sandboxId)) {
      context.addIssue({ code: "custom", message: "Mismatched runner binding" });
    }
  }
  for (const binding of [value.mcp, value.customTools]) {
    if (binding && binding.runId !== value.runId) context.addIssue({ code: "custom", message: "Mismatched runner binding" });
    if (binding && (!value.agentIdentity || value.agentIdentity.incarnation !== binding.agentIdentity.incarnation)) {
      context.addIssue({ code: "custom", message: "Mismatched agent identity" });
    }
  }
  if (value.agentIdentity && value.agentIdentity.name !== value.agentName) {
    context.addIssue({ code: "custom", message: "Mismatched agent identity" });
  }
});
export type RunnerCapabilityBootstrapPayload = z.infer<typeof RunnerCapabilityBootstrapPayloadSchema>;
