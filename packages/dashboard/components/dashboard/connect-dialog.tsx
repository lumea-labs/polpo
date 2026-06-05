"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchControlPlane } from "#/lib/data-client";
import { Plug, KeyRound, Terminal, CodeXml, SquareTerminal } from "lucide-react";
import { CopyCard } from "#/components/dashboard/copy-card";
import { ClientPicker } from "#/components/dashboard/client-picker";
import { SdkSnippetPanel } from "#/components/dashboard/sdk-snippet-panel";
import { McpInstallPanel } from "#/components/dashboard/mcp-install-panel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "#/components/ui/dialog";
import type { Project } from "#/lib/api";
import { createPolpoClient } from "#/lib/polpo-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.polpo.sh";

/**
 * Per-project "Connect" dialog. Shows the URL + install snippets the user
 * needs to hit their project from code, curl, or CLI.
 *
 * When a project is in scope (the user is inside /projects/[id]/...) the
 * snippets use the project's slug-based subdomain — the canonical
 * data-plane URL post-F2 (`{slug}.polpo.cloud`). Otherwise the dialog
 * still renders, but with a short "open a project first" hint instead
 * of placeholder slugs that don't resolve.
 *
 * The ConnectButton wrapper is responsible for resolving the current
 * project: it reads `[id]` from the URL params and lazy-fetches the
 * project row only when the dialog is opened (cheap, avoids an extra
 * request on every dashboard page).
 */

const APEX_FALLBACK = "https://api.polpo.sh";

/** Discord brand glyph — lucide-react doesn't ship one, so we inline it. */
function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 -28.5 256 256"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M216.856 16.597C200.285 8.843 182.566 3.208 164.042 0c-2.275 4.113-4.933 9.646-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0C96.911 9.645 94.193 4.113 91.897 0 73.353 3.208 55.613 8.864 39.042 16.638 5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.654 26.612 64.775 33.192 5.215-7.177 9.866-14.807 13.873-22.848-7.631-2.9-14.94-6.478-21.847-10.632a106.78 106.78 0 0 0 5.358-4.237c42.123 19.702 87.89 19.702 129.51 0 1.752 1.46 3.544 2.879 5.356 4.237-6.927 4.175-14.256 7.753-21.887 10.653 4.007 8.02 8.638 15.67 13.873 22.847 21.142-6.58 42.647-16.637 64.815-33.192 5.316-56.287-9.081-105.09-38.056-148.36zM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18 0-14.375 10.148-26.2 23.015-26.2 12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18zm85.051 0c-12.645 0-23.015-11.805-23.015-26.18 0-14.375 10.148-26.2 23.015-26.2 12.867 0 23.237 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Short relative-time formatter for the key list ("used 3h ago").
 * Intentionally minimal: no locale plumbing, coarse buckets.
 */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diffMs = Date.now() - then;
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function tenantUrl(slug: string | undefined): string {
  // `{slug}.polpo.cloud` is the dedicated tenant zone. Worker injects
  // `x-polpo-slug` into the header and forwards to the backend.
  return slug ? `https://${slug}.polpo.cloud` : APEX_FALLBACK;
}

/**
 * Step header — circle with step number + optional vertical connector +
 * title + description. Used in the Coding Agent tab's 2-step flow.
 */
