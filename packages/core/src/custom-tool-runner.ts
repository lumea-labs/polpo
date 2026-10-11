import { z } from "zod";
import { Type } from "@sinclair/typebox";
import type { ResolveCustomTools } from "./adapter.js";
import { normalizeAgentIdentity } from "./agent-store.js";
import { createToolInvocationContext } from "./tool-invocation.js";

export const CUSTOM_TOOL_RUNNER_LEASE_VERSION = 1;
export const MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES = 8 * 1024 * 1024;
export const CUSTOM_TOOL_RUNNER_INVENTORY_TIMEOUT_MS = 30_000;
// The host applies each tool's narrower execution timeout. CLI and binary tools
// retain the existing 30-minute ceiling instead of inheriting MCP's 30 seconds.
export const CUSTOM_TOOL_RUNNER_CALL_TIMEOUT_MS = 30 * 60_000 + 30_000;
const identifier = z.string().min(1).max(512)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const name = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/);

/** Host-owned run authority. Never persisted in agent config or model schemas. */
export const CustomToolRunnerLeasePayloadSchema = z.object({
  version: z.literal(CUSTOM_TOOL_RUNNER_LEASE_VERSION),
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
export type CustomToolRunnerLeasePayload = z.infer<typeof CustomToolRunnerLeasePayloadSchema>;

/** Only intent crosses from the runner. Identity, Connection selection, grants,
 * tool source and execution mode are resolved by the trusted host. */
export const CustomToolRunnerRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("inventory") }).strict(),
  z.object({ operation: z.literal("call"), toolName: name, toolCallId: identifier,
    arguments: z.record(z.string(), z.unknown()) }).strict(),
]);
export type CustomToolRunnerRequest = z.infer<typeof CustomToolRunnerRequestSchema>;

export const CustomToolRunnerInventorySchema = z.array(z.object({
  name, label: z.string().max(1024), description: z.string().max(32_768),
  parameters: z.record(z.string(), z.unknown()), requiresSandbox: z.boolean().optional(),
}).strict()).max(512).superRefine((inventory, context) => {
  if (new Set(inventory.map(tool => tool.name)).size !== inventory.length) {
    context.addIssue({ code: "custom", message: "Duplicate custom tool" });
  }
});
export type CustomToolRunnerInventory = z.infer<typeof CustomToolRunnerInventorySchema>;

export const CustomToolRunnerResultSchema = z.object({
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict(),
  ])),
  details: z.unknown().optional(),
}).strict();

const failed = () => new Error("Custom tool broker request failed");
const unavailable = () => new Error("Custom tool capability is no longer available");

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
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw failed();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await bounded(signal, () => reader.read());
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES) throw failed();
      chunks.push(chunk.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (!envelope || envelope.ok !== true || !Object.hasOwn(envelope, "data")
    || Object.keys(envelope).some(key => key !== "ok" && key !== "data")) throw failed();
  return envelope.data;
}

/** Remote host port for sandboxed custom tools. A lease never authorizes a
 * public integration API: its inventory and lifetime belong to one agent run. */
export function createRemoteCustomTools(
  input: CustomToolRunnerLeasePayload,
  options: { fetch?: typeof globalThis.fetch; allowLoopbackHttp?: boolean } = {},
): ResolveCustomTools {
  const parsed = CustomToolRunnerLeasePayloadSchema.safeParse(input);
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
  const send = async (request: CustomToolRunnerRequest, signals: readonly (AbortSignal | undefined)[]) => {
    assertActive();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = request.operation === "inventory" ? CUSTOM_TOOL_RUNNER_INVENTORY_TIMEOUT_MS : CUSTOM_TOOL_RUNNER_CALL_TIMEOUT_MS;
    const timer = setTimeout(abort, Math.min(timeout, expiresAt - Date.now()));
    for (const signal of signals) {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }
    try {
      const body = JSON.stringify(CustomToolRunnerRequestSchema.parse(request));
      if (new TextEncoder().encode(body).byteLength > MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES) throw failed();
      const response = await bounded(controller.signal, async () => {
        const result = await fetcher(endpoint, { method: "POST", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${lease.token}`, "x-polpo-sandbox-id": lease.sandboxId }, body });
        if (controller.signal.aborted) {
          void result.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        return result;
      });
      return await responseJson(response, controller.signal);
    } catch { throw controller.signal.aborted ? unavailable() : failed(); }
    finally {
      clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener("abort", abort);
    }
  };
  return async input => {
    assertActive();
    if (input.agentName !== lease.agentName || !input.invocation) throw unavailable();
    try {
      const invocation = createToolInvocationContext(input.invocation);
      if (invocation.runId !== lease.runId || invocation.agent?.name !== lease.agentName
        || invocation.agent.incarnation !== lease.agentIdentity.incarnation) throw unavailable();
    } catch { throw unavailable(); }
    const inventory = CustomToolRunnerInventorySchema.safeParse(await send({ operation: "inventory" }, [input.signal]));
    if (!inventory.success) throw failed();
    const allowed = input.allowedTools ?? [];
    return inventory.data.filter(tool => allowed.includes("*") || allowed.includes(tool.name)).map(tool => ({
      ...tool, parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
      async execute(toolCallId, args, signal) {
        const arguments_ = z.record(z.string(), z.unknown()).safeParse(args);
        if (!arguments_.success) throw failed();
        const result = CustomToolRunnerResultSchema.safeParse(await send({ operation: "call", toolName: tool.name,
          toolCallId, arguments: arguments_.data }, [input.signal, signal]));
        if (!result.success) throw failed();
        return { content: result.data.content, details: result.data.details };
      },
    }));
  };
}
