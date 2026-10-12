import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConnectError } from "@polpo-ai/connect";
import { withRemoteMcpClient, type RemoteMcpTransportInput } from "./mcp-transport.js";

export interface CallRemoteMcpToolInput extends Omit<RemoteMcpTransportInput, "headers" | "authorize"> {
  /** Name is fixed by the authorized capability, never chosen inside tool arguments. */
  name: string;
  arguments?: Record<string, unknown>;
  /** Must recheck the acquired Connection/grant and resolve current credentials. */
  authorize: () => Promise<HeadersInit | undefined>;
}

/** One bounded MCP call. Auth/refresh belong to Connect; the SDK may not start
 * OAuth or persist tokens. The host supplies the Connection-owned endpoint. */
export async function callRemoteMcpTool(input: CallRemoteMcpToolInput): Promise<CallToolResult> {
  if (typeof input.authorize !== "function" || typeof input.name !== "string" || !input.name.trim()
    || input.name.length > 256 || (input.arguments !== undefined && (!input.arguments
      || typeof input.arguments !== "object" || Array.isArray(input.arguments)))) {
    throw new ConnectError("invalid_request", "MCP execution requires a tool name, object arguments and host authorization");
  }
  return withRemoteMcpClient(input, async (client, signal) =>
    CallToolResultSchema.parse(await client.callTool({ name: input.name, arguments: input.arguments }, CallToolResultSchema, { signal })));
}
