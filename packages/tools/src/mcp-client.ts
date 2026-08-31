/**
 * Resolve MCP-server-provided tools for a single agent and adapt them to
 * Polpo's internal `PolpoTool` shape. This is the agent-side glue that
 * lets a Polpo agent declare `mcpServers` and have the resulting tools
 * appear next to its native ones (read/write/bash/...) with the same
 * runtime contract.
 *
 * Tools are namespaced as `mcp__<serverName>__<toolName>` so two servers
 * can both expose `read_file` (or whatever) without collision, mirroring
 * Claude Code's convention. The LLM picks the right one because the
 * server-prefixed name is unambiguous.
 *
 * Lifecycle: returns a `dispose()` that closes every opened transport.
 * Callers must invoke it once the request finishes (typically wired into
 * `streamText`'s `onFinish`). Skipping leaks file descriptors / open
 * HTTP keep-alives.
 *
 * Auth: header values support the existing `${vault:KEY}` template
 * syntax, resolved against the agent's vault entries. A missing vault
 * key surfaces as an `Error` so the agent runtime fails fast and visibly
 * — better than silently sending `Bearer ${vault:FOO}` to the server.
 *
 * Security: when an allowlist of hostnames is configured (env
 * `POLPO_MCP_ALLOWED_HOSTS`, comma-separated, supports `*.foo.com`
 * wildcards), HTTP/SSE servers outside the list are refused. Critical
 * in cloud to block SSRF / metadata-IP pivots; in self-host the
 * allowlist is unset and any host works.
 */

import type { PolpoTool, ToolResult } from "@polpo-ai/core";

/** A single MCP server config — mirrors the type in `@polpo-ai/sdk`. */
export type McpServerSpec =
  | {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/**
 * Minimal subset of the existing `ResolvedVault` interface we depend on.
 * Decoupled to keep `@polpo-ai/tools` from importing the shell's vault
 * resolver — callers pass in any object that conforms.
 */
export interface VaultLookup {
  getKey(service: string, key: string): string | undefined;
}

/**
 * Host-owned OAuth capability accepted by the MCP SDK transport. It is
 * deliberately separate from `McpServerSpec`: authored agent configuration
 * remains serializable and can never contain access or refresh tokens.
 */
export interface McpRuntimeOAuthProvider {
  tokens(): unknown | undefined | Promise<unknown | undefined>;
  saveTokens(tokens: any): void | Promise<void>;
  redirectToAuthorization(authorizationUrl: URL): void | Promise<void>;
  saveCodeVerifier(codeVerifier: string): void | Promise<void>;
  codeVerifier(): string | Promise<string>;
  readonly redirectUrl: string | URL;
  readonly clientMetadata: Record<string, unknown>;
  clientInformation(): unknown | undefined | Promise<unknown | undefined>;
  saveClientInformation?(clientInformation: any): void | Promise<void>;
  state?(): string | Promise<string>;
  saveState?(state: string): void | Promise<void>;
  storedState?(): string | undefined | Promise<string | undefined>;
  invalidateCredentials?(scope: "all" | "client" | "tokens" | "verifier"): void | Promise<void>;
  validateResourceURL?(serverUrl: string | URL, resource?: string): Promise<URL | undefined>;
}

export type McpRuntimeOAuthProviders = Readonly<Record<string, McpRuntimeOAuthProvider>>;

export interface ResolvedMcpTools {
  /** Polpo-format tools — drop straight into the agent's tool array. */
  tools: PolpoTool<any>[];
  /** Close every opened transport. Best-effort; idempotent. */
  dispose: () => Promise<void>;
}

/**
 * Replace `${vault:service:key}` placeholders in a string. Reuses the
 * existing service/key-credential model — the MCP credentials live in
 * the same vault as everything else (no parallel abstraction).
 *
 * Example: `Bearer ${vault:polpo:api_key}` resolves to the `api_key`
 * credential of the `polpo` vault entry.
 */
function applyVault(input: string, vault: VaultLookup | undefined): string {
  if (!vault) return input;
  return input.replace(
    /\$\{vault:([a-z0-9_-]+):([a-z0-9_-]+)\}/gi,
    (_, service, key) => {
      const value = vault.getKey(service, key);
      if (value === undefined) {
        throw new Error(
          `Vault credential "${service}:${key}" not found — required by MCP server config`,
        );
      }
      return value;
    },
  );
}

function resolveHeaders(
  headers: Record<string, string> | undefined,
  vault: VaultLookup | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = applyVault(v, vault);
  }
  return out;
}

function parseAllowedHosts(): string[] | null {
  const raw = process.env.POLPO_MCP_ALLOWED_HOSTS;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostAllowed(hostname: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === hostname) return true;
    if (p.startsWith("*.") && hostname.endsWith(p.slice(1))) return true;
  }
  return false;
}

/**
 * Adapt an AI SDK `Tool` (from `mcpClient.tools()`) into a Polpo
 * `PolpoTool`. The runtime contracts overlap on `description` + an input
 * schema + an executor; the wrapper bridges the small differences:
 *
 *  - AI SDK execute takes `(args, ctx)` and returns the raw server output
 *    (string, object, or `CallToolResult`). Polpo's executor returns
 *    `{ content: [{ type: "text", text }], details }`.
 *  - MCP can return image content; we pass it through verbatim when
 *    present so vision-capable agents can consume it.
 *  - Errors from the underlying transport bubble as `Error` text content
 *    — the agent loop already knows how to display tool errors.
 */
