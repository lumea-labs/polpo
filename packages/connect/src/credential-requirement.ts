/** Explicit public access is the only credential-free mode. An old or unknown
 * MCP mode must not be diagnosed or resolved as an unauthenticated account. */
export function connectionRequiresSecret(connection: { authType: string; metadata?: Record<string, unknown> | null }): boolean {
  return connection.authType !== "none"
    && !(connection.authType === "mcp" && connection.metadata?.auth === "none");
}
