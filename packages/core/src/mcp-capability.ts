import type { ToolInvocationContext } from "./tool-invocation.js";
import type { McpServerConfig } from "./types/agent.js";

/** Non-secret tool inventory verified by the host. Discovery grants no access. */
export interface McpCapabilityTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpCapabilityResolveInput {
  readonly serverName: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly invocation: ToolInvocationContext;
  readonly signal?: AbortSignal;
}

/** One acquired account and one authorized MCP operation. HTTP destinations,
 * credentials and physical Connection identifiers remain entirely host-owned. */
export interface ResolvedMcpCapability {
  call(arguments_: Record<string, unknown>): Promise<unknown>;
  dispose(): void | Promise<void>;
}

export interface McpCapabilityResolver {
  resolve(input: McpCapabilityResolveInput): Promise<ResolvedMcpCapability>;
}

export interface McpRuntimeCapabilityProvider {
  readonly tools: readonly McpCapabilityTool[];
  readonly resolver: McpCapabilityResolver;
  /** Host-only diagnostics; raw errors must never enter model tool results.
   * The host applies its own redaction before persisting audit/log records. */
  readonly onError?: (error: unknown, input: McpCapabilityResolveInput) => void | Promise<void>;
}

export type McpRuntimeCapabilities = Readonly<Record<string, McpRuntimeCapabilityProvider>>;

/** Process-local host port. Inventory is non-secret and authorizes no call. */
export type ResolveMcpRuntimeCapabilities = (input: {
  agentName: string;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  invocation: ToolInvocationContext;
  signal?: AbortSignal;
}) => McpRuntimeCapabilities | Promise<McpRuntimeCapabilities>;
