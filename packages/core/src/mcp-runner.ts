import { z } from "zod";
import { ConnectionSelectionError } from "./connection-capability.js";
import type { ResolveMcpRuntimeCapabilities } from "./mcp-capability.js";
import { normalizeAgentIdentity } from "./agent-store.js";
import { createToolInvocationContext, type ToolInvocationContext } from "./tool-invocation.js";

export const MCP_RUNNER_LEASE_VERSION = 2;

export const MAX_MCP_RUNNER_REQUEST_BYTES = 256 * 1024;
export const MAX_MCP_RUNNER_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MCP_RUNNER_REQUEST_TIMEOUT_MS = 30_000;
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/);
const identifier = z.string().min(1).max(512).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));

/** Host-to-process bootstrap, never part of persisted RunnerConfig or model input.
 * The bearer authorizes a run lease, not a provider account or provider URL. */
export const McpRunnerLeasePayloadSchema = z.object({
  version: z.literal(MCP_RUNNER_LEASE_VERSION),
  url: z.string().min(1).max(2048),
  token: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/),
  sandboxId: identifier,
  agentName: identifier,
  agentIdentity: z.unknown().transform((value, context) => {
    try { return normalizeAgentIdentity(value); }
    catch { context.addIssue({ code: "custom", message: "Invalid agent identity" }); return z.NEVER; }
  }),
  runId: identifier,
  expiresAt: z.iso.datetime(),
}).strict().refine(value => value.agentIdentity.name === value.agentName, { message: "Mismatched agent identity" });
export type McpRunnerLeasePayload = z.infer<typeof McpRunnerLeasePayloadSchema>;

/** No identity, destination, credential or permission overrides from the runner. */
export const McpRunnerRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inventory") }).strict(),
  z.object({ operation: z.literal("call"), capability: z.string().min(1).max(1024),
    toolCallId: identifier, arguments: z.record(z.string(), z.unknown()) }).strict(),
]);
export type McpRunnerRequest = z.infer<typeof McpRunnerRequestSchema>;

export const McpRunnerInventorySchema = z.array(z.object({
  serverName: name,
  tools: z.array(z.object({ name, description: z.string().max(32_768).optional(),
    inputSchema: z.record(z.string(), z.unknown()) }).strict()).max(512),
}).strict()).max(128).superRefine((inventory, ctx) => {
  const servers = new Set<string>();
  const capabilities = new Set<string>();
  for (const entry of inventory) {
    if (servers.has(entry.serverName)) ctx.addIssue({ code: "custom", message: "Duplicate MCP namespace" });
    servers.add(entry.serverName);
    for (const tool of entry.tools) {
      const capability = `mcp__${entry.serverName}__${tool.name}`;
      if (capabilities.has(capability)) ctx.addIssue({ code: "custom", message: "Ambiguous MCP capability" });
      capabilities.add(capability);
    }
  }
});
export type McpRunnerInventory = z.infer<typeof McpRunnerInventorySchema>;

const unavailable = () => new ConnectionSelectionError("connection_scope_denied", "MCP capability is no longer available");
const failed = () => new Error("MCP broker request failed");
class McpDispatchLimitError extends Error {
  readonly code = "rate_limited";
  constructor(readonly retryAfterSeconds: number) {
    super(`Connection request limit exceeded; retry after ${retryAfterSeconds} seconds`);
  }
}

function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(unavailable()); return; }
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw unavailable();
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if ((!response.ok && response.status !== 429) || Number(response.headers.get("content-length")) > MAX_MCP_RUNNER_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw failed();
  }
  if (!response.body) throw failed();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await bounded(signal, () => reader.read());
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_MCP_RUNNER_RESPONSE_BYTES) throw failed();
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (response.status === 429) {
    const retry = envelope?.error?.retryAfterSeconds;
    if (envelope?.ok === false && envelope.error?.code === "rate_limited"
      && typeof retry === "number" && Number.isSafeInteger(retry) && retry >= 1 && retry <= 86400) {
      // Only this allowlisted code and validated integer may cross the broker.
      // Never reflect the remote message, details, URL or other envelope fields.
      throw new McpDispatchLimitError(retry);
    }
    throw failed();
  }
  if (!envelope || envelope.ok !== true || !Object.hasOwn(envelope, "data")
    || Object.keys(envelope).some(key => key !== "ok" && key !== "data")) throw failed();
  return envelope.data;
}