function StepHeader({
  n,
  last,
  title,
  description,
}: {
  n: number;
  last: boolean;
  title: string;
  description: string;
}) {
  return (
    <div className="flex w-[240px] shrink-0 gap-2">
      <div className="flex flex-col items-center gap-2 pt-0.5">
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary">
          <span className="text-xs font-medium leading-4 text-foreground">{n}</span>
        </div>
        {!last && <div className="w-px flex-1 bg-border" />}
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <p className="text-sm font-medium leading-6 text-foreground">{title}</p>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

type BadgeTone = "brand" | "muted";

interface OptionCardProps {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  badge: string;
  badgeTone?: BadgeTone;
  active: boolean;
  onClick: () => void;
}

/**
 * Connect tab: center-aligned icon + label + pill badge, stacked
 * vertically. Sits inside a segmented strip (shared outer border,
 * vertical divider between segments).
 */
function OptionCard({ icon: Icon, title, badge, badgeTone = "brand", active, onClick }: OptionCardProps) {
  const badgeClasses =
    badgeTone === "brand"
      ? "bg-brand/10 text-brand"
      : "bg-secondary text-muted-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex flex-1 flex-col items-center justify-center gap-3 py-4 transition-colors ${
        active ? "bg-secondary" : "hover:bg-secondary/60"
      }`}
    >
      <Icon
        className={`h-6 w-6 ${active ? "text-muted-foreground" : "text-muted-foreground/60 group-hover:text-muted-foreground"}`}
        strokeWidth={1.5}
      />
      <div className="flex flex-col items-center gap-1.5">
        <span className={`text-[13px] leading-[18px] ${active ? "text-foreground" : "text-foreground/90"}`}>{title}</span>
        <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${badgeClasses}`}>
          {badge}
        </span>
      </div>
    </button>
  );
}

type Method = "cli" | "mcp" | "api" | "curl";

type KeyScope = { type: "platform" } | { type: "project"; projectId: string };
interface ExistingKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: KeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
}

const AGENT_PLACEHOLDER = "my-agent";

