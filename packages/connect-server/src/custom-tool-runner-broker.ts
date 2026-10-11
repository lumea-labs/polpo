import {
  createToolInvocationContext, CustomToolRunnerRequestSchema, CustomToolRunnerInventorySchema,
  CustomToolRunnerResultSchema, MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES, MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES,
  CUSTOM_TOOL_RUNNER_INVENTORY_TIMEOUT_MS, CUSTOM_TOOL_RUNNER_CALL_TIMEOUT_MS,
  type CustomToolRunnerInventory, type ResolveCustomTools, type ToolInvocationContext,
} from "@polpo-ai/core";
import { isDeepStrictEqual } from "node:util";

export class CustomToolRunnerBrokerError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 408 | 409 | 413 | 429 | 503) {
    super("Custom tool broker request failed");
    this.name = "CustomToolRunnerBrokerError";
  }
}

/** Host-owned lease, loaded using the opaque bearer and sandbox identity.
 * No provider secret or tenant executable belongs in this broker. */
export interface AuthorizedCustomToolRunnerLease {
  readonly agentName: string;
  readonly invocation: ToolInvocationContext;
  readonly inventory: Readonly<CustomToolRunnerInventory>;
  /** The host owns isolated execution and cancellation/cleanup. Its resolver
   * must also call assertActive after asynchronous preparation, immediately
   * before handing any credentials to tool code. */
  readonly resolveTools: ResolveCustomTools;
  /** Live expiry, run state, agent incarnation, lease generation and rollout. */
  assertActive(): Promise<void>;
  /** Atomically consumes the ID for the entire lease lifetime, including failed
   * calls. A repeated ID throws 409: mutation delivery is never retried. */
  claimCall(toolCallId: string): Promise<void>;
}

/** HTTP-neutral agent-run endpoint for OSS and managed hosts. This does not
 * expose a general integration API; only the host's fixed inventory is callable. */
export function createCustomToolRunnerBroker(options: {
  authorize(token: string, sandboxId: string): Promise<AuthorizedCustomToolRunnerLease>;
}): (request: Request) => Promise<Response> {
  const json = (data: unknown, status = 200) => {
    const body = JSON.stringify(data);
    if (new TextEncoder().encode(body).byteLength > MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES) throw new CustomToolRunnerBrokerError(413);
    return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  };
  return async request => {
    const denied = (status: number) => json({ ok: false, error: { code: "custom_tool_broker_denied", message: "Custom tool broker request failed" } }, status);
    if (request.method !== "POST") return denied(405);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    let timer = setTimeout(abort, CUSTOM_TOOL_RUNNER_INVENTORY_TIMEOUT_MS);
    const bounded = <T>(work: () => T | Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(new CustomToolRunnerBrokerError(408)); return; }
      const cancelled = () => reject(new CustomToolRunnerBrokerError(408));
      controller.signal.addEventListener("abort", cancelled, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new CustomToolRunnerBrokerError(408);
        return work();
      }).then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", cancelled));
    });
    try {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const sandboxId = request.headers.get("x-polpo-sandbox-id");
      if (!token || token.length > 512 || !sandboxId || sandboxId.length > 512) throw new CustomToolRunnerBrokerError(401);
      const lease = await bounded(() => options.authorize(token, sandboxId));
      await bounded(() => lease.assertActive());
      if (Number(request.headers.get("content-length")) > MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES) throw new CustomToolRunnerBrokerError(413);
      if (!request.body) throw new CustomToolRunnerBrokerError(400);
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await bounded(() => reader.read());
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES) throw new CustomToolRunnerBrokerError(413);
          chunks.push(chunk.value);
        }
      } finally { void reader.cancel().catch(() => undefined); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new CustomToolRunnerBrokerError(400); }
      const parsed = CustomToolRunnerRequestSchema.safeParse(raw);
      if (!parsed.success) throw new CustomToolRunnerBrokerError(400);
      // TypeBox schemas may carry internal symbol keys. Only their JSON schema
      // representation is part of the wire inventory or equality contract.
      const inventory = CustomToolRunnerInventorySchema.safeParse(JSON.parse(JSON.stringify(lease.inventory)));
      if (!inventory.success) throw new CustomToolRunnerBrokerError(403);
      const invocation = createToolInvocationContext(lease.invocation);
      if (!invocation.agent || invocation.agent.name !== lease.agentName) throw new CustomToolRunnerBrokerError(403);
      const operation = parsed.data;
      if (operation.operation === "inventory") return json({ ok: true, data: inventory.data });
      const selected = inventory.data.find(tool => tool.name === operation.toolName);
      if (!selected) throw new CustomToolRunnerBrokerError(403);
      await bounded(() => lease.claimCall(operation.toolCallId));
      clearTimeout(timer);
      timer = setTimeout(abort, CUSTOM_TOOL_RUNNER_CALL_TIMEOUT_MS);
      const tools = await bounded(() => lease.resolveTools({ agentName: lease.agentName, invocation,
        allowedTools: [selected.name], signal: controller.signal }));
      const candidates = tools.filter(tool => tool.name === selected.name);
      if (candidates.length !== 1) throw new CustomToolRunnerBrokerError(403);
      const tool = candidates[0];
      const current = CustomToolRunnerInventorySchema.safeParse(JSON.parse(JSON.stringify([{
        name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
        ...(tool.requiresSandbox === undefined ? {} : { requiresSandbox: tool.requiresSandbox }),
      }])));
      if (!current.success || !isDeepStrictEqual(current.data[0], selected)) throw new CustomToolRunnerBrokerError(403);
      await bounded(() => lease.assertActive());
      const result = await bounded(() => tool.execute(operation.toolCallId, operation.arguments, controller.signal));
      await bounded(() => lease.assertActive());
      const valid = CustomToolRunnerResultSchema.safeParse(result);
      if (!valid.success) throw new CustomToolRunnerBrokerError(503);
      return json({ ok: true, data: valid.data });
    } catch (error) {
      // Do not send host errors, raw transport causes, credentials or schemas.
      return denied(error instanceof CustomToolRunnerBrokerError ? error.status : 503);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };
}