/** Remote implementation of the process-local MCP port. Provider refresh,
 * account selection and native MCP sessions stay on the trusted broker. */
export function createRemoteMcpRuntimeCapabilities(
  input: McpRunnerLeasePayload,
  options: { fetch?: typeof globalThis.fetch; allowLoopbackHttp?: boolean } = {},
): ResolveMcpRuntimeCapabilities {
  const parsed = McpRunnerLeasePayloadSchema.safeParse(input);
  if (!parsed.success) throw failed();
  const lease = Object.freeze(parsed.data);
  let url: URL;
  try { url = new URL(lease.url); } catch { throw failed(); }
  const loopback = options.allowLoopbackHttp && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) throw failed();
  const endpoint = url.toString();
  const fetcher = options.fetch ?? globalThis.fetch;
  const expiresAt = Date.parse(lease.expiresAt);
  const assertActive = () => { if (expiresAt <= Date.now()) throw unavailable(); };
  const assertInvocation = (value: ToolInvocationContext) => {
    let invocation: ToolInvocationContext;
    try { invocation = createToolInvocationContext(value); } catch { throw unavailable(); }
    if (invocation.runId !== lease.runId || invocation.agent?.name !== lease.agentIdentity.name
      || invocation.agent.incarnation !== lease.agentIdentity.incarnation) throw unavailable();
  };
  const send = async (request: McpRunnerRequest, signals: readonly (AbortSignal | undefined)[] = []) => {
    assertActive();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, Math.min(MCP_RUNNER_REQUEST_TIMEOUT_MS, expiresAt - Date.now()));
    for (const signal of signals) {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }
    try {
      const body = JSON.stringify(McpRunnerRequestSchema.parse(request));
      if (new TextEncoder().encode(body).byteLength > MAX_MCP_RUNNER_REQUEST_BYTES) throw failed();
      const response = await bounded(controller.signal, async () => {
        const response = await fetcher(endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${lease.token}`, "x-polpo-sandbox-id": lease.sandboxId },
        body,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        return response;
      });
      return await responseJson(response, controller.signal);
    } catch (error) {
      // No response body, raw URL, fetch exception or bearer in model-visible errors.
      if (!controller.signal.aborted && error instanceof McpDispatchLimitError) throw error;
      throw controller.signal.aborted ? unavailable() : failed();
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener("abort", abort);
    }
  };
  return async input => {
    assertActive();
    if (input.agentName !== lease.agentName) throw unavailable();
    assertInvocation(input.invocation);
    const parsedInventory = McpRunnerInventorySchema.safeParse(await send({ operation: "inventory" }, [input.signal]));
    if (!parsedInventory.success) throw failed();
    return Object.fromEntries(parsedInventory.data.map(entry => [entry.serverName, {
      tools: entry.tools,
      resolver: {
        resolve: async request => {
          assertActive();
          assertInvocation(request.invocation);
          if (request.signal?.aborted || request.serverName !== entry.serverName
            || !entry.tools.some(tool => tool.name === request.toolName)) throw unavailable();
          const controller = new AbortController();
          const capability = `mcp__${entry.serverName}__${request.toolName}`;
          const toolCallId = request.toolCallId;
          const signal = request.signal;
          let used = false;
          return {
            async call(arguments_: Record<string, unknown>) {
              if (used || controller.signal.aborted) throw unavailable();
              used = true;
              return send({ operation: "call", capability, toolCallId, arguments: arguments_ }, [signal, controller.signal]);
            },
            dispose: () => controller.abort(),
          };
        },
      },
    }]));
  };
}
