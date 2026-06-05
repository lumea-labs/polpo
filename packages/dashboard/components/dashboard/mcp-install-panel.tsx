"use client";

import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { CopyCard } from "#/components/dashboard/copy-card";
import {
  ClaudeCodeIcon,
  CursorIcon,
  WindsurfIcon,
} from "#/components/icons/coding-agents";

/**
 * MCP install panel — rendered inside the Connect dialog's "Coding Agent"
 * tab when the user picks the "MCP (remote tools)" sub-option.
 *
 * Conceptually distinct from the skills install flow: MCP adds a single
 * OAuth-authenticated endpoint that a coding client (Cursor, Claude Desktop,
 * etc.) calls at runtime — no files land in the user's repo, no skills are
 * scaffolded. Intended for "I want to query my Polpo state from my editor"
 * use cases, not "I want to develop agents against Polpo locally".
 *
 * Each client has its own config surface, so we render a per-client
 * snippet instead of one generic `polpo install` command. Cursor additionally
 * gets a 1-click deep link (`cursor://anysphere.cursor-deeplink/mcp/install`);
 * other clients require pasting JSON into a config file.
 */

// The MCP server lives on the apex host — it's scoped to the user by
// Better Auth session, not by subdomain. Using `api.polpo.sh` keeps OAuth
// discovery on the same origin (avoids cross-origin .well-known quirks that
// some MCP clients are sensitive to).
const MCP_URL = "https://api.polpo.sh/v1/mcp";

type ClientId = "cursor" | "claude-desktop" | "claude-code" | "windsurf" | "generic";

interface MCPClient {
  id: ClientId;
  label: string;
  Icon: (props: { className?: string }) => React.ReactElement;
  /** Short line of context shown under the client name. */
  hint: string;
  /** The snippet body the user copies. */
  snippet: string;
  /** Label shown on the CopyCard (e.g. "mcp.json", "terminal"). */
  snippetLabel: string;
  /** Path-to-edit hint shown above the snippet, if any. */
  pathHint?: string;
  /** Optional 1-click deep link (only Cursor at the moment). */
  deepLink?: { href: string; label: string };
}

function buildCursorDeepLink(): string {
  // Cursor's deep-link spec: a base64-encoded JSON config blob.
  // Ref: https://docs.cursor.com/features/mcp (Share an MCP server)
  const payload = JSON.stringify({ url: MCP_URL });
  // btoa is fine here — we're running in the browser.
  const b64 = typeof window !== "undefined" ? window.btoa(payload) : "";
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=polpo&config=${b64}`;
}

function useMcpClients(): MCPClient[] {
  return useMemo(() => {
    const jsonConfig = JSON.stringify(
      { mcpServers: { polpo: { url: MCP_URL } } },
      null,
      2,
    );
    return [
      {
        id: "cursor",
        label: "Cursor",
        Icon: CursorIcon,
        hint: "1-click install or paste into ~/.cursor/mcp.json",
        snippet: jsonConfig,
        snippetLabel: "~/.cursor/mcp.json",
        pathHint: "Global: ~/.cursor/mcp.json · Project: .cursor/mcp.json",
        deepLink: {
          href: buildCursorDeepLink(),
          label: "Install in Cursor",
        },
      },
      {
        id: "claude-desktop",
        label: "Claude Desktop",
        Icon: ClaudeCodeIcon,
        hint: "Paste into claude_desktop_config.json, then restart.",
        snippet: jsonConfig,
        snippetLabel: "claude_desktop_config.json",
        pathHint:
          "macOS: ~/Library/Application Support/Claude · Linux: ~/.config/Claude",
      },
      {
        id: "claude-code",
        label: "Claude Code",
        Icon: ClaudeCodeIcon,
        hint: "Run once — registers Polpo as a remote MCP server.",
        snippet: `claude mcp add --transport http polpo ${MCP_URL}`,
        snippetLabel: "terminal",
      },
      {
        id: "windsurf",
        label: "Windsurf",
        Icon: WindsurfIcon,
        hint: "Paste into Windsurf's MCP config file.",
        snippet: JSON.stringify(
          { mcpServers: { polpo: { serverUrl: MCP_URL } } },
          null,
          2,
        ),
        snippetLabel: "~/.codeium/windsurf/mcp_config.json",
      },
      {
        id: "generic",
        label: "Other",
        // Icon reuse: Claude Code icon as a neutral stand-in.
        Icon: ClaudeCodeIcon,
        hint: "Any MCP client that supports Streamable HTTP + OAuth.",
        snippet: jsonConfig,
        snippetLabel: "mcp config",
      },
    ];
  }, []);
}

const VERIFY_PROMPT =
  "List the Polpo projects in my organization and summarise how many agents each one has.";

export function McpInstallPanel() {
  const clients = useMcpClients();
  const [selected, setSelected] = useState<ClientId>("cursor");
  const client = clients.find((c) => c.id === selected)!;

  return (
    <div className="flex flex-col gap-5">
      {/* Client picker — compact pill row. Single-select: each client has
          a different config shape, so showing one at a time is clearer
          than a multi-select JSON dump. */}
      <div className="flex flex-wrap items-center gap-2">
        {clients.map((c) => {
          const active = c.id === selected;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c.id)}
              className={[
                "inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-foreground/40 bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              ].join(" ")}
              aria-pressed={active}
            >
              <c.Icon className="h-3.5 w-3.5" />
              {c.label}
            </button>
          );
        })}
      </div>

      {/* Hint + optional 1-click install */}
      <div className="flex flex-col gap-2">
        <p className="text-sm leading-6 text-muted-foreground">{client.hint}</p>
        {client.pathHint && (
          <p className="text-[11px] leading-5 text-muted-foreground font-mono">
            {client.pathHint}
          </p>
        )}
        {client.deepLink && (
          <a
            href={client.deepLink.href}
            className="inline-flex w-fit items-center gap-1.5 rounded border border-foreground/20 bg-foreground/5 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground hover:text-background transition-colors"
          >
            <client.Icon className="h-4 w-4" />
            {client.deepLink.label}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* Snippet */}
      <CopyCard label={client.snippetLabel} value={client.snippet} />

      {/* Verify — shared across clients */}
      <div className="flex flex-col gap-2 rounded border border-border bg-background/60 p-3">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-medium text-foreground">Verify</p>
          <p className="text-[11px] text-muted-foreground">
            First call opens a browser tab for OAuth login
          </p>
        </div>
        <CopyCard label="verify prompt" value={VERIFY_PROMPT} />
      </div>
    </div>
  );
}
