/**
 * Canonical model/journal text. PostgreSQL TEXT cannot represent U+0000 and
 * JSON transports reject lone UTF-16 surrogates. Make those code units visible
 * without dropping data; leave valid Unicode and existing escape sequences intact.
 */
export function normalizeToolOutputText(text: string): string {
  return text.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Bridge structured tools/MCP to the existing string executor contract. */
export function renderToolResult(result: unknown): string {
  if (typeof result === "string") return normalizeToolOutputText(result);
  if (result === null || result === undefined) return "";
  if (typeof result !== "object") return normalizeToolOutputText(String(result));
  const value = result as { content?: unknown; details?: { error?: unknown }; isError?: unknown };
  const text = Array.isArray(value.content)
    ? value.content.filter(part => part?.type === "text" && typeof part.text === "string")
        .map(part => part.text).join("\n")
    : "";
  // Preserve the existing built-in details.error contract as well as MCP isError.
  // Never copy arbitrary error metadata into the public transcript.
  const isError = value.isError === true || Boolean(value.details?.error);
  const rendered = isError && !text.startsWith("Error:")
    ? `Error: ${text || "Tool execution failed"}` : text;
  return normalizeToolOutputText(rendered);
}
