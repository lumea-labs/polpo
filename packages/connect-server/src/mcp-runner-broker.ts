import {
  ConnectionSelectionError, createToolInvocationContext,
  McpRunnerRequestSchema, McpRunnerInventorySchema,
  MAX_MCP_RUNNER_REQUEST_BYTES, MAX_MCP_RUNNER_RESPONSE_BYTES, MCP_RUNNER_REQUEST_TIMEOUT_MS,
  type McpCapabilityTool, type ResolveMcpRuntimeCapabilities,
  type ResolvedMcpCapability, type ToolInvocationContext,
} from "@polpo-ai/core";
import { isDeepStrictEqual } from "node:util";
import { ConnectError } from "@polpo-ai/connect";

export class McpRunnerBrokerError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 408 | 409 | 413 | 429 | 503) {
    super("MCP broker request failed");
    this.name = "McpRunnerBrokerError";
  }
}

/** Created from trusted lease storage, never reconstructed from runner input. */
export interface AuthorizedMcpRunnerLease {
  readonly agentName: string;
  readonly invocation: ToolInvocationContext;
  readonly inventory: readonly { readonly serverName: string; readonly tools: readonly McpCapabilityTool[] }[];
  /** Must retain the minted grant ceiling and check assertActive during native
   * transport authorization, including refresh. Uses the canonical MCP resolver. */
  readonly resolveCapabilities: ResolveMcpRuntimeCapabilities;
  /** Live lease/run-generation, cancellation and host rollout authorization. */
  assertActive(): Promise<void>;
  /** Atomic, durable for the lease lifetime. A repeated ID must throw 409 even
   * after a failed or disconnected call: mutations are never implicitly retried. */
  claimCall(toolCallId: string): Promise<void>;
}

/** HTTP-neutral server entry, reusable by OSS hosts and managed adapters. The
 * host owns opaque token storage, tenant identity and the run lifecycle. */
export function createMcpRunnerBroker(options: {
  authorize(token: string, sandboxId: string): Promise<AuthorizedMcpRunnerLease>;
  onError?: (error: unknown) => void | Promise<void>;
}): (request: Request) => Promise<Response> {
  const report = (error: unknown) => {
    try { void Promise.resolve(options.onError?.(error)).catch(() => undefined); } catch { /* host diagnostics */ }
  };
  const json = (data: unknown, status = 200) => {
    const body = JSON.stringify(data);
    if (new TextEncoder().encode(body).byteLength > MAX_MCP_RUNNER_RESPONSE_BYTES) throw new McpRunnerBrokerError(413);
    return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  };
  return async request => {
    if (request.method !== "POST") return json({ ok: false, error: { code: "mcp_broker_denied" } }, 405);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, MCP_RUNNER_REQUEST_TIMEOUT_MS);
    const bounded = <T>(work: () => T | Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(new McpRunnerBrokerError(408)); return; }
      const cancelled = () => reject(new McpRunnerBrokerError(408));
      controller.signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new McpRunnerBrokerError(408);
        return work();
      }).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", cancelled));
    });
    let acquired: ResolvedMcpCapability | undefined;
    const disposed = new WeakSet<ResolvedMcpCapability>();
    const dispose = async (capability: ResolvedMcpCapability) => {
      if (disposed.has(capability)) return;
      disposed.add(capability);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => capability.dispose()),
          new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 1_000); }),
        ]);
      } catch (error) { report(error); }
      finally { clearTimeout(cleanupTimer); }
    };
    try {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const sandboxId = request.headers.get("x-polpo-sandbox-id");
      if (!token || token.length > 512 || !sandboxId || sandboxId.length > 512) throw new McpRunnerBrokerError(401);
      const lease = await bounded(() => options.authorize(token, sandboxId));
      await bounded(() => lease.assertActive());
      if (Number(request.headers.get("content-length")) > MAX_MCP_RUNNER_REQUEST_BYTES) throw new McpRunnerBrokerError(413);
      if (!request.body) throw new McpRunnerBrokerError(400);
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await bounded(() => reader.read());
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_MCP_RUNNER_REQUEST_BYTES) throw new McpRunnerBrokerError(413);
          chunks.push(chunk.value);
        }
      } finally { void reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new McpRunnerBrokerError(400); }
      const parsed = McpRunnerRequestSchema.safeParse(raw);
      if (!parsed.success) throw new McpRunnerBrokerError(400);
      const inventory = McpRunnerInventorySchema.safeParse(lease.inventory);
      if (!inventory.success) throw new McpRunnerBrokerError(403);
      const invocation = createToolInvocationContext(lease.invocation);
      if (!invocation.agent || invocation.agent.name !== lease.agentName) throw new McpRunnerBrokerError(403);
      const operation = parsed.data;
      if (operation.operation === "inventory") return json({ ok: true, data: inventory.data });
      let selected: { serverName: string; tool: McpCapabilityTool } | undefined;
      for (const entry of inventory.data) for (const tool of entry.tools) {
        if (`mcp__${entry.serverName}__${tool.name}` === operation.capability) selected = { serverName: entry.serverName, tool };
      }
      if (!selected) throw new McpRunnerBrokerError(403);
      await bounded(() => lease.claimCall(operation.toolCallId));
      const providers = await bounded(() => lease.resolveCapabilities({ agentName: lease.agentName, invocation, signal: controller.signal }));
      const provider = Object.hasOwn(providers, selected.serverName) ? providers[selected.serverName] : undefined;
      const currentTool = provider?.tools.find(tool => tool.name === selected!.tool.name);
      if (!provider || !currentTool || currentTool.name !== selected.tool.name
        || currentTool.description !== selected.tool.description
        || !isDeepStrictEqual(currentTool.inputSchema, selected.tool.inputSchema)) throw new McpRunnerBrokerError(403);
      await bounded(() => lease.assertActive());
      const selectedName = selected.serverName;
      const selectedTool = selected.tool.name;
      await bounded(async () => {
        const capability = await provider.resolver.resolve({ serverName: selectedName, toolName: selectedTool,
          toolCallId: operation.toolCallId, invocation, signal: controller.signal });
        // Register before returning through bounded(): cancellation can win the
        // outer promise between this continuation and the caller's assignment.
        acquired = capability;
        if (controller.signal.aborted) { void dispose(capability); throw new McpRunnerBrokerError(408); }
        return capability;
      });
      await bounded(() => lease.assertActive());
      const capability = acquired;
      if (!capability) throw new McpRunnerBrokerError(503);
      const result = await bounded(() => capability.call(operation.arguments));
      return json({ ok: true, data: result ?? null });
    } catch (error) {
      report(error);
      if (error instanceof ConnectError && error.code === "rate_limited" && error.status === 429) {
        const value = (error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
        const retryAfterSeconds = typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 86400 ? value : 60;
        const response = json({ ok: false, error: { code: "rate_limited", message: "Connection request limit exceeded", retryAfterSeconds } }, 429);
        response.headers.set("retry-after", String(retryAfterSeconds));
        return response;
      }
      const status = error instanceof McpRunnerBrokerError ? error.status : error instanceof ConnectionSelectionError ? 403 : 503;
      return json({ ok: false, error: { code: "mcp_broker_denied", message: "MCP broker request failed" } }, status);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      controller.abort();
      if (acquired) await dispose(acquired);
    }
  };
}
