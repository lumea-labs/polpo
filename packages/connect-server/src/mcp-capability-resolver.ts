import { ConnectionSelectionError, createToolInvocationContext, type ConnectionSlotSpec, type McpCapabilityResolver,
  type McpCapabilityResolveInput } from "@polpo-ai/core";
import { createConnectionAccessResolver, type ConnectionAccessResolverOptions,
  type ConnectionRecord, type SelectedConnectionAccess } from "@polpo-ai/connect";
import { callRemoteMcpTool } from "./mcp-execution.js";

export interface McpConnectionEndpoint {
  url: string;
  transport?: "http" | "sse";
}

export interface ConnectionMcpCapabilityResolverOptions extends ConnectionAccessResolverOptions {
  resolveSpec(input: McpCapabilityResolveInput): ConnectionSlotSpec | Promise<ConnectionSlotSpec>;
  /** Resolve from the installed Connector/Connection, never the authored agent URL. */
  resolveEndpoint(connection: ConnectionRecord): McpConnectionEndpoint | Promise<McpConnectionEndpoint>;
  /** Credential materialization/refresh remains owned by the Connect service. */
  resolveHeaders(connection: ConnectionRecord, input: McpCapabilityResolveInput): Promise<HeadersInit | undefined>;
  /** Host-only dispatch quota; receives the persisted selected account/context. */
  beforeDispatch?(connection: ConnectionRecord, input: McpCapabilityResolveInput): Promise<void>;
  timeoutMs?: number;
  /** Host transport seam; default transport validates and pins public DNS. */
  fetch?: typeof globalThis.fetch;
}

function endpointKey(endpoint: McpConnectionEndpoint): string {
  return JSON.stringify([new URL(endpoint.url).href, endpoint.transport ?? "http"]);
}

/** Share account and grant authorization with API capabilities while keeping
 * MCP lifecycle and tool calls native. One resolve owns one tool operation. */
export function createConnectionMcpCapabilityResolver(options: ConnectionMcpCapabilityResolverOptions): McpCapabilityResolver {
  const resolver = createConnectionAccessResolver(options);
  return {
    async resolve(original) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs!, 1), 30_000) : 30_000;
      // One deadline covers acquisition, host policy, refresh and execution.
      // Host adapters are not necessarily cancellable, so bound their waits too.
      const timeout = setTimeout(abort, timeoutMs);
      const cancelled = () => new ConnectionSelectionError("connection_scope_denied", "MCP invocation was cancelled or timed out");
      const bounded = <T>(work: () => T | Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        if (controller.signal.aborted) { reject(cancelled()); return; }
        const onAbort = () => reject(cancelled());
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw cancelled();
          return work();
        }).then(value => {
          if (controller.signal.aborted) reject(cancelled());
          else resolve(value);
        }, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
      });
      original.signal?.addEventListener("abort", abort, { once: true });
      if (original.signal?.aborted) controller.abort();
      let access: SelectedConnectionAccess | undefined;
      let consumed = false;
      const dispose = () => {
        clearTimeout(timeout);
        controller.abort();
        access?.dispose();
        original.signal?.removeEventListener("abort", abort);
      };
      try {
        const input = Object.freeze({ ...original, invocation: createToolInvocationContext(original.invocation), signal: controller.signal });
        const spec = await bounded(() => options.resolveSpec(input));
        access = await bounded(async () => {
          const selected = await resolver.acquire({ spec, slot: input.serverName,
          toolName: `mcp__${input.serverName}__${input.toolName}`, toolCallId: input.toolCallId,
          invocation: input.invocation, signal: controller.signal });
          if (controller.signal.aborted) { selected.dispose(); throw cancelled(); }
          return selected;
        });
        const acquired = access;
        const boundInput = Object.freeze({ ...input, invocation: acquired.input.invocation });
        const endpoint = Object.freeze({ ...await bounded(() => options.resolveEndpoint(acquired.connection)) });
        const identity = endpointKey(endpoint);
        const current = async () => {
          const connection = await bounded(() => acquired.current());
          if (endpointKey(await bounded(() => options.resolveEndpoint(connection))) !== identity) {
            throw new ConnectionSelectionError("connection_scope_denied", "The acquired MCP endpoint has changed");
          }
          return connection;
        };
        return {
          async call(arguments_) {
            if (consumed || controller.signal.aborted) throw new ConnectionSelectionError(
              "connection_scope_denied", "MCP capability is no longer active");
            consumed = true;
            try {
              await current();
              return await callRemoteMcpTool({ ...endpoint, name: boundInput.toolName, arguments: arguments_,
              signal: controller.signal, timeoutMs: options.timeoutMs, fetch: options.fetch,
              beforeDispatch: options.beforeDispatch ? async () => {
                const connection = await current();
                await bounded(() => options.beforeDispatch!(connection, boundInput));
                await current();
              } : undefined,
              authorize: async () => {
                const connection = await current();
                const headers = await bounded(() => options.resolveHeaders(connection, boundInput));
                // A refresh can yield long enough for a grant, binding, endpoint
                // or installation to change. Deny before sending the result.
                await current();
                return headers;
              },
              });
            } finally {
              dispose();
            }
          },
          dispose,
        };
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