function adaptMcpTool(
  serverName: string,
  toolName: string,
  aiTool: any,
): PolpoTool<any> {
  return {
    name: `mcp__${serverName}__${toolName}`,
    label: toolName,
    description: aiTool.description ?? "",
    requiresSandbox: false,
    // AI SDK wraps schemas in a Zod/JSON Schema container; Polpo passes
    // the raw schema through to `jsonSchema()` downstream which accepts
    // arbitrary JSON-Schema-shaped objects, so this works without a
    // typebox conversion.
    parameters: aiTool.inputSchema as any,
    execute: async (toolCallId, params, signal) => {
      try {
        const raw = await aiTool.execute(params, {
          toolCallId,
          messages: [],
          abortSignal: signal,
        });
        return coerceMcpResult(raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `MCP tool error: ${message}` }],
          details: { error: message },
        } satisfies ToolResult;
      }
    },
  };
}

/**
 * MCP servers can return: a plain string, a structured object, or a
 * `CallToolResult` with a `content[]` array. Normalize into Polpo's
 * `ToolResult`. Pass image content through; serialize unknown shapes
 * as JSON so the LLM at least gets readable text.
 */
function coerceMcpResult(raw: unknown): ToolResult {
  if (raw == null) {
    return { content: [{ type: "text", text: "" }], details: null };
  }
  if (typeof raw === "string") {
    return { content: [{ type: "text", text: raw }], details: raw };
  }
  if (typeof raw === "object" && raw !== null && Array.isArray((raw as any).content)) {
    const content = ((raw as any).content as any[])
      .map((part) => {
        if (part?.type === "text" && typeof part.text === "string") {
          return { type: "text" as const, text: part.text };
        }
        if (part?.type === "image" && typeof part.data === "string") {
          return {
            type: "image" as const,
            data: part.data,
            mimeType: part.mimeType ?? "image/png",
          };
        }
        // Unknown content part — serialize so we don't lose information
        return { type: "text" as const, text: JSON.stringify(part) };
      })
      .filter(Boolean);
    return { content, details: raw };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(raw) }],
    details: raw,
  };
}

/**
 * Open every MCP server declared on the agent config. Returns the
 * aggregated Polpo tools + a single `dispose` that closes them all.
 *
 * Failures on individual servers are logged but don't abort the rest:
 * an agent with one broken MCP and one good one still gets the good
 * tools, with a console error pointing at the bad config.
 */
export async function resolveAgentMcpTools(
  agentName: string,
  mcpServers: Record<string, McpServerSpec> | undefined,
  vault: VaultLookup | undefined,
  runtimeOAuth?: McpRuntimeOAuthProviders,
): Promise<ResolvedMcpTools> {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return { tools: [], dispose: async () => {} };
  }

  // Lazy-loaded so projects that never use MCP don't pay the import cost
  // (the SDK pulls in @modelcontextprotocol/sdk transitively which is
  // non-trivial — a few hundred KB at module-init time).
  // Cast through any: vitest's vi.mock substitutes a single-arg factory
  // that doesn't match the published SDK's variadic typing. Runtime is
  // identical.
  const { createMCPClient } = (await import("@ai-sdk/mcp")) as any;

  const allowedHosts = parseAllowedHosts();
  const closers: Array<() => Promise<void>> = [];
  const tools: PolpoTool<any>[] = [];

  for (const [serverName, spec] of Object.entries(mcpServers)) {
    try {
      const authProvider = runtimeOAuth?.[serverName];
      if (authProvider && (spec.type === "stdio" || (spec as any).command)) {
        throw new Error("MCP OAuth is only supported for HTTP or SSE transports");
      }
      // Validate host upfront for HTTP/SSE — stdio is local-only and
      // already gated by the sandbox boundary.
      if (spec.type === "http" || spec.type === "sse") {
        if (allowedHosts) {
          const url = new URL(spec.url);
          if (!hostAllowed(url.hostname, allowedHosts)) {
            throw new Error(
              `MCP host "${url.hostname}" not in POLPO_MCP_ALLOWED_HOSTS`,
            );
          }
        }
      }

      let transport: any;
      if (spec.type === "sse") {
        transport = {
          type: "sse" as const,
          url: spec.url,
          headers: resolveHeaders(spec.headers, vault),
          authProvider,
        };
      } else if (spec.type === "stdio" || (spec as any).command) {
        const stdioSpec = spec as Extract<McpServerSpec, { command: string }>;
        const { Experimental_StdioMCPTransport } = await import(
          "@ai-sdk/mcp/mcp-stdio"
        );
        transport = new Experimental_StdioMCPTransport({
          command: stdioSpec.command,
          args: stdioSpec.args,
          env: stdioSpec.env,
        });
      } else {
        // Default to HTTP — handles both `{ type: "http", url }` and the
        // forgiving `{ url }` shorthand.
        const httpSpec = spec as Extract<McpServerSpec, { type: "http" }>;
        transport = {
          type: "http" as const,
          url: httpSpec.url,
          headers: resolveHeaders(httpSpec.headers, vault),
          authProvider,
          // Defense-in-depth: refuse 3xx so an attacker can't bounce us
          // off-allowlist via a redirect.
          redirect: "error" as const,
        };
      }

      const client = await createMCPClient({ transport });
      closers.push(() => client.close().catch(() => {}));

      const serverTools = await client.tools();
      for (const [toolName, aiTool] of Object.entries(serverTools)) {
        tools.push(adaptMcpTool(serverName, toolName, aiTool));
      }
    } catch (err) {
      console.error(
        `[mcp] agent="${agentName}" server="${serverName}" failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    tools,
    dispose: async () => {
      await Promise.all(closers.map((fn) => fn()));
    },
  };
}
