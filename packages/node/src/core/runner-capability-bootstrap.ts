import { createRemoteDataClient, type DataClient } from "@polpo-ai/core/data";
import type { Readable } from "node:stream";
import {
  createRemoteMcpRuntimeCapabilities, RunnerCapabilityBootstrapPayloadSchema,
  MAX_RUNNER_CAPABILITY_BOOTSTRAP_BYTES, RUNNER_CAPABILITY_BOOTSTRAP_TIMEOUT_MS,
  type RunnerCapabilityBootstrapPayload, type ResolveMcpRuntimeCapabilities,
  normalizeAgentIdentity, type RunnerConfig,
} from "@polpo-ai/core";

const failed = () => new Error("Runner capability bootstrap failed");

/** The sandbox host must disable stdin echo and wait for readiness before a
 * single delivery. Read a frame, never EOF: session providers keep stdin open.
 * No payload is written to env, disk, config, stdout, stderr or error causes. */
export function readRunnerCapabilities(input: Readable, onReady: () => void): Promise<RunnerCapabilityBootstrapPayload> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.pause();
      input.removeListener("data", data);
      input.removeListener("end", invalid);
      input.removeListener("error", invalid);
      input.removeListener("close", invalid);
      buffered = Buffer.alloc(0);
    };
    const invalid = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failed());
    };
    const data = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (buffered.length + bytes.length > MAX_RUNNER_CAPABILITY_BOOTSTRAP_BYTES) { invalid(); return; }
      buffered = Buffer.concat([buffered, bytes]);
      const newline = buffered.indexOf(10);
      if (newline < 0) return;
      try {
        if (buffered.subarray(newline + 1).toString("utf8").trim()) { invalid(); return; }
        const result = RunnerCapabilityBootstrapPayloadSchema.safeParse(JSON.parse(buffered.subarray(0, newline).toString("utf8")));
        if (!result.success || (result.data.mcp && Date.parse(result.data.mcp.expiresAt) <= Date.now())) { invalid(); return; }
        settled = true;
        cleanup();
        resolve(Object.freeze(result.data));
      } catch { invalid(); }
    };
    const timer = setTimeout(invalid, RUNNER_CAPABILITY_BOOTSTRAP_TIMEOUT_MS);
    input.on("data", data);
    input.once("end", invalid);
    input.once("error", invalid);
    input.once("close", invalid);
    try { onReady(); } catch { invalid(); }
  });
}

/** Validate every binding before constructing either port. Null Data means the
 * host explicitly granted none, so executeRun must not consult ambient env. */
export function bindRunnerCapabilities(
  input: unknown,
  config: Pick<RunnerConfig, "runId" | "agentIdentity" | "toolInvocation"> & { agent: { name: string } },
): { data: DataClient | null; resolveMcpCapabilities?: ResolveMcpRuntimeCapabilities } {
  const parsed = RunnerCapabilityBootstrapPayloadSchema.safeParse(input);
  if (!parsed.success) throw failed();
  const payload = parsed.data;
  if (payload.runId !== config.runId || payload.agentName !== config.agent.name
    || (payload.mcp && Date.parse(payload.mcp.expiresAt) <= Date.now())) throw failed();
  try {
    const identity = config.agentIdentity ? normalizeAgentIdentity(config.agentIdentity) : undefined;
    if (identity?.name !== payload.agentIdentity?.name || identity?.incarnation !== payload.agentIdentity?.incarnation
      || (identity && identity.name !== config.agent.name)
      || (config.toolInvocation?.agent && (config.toolInvocation.agent.name !== identity?.name
        || config.toolInvocation.agent.incarnation !== identity?.incarnation))
      || (config.toolInvocation && config.toolInvocation.runId !== config.runId)) throw failed();
    const resolveMcpCapabilities = payload.mcp ? createRemoteMcpRuntimeCapabilities(payload.mcp) : undefined;
    const data = payload.data ? createRemoteDataClient({ url: payload.data.url, token: payload.data.token,
      headers: { "x-polpo-sandbox-id": payload.data.sandboxId } }) : null;
    return { data, resolveMcpCapabilities };
  } catch { throw failed(); }
}