export function ConnectDialog({
  open,
  onOpenChange,
  project,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Pick<Project, "id" | "slug" | "name" | "orgId">;
  /** Raw project id from the URL — available BEFORE the project row has been
   *  fetched. Lets the CLI tab render the real link command immediately. */
  projectId?: string;
}) {
  const [method, setMethod] = useState<Method>("cli");
  // Coding Agent tab has two distinct install paths: local skill pack
  // (scaffolds .polpo/ in the repo) vs remote MCP server (zero files,
  // OAuth-authenticated live tools). Kept as a sub-mode instead of a
  // fifth top-level tab to avoid tab-bar clutter.
  const [codingMode, setCodingMode] = useState<"skills" | "mcp">("skills");
  const [agents, setAgents] = useState<string[] | null>(null);
  const [agent, setAgent] = useState<string>(AGENT_PLACEHOLDER);
  const [clients, setClients] = useState<string[]>(["claude-code"]);
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [existingKeys, setExistingKeys] = useState<ExistingKey[] | null>(null);

  // Eagerly fetch the org's existing keys and filter to those usable on
  // this project (platform-scoped OR project-scoped matching `project.id`).
  // Shown inline so the user can recognise a key they already saved
  // elsewhere instead of being funneled into generating a new one.
  useEffect(() => {
    if (!open || !project?.orgId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${API_URL}/v1/api-keys?orgId=${encodeURIComponent(project.orgId)}`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const all = (await res.json()) as ExistingKey[];
        if (cancelled) return;
        const relevant = all.filter((k) =>
          k.scopes.some(
            (s) => s.type === "project" && s.projectId === project.id,
          ),
        );
        setExistingKeys(relevant);
      } catch {
        if (!cancelled) setExistingKeys([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project?.orgId, project?.id]);

  // Drop the plaintext key when the dialog closes. Keeping it alive across
  // open/close would leak it via sessionStorage-equivalent React state and
  // undermine the "shown once" security contract. Tab switches within a
  // single open session keep the key (state is retained), which is what
  // the user asked for.
  useEffect(() => {
    if (!open) {
      setGeneratedKey(null);
      setKeyError(null);
    }
  }, [open]);

  async function handleGenerateKey() {
    if (!project) return;
    setGenerating(true);
    setKeyError(null);
    try {
      const res = await fetch(`${API_URL}/v1/api-keys`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: project.orgId,
          name: "Connect dialog",
          scopes: [{ type: "project", projectId: project.id }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rawKey: string };
      setGeneratedKey(data.rawKey);
    } catch (e) {
      setKeyError((e as Error).message || "Failed to generate key");
    } finally {
      setGenerating(false);
    }
  }

  // Lazy-fetch the project's agent list when the dialog opens. Purely
  // cosmetic — if the fetch fails we fall back to `my-agent` placeholder.
  useEffect(() => {
    if (!open || !project?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const polpo = createPolpoClient(project.id);
        const list = await polpo.getAgents();
        if (cancelled) return;
        const names = list.map(a => a.name).filter(Boolean);
        setAgents(names);
        if (names.length > 0) setAgent(names[0]);
      } catch {
        if (!cancelled) setAgents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, project?.id]);

  const baseUrl = tenantUrl(project?.slug);

  // CLI tab — agentic connect: `link` kicks off the device-code browser
  // flow lazily and scaffolds the project. One command, real project id
  // from the URL (available instantly, no fetch needed).
  const effectiveProjectId = projectId ?? project?.id;
  const cliSnippet = effectiveProjectId
    ? `npx @polpo-ai/cli link --project-id ${effectiveProjectId}`
    : null;

  // Coding Agent tab — single deterministic command: `polpo install`
  // wraps device-code auth (if needed) + skills install for the picked
  // clients. Keeps `link` separate on purpose (install is per-machine,
  // link is per-project).
  const clientFlag = clients.length > 0 ? clients.join(",") : "claude-code";
  const codingInstallSnippet = `npx @polpo-ai/cli install --client ${clientFlag}`;
  const codingVerifyPrompt = `I'm using Polpo as my backend for AI agents. List the Polpo agents configured in this project.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl bg-card ring-foreground/15 shadow-2xl">
        <DialogHeader className="pb-1">
          <DialogTitle className="text-base font-normal">
            {project ? (
              <>
                Connect to <span className="font-semibold">{project.name}</span>
              </>
            ) : (
              "Connect your agents"
            )}
          </DialogTitle>
          <DialogDescription className="text-sm">
            <>
              Reach your agents from your app, your terminal, or a coding assistant.{" "}
              <a
                href="https://docs.polpo.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground hover:underline underline-offset-4"
              >
                Read the docs
              </a>
            </>
          </DialogDescription>
        </DialogHeader>

        {/* Segmented strip — three squared tabs glued together with a single
            outer border + vertical dividers. Centered cards. */}
        <div className="mt-2 flex items-stretch overflow-hidden border border-border divide-x divide-border">
          <OptionCard
            icon={SquareTerminal}
            title="CLI"
            badge="Agentic Connect"
            active={method === "cli"}
            onClick={() => setMethod("cli")}
          />
          <OptionCard
            icon={Terminal}
            title="Coding Agent"
            badge="Agentic Connect"
            active={method === "mcp"}
            onClick={() => setMethod("mcp")}
          />
          <OptionCard
            icon={KeyRound}
            title="API Key"
            badge="Manage Project Keys"
            badgeTone="muted"
            active={method === "api"}
            onClick={() => setMethod("api")}
          />
          <OptionCard
            icon={CodeXml}
            title="SDK"
            badge="Integrate in your app"
            badgeTone="muted"
            active={method === "curl"}
            onClick={() => setMethod("curl")}
          />
        </div>

        {/* Per-tab content — 240px label column on the left,
            stack of copy cards on the right. min-h keeps dialog height stable. */}
        <div className="mt-6 min-h-[160px]">
          {method === "cli" && (
            <div className="flex gap-6">
              <div className="flex w-[240px] shrink-0 flex-col gap-2">
                <p className="text-sm font-medium leading-6 text-foreground">Link Project</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  Run this from your project directory. It writes{" "}
                  <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">.polpo/polpo.json</code>{" "}
                  binding this folder to the cloud project.
                </p>
              </div>
              <div className="flex-1 min-w-0">
                {cliSnippet ? (
                  <CopyCard label="terminal command" value={cliSnippet} />
                ) : (
                  <div className="rounded border border-border bg-background p-6 text-center text-sm text-muted-foreground">
                    Open a project to get the exact link command.
                  </div>
                )}
              </div>
            </div>
          )}

          {method === "mcp" && (
            <div className="flex flex-col gap-6">
              {/* Skills vs MCP sub-toggle. Two very different shapes of
                  install — separated here instead of buried in copy. */}
              <div className="inline-flex self-start border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setCodingMode("skills")}
                  className={[
                    "px-3 py-1.5 font-medium transition-colors",
                    codingMode === "skills"
                      ? "bg-foreground text-background"
                      : "bg-background text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                  aria-pressed={codingMode === "skills"}
                >
                  Skills
                </button>
                <div className="w-px bg-border" />
                <button
                  type="button"
                  onClick={() => setCodingMode("mcp")}
                  className={[
                    "px-3 py-1.5 font-medium transition-colors",
                    codingMode === "mcp"
                      ? "bg-foreground text-background"
                      : "bg-background text-muted-foreground hover:text-foreground",
                  ].join(" ")}
                  aria-pressed={codingMode === "mcp"}
                >
                  MCP Server
                </button>
              </div>

              {codingMode === "skills" ? (
                <>
                  {/* Step 1 — install */}
                  <div className="flex gap-6">
                    <StepHeader
                      n={1}
                      last={false}
                      title="Install Polpo"
                      description="Run this command to install Polpo's skill pack in your coding agent so it knows how to work with your project."
                    />
                    <div className="flex-1 min-w-0 flex flex-col gap-3">
                      <ClientPicker value={clients} onChange={setClients} />
                      <CopyCard label="Terminal Command" value={codingInstallSnippet} />
                    </div>
                  </div>

                  {/* Step 2 — verify */}
                  <div className="flex gap-6">
                    <StepHeader
                      n={2}
                      last
                      title="Verify Connection"
                      description="Send the prompt below to your AI coding agent to confirm the connection."
                    />
                    <div className="flex-1 min-w-0">
                      <CopyCard label="prompt" value={codingVerifyPrompt} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex gap-6">
                  <div className="flex w-[240px] shrink-0 flex-col gap-2">
                    <p className="text-sm font-medium leading-6 text-foreground">
                      MCP Server
                    </p>
                    <p className="text-sm leading-6 text-muted-foreground">
                      Connect your coding agent to Polpo&apos;s remote MCP
                      endpoint. No files land in your repo — tools are called
                      live over OAuth.
                    </p>
                  </div>
                  <div className="flex-1 min-w-0">
                    <McpInstallPanel />
                  </div>
                </div>
              )}
            </div>
          )}

          {method === "api" && (
            <div className="flex gap-6">
              <div className="flex w-[240px] shrink-0 flex-col gap-2">
                <p className="text-sm font-medium leading-6 text-foreground">API Keys</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  Drop these into your app&apos;s environment to connect from SDKs, HTTP clients, or your own backend.
                </p>
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-3">
                <CopyCard label="POLPO_URL" value={baseUrl} />
                {generatedKey ? (
                  <>
                    <CopyCard label="POLPO_API_KEY" value={generatedKey} />
                    <p className="text-xs leading-5 text-amber-500">
                      Save this key now — it won&apos;t be shown again after you close this dialog.
                    </p>
                  </>
                ) : (
                  <div className="flex flex-col gap-3 rounded border border-border bg-background p-3">
                    <div className="flex items-center justify-between">
                      <span className="inline-flex h-5 items-center rounded bg-secondary px-2 text-[11px] font-medium text-muted-foreground">
                        POLPO_API_KEY
                      </span>
                      {existingKeys && existingKeys.length > 0 && (
                        <span className="text-[11px] text-muted-foreground">
                          {existingKeys.length} existing
                        </span>
                      )}
                    </div>

                    {/* Existing keys for this project — recognition aid so the
                        user can pick the right one from their password manager
                        instead of being forced to generate a new one. */}
                    {existingKeys && existingKeys.length > 0 && (
                      <ul className="flex flex-col gap-1.5 border-b border-border pb-3">
                        {existingKeys.slice(0, 5).map((k) => (
                          <li
                            key={k.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="flex min-w-0 items-baseline gap-2">
                              <code className="font-mono text-foreground truncate">
                                {k.keyPrefix}…
                              </code>
                              <span className="text-muted-foreground truncate">
                                {k.name}
                              </span>
                            </span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {k.lastUsedAt ? `used ${formatRelative(k.lastUsedAt)}` : "never used"}
                            </span>
                          </li>
                        ))}
                        {existingKeys.length > 5 && (
                          <li className="text-[11px] text-muted-foreground">
                            +{existingKeys.length - 5} more…
                          </li>
                        )}
                      </ul>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleGenerateKey}
                        disabled={generating || !project}
                        className="rounded border border-foreground/20 bg-foreground/5 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground hover:text-background transition-colors disabled:opacity-50"
                      >
                        {generating ? "Generating…" : "Generate new key"}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {existingKeys && existingKeys.length > 0
                          ? "or use one of the keys above (plaintext only shown at creation)"
                          : "Shown once."}
                      </span>
                    </div>
                    {keyError && (
                      <p className="text-xs text-red-500">{keyError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {method === "curl" && (
            <div className="flex gap-6">
              <div className="flex w-[240px] shrink-0 flex-col gap-2">
                <p className="text-sm font-medium leading-6 text-foreground">SDK</p>
                <p className="text-sm leading-6 text-muted-foreground">
                  Integrate in your app. Set{" "}
                  <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px]">POLPO_API_KEY</code>{" "}
                  in your environment, then paste the snippet.
                </p>
                {!generatedKey && (
                  <button
                    type="button"
                    onClick={() => setMethod("api")}
                    className="self-start text-xs font-medium text-amber-500 hover:underline underline-offset-4"
                  >
                    Generate an API key →
                  </button>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <SdkSnippetPanel
                  baseUrl={baseUrl}
                  agents={agents}
                  defaultAgent={agent}
                  sdkKey={generatedKey ?? "$POLPO_API_KEY"}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-2 flex items-center justify-between gap-3 sm:justify-between">
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground flex-wrap">
            <span>Need help?</span>
            <a
              href="https://discord.gg/polpo"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-[#5865F2] hover:text-[#7289f4] transition-colors"
            >
              <DiscordIcon className="h-4 w-4" />
              Discord
            </a>
            <span className="text-muted-foreground/60">·</span>
            <a
              href="https://calendly.com/hello-polpo/polpo-demo"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground/80 hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              Book a demo
            </a>
          </p>
          <DialogClose>
            <button className="rounded-md border border-border px-4 py-2 text-sm hover:border-foreground/30 transition-colors">
              Close
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Header-mounted launcher. Reads the `[id]` URL segment from
 * /projects/[id]/… to decide whether a project is in scope. Fetches the
 * project row lazily on first open so we don't pay an extra round-trip
 * on every dashboard page load.
 */
const PROJECT_ID_RE = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export function ConnectButton() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Extract project id from ANY /projects/{uuid}/... route — more robust
  // than useParams (which depends on the current route segment matching).
  const projectId = pathname?.match(PROJECT_ID_RE)?.[1];

  // Reuse TopHeader's React Query entry for the same key so we don't pay
  // two cold starts for the same /v1/projects/{id} endpoint on a single
  // page load. If TopHeader already resolved it, this is a cache hit;
  // if not, whichever fires first populates the cache.
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      fetchControlPlane<Project>(`/v1/projects/${projectId}`),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  // Connect is a per-project surface — hide it when the user is outside a
  // project context (listing, keys, billing, settings). No project = nothing
  // to link/connect to.
  if (!projectId) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="header-connect"
        className="group inline-flex h-8 items-center gap-1.5 border border-border bg-card px-2.5 text-xs font-medium text-foreground hover:border-foreground/40 hover:bg-secondary hover:shadow-[0_0_0_3px_rgba(255,255,255,0.04)] transition-all duration-150"
      >
        <Plug className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" strokeWidth={1.5} />
        <span className="hidden sm:inline">Connect</span>
      </button>
      <ConnectDialog
        open={open}
        onOpenChange={setOpen}
        project={project ?? undefined}
        projectId={projectId}
      />
    </>
  );
}
