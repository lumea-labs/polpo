import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConnectError } from "@polpo-ai/connect";
import { withRemoteMcpClient, type RemoteMcpTransportInput } from "./mcp-transport.js";

export interface DiscoverRemoteMcpToolsInput extends RemoteMcpTransportInput {}

const MAX_TOOLS = 1000;
const MAX_PAGES = 20;
const failed = (category: string) => new ConnectError("http_error", "MCP discovery failed", { details: { category } });

/** Strict, read-only discovery. Transport failure is never an empty successful inventory. */
export async function discoverRemoteMcpTools(input: DiscoverRemoteMcpToolsInput): Promise<Tool[]> {
  return withRemoteMcpClient(input, async (client, signal) => {
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal });
      tools.push(...result.tools);
      if (tools.length > MAX_TOOLS) throw failed("inventory_too_large");
      if (!result.nextCursor) return tools;
      if (cursors.has(result.nextCursor)) throw failed("invalid_pagination");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw failed("inventory_too_large");
  });
}
