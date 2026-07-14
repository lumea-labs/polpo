"use client";

import { useState } from "react";
import { useRouter } from "../host";
import { useQuery } from "../host";
import { Link } from "../host";
import {
  CircleNotch,
  MagnifyingGlass,
  CaretRight,
  ArrowSquareOut,
  PlugsConnected,
} from "@phosphor-icons/react/dist/ssr";
import { useDashboardApi } from "../../host";
import {
  BASELINE_TOOLS,
  CATALOG_TOOL_NAMES,
  countEnabledTools,
} from "../host";
import { Toggle } from "../ui/bits";
import { ToolsTab } from "./tools-tab";

/**
 * The agent's "Tools & MCP" tab, split into a vertical sub-nav:
 *   • Built-in tools — the managed runtime catalog (categories, toggles).
 *   • Custom tools   — tools authored at project level, toggled per agent.
 *   • MCP Servers    — external tools via Model Context Protocol (coming soon).
 */
export function ToolsPanel({
  projectId,
  agentName,
  allowedTools,
}: {
  projectId: string;
  agentName: string;
  allowedTools: string[];
}) {
  const [sub, setSub] = useState<"builtin" | "custom">("builtin");

  const items = [
    { id: "builtin" as const, label: "Built-in tools" },
    { id: "custom" as const, label: "Custom tools" },
  ];

  return (
    <div className="flex flex-col gap-5 md:flex-row md:gap-6">
      <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col md:gap-0.5 md:overflow-visible">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => setSub(it.id)}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
              sub === it.id
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
          >
            {it.label}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1">
        {sub === "builtin" && (
          <ToolsTab
            projectId={projectId}
            agentName={agentName}
            allowedTools={allowedTools}
          />
        )}
        {sub === "custom" && (
          <CustomToolsPanel
            projectId={projectId}
            agentName={agentName}
            allowedTools={allowedTools}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Agent tools with a horizontal type filter — Built-in · Custom · MCP (soon).
 * One section at a time (single search each), instead of a nested sub-nav.
 */
export function AgentToolsPanel({
  projectId,
  agentName,
  allowedTools,
}: {
  projectId: string;
  agentName: string;
  allowedTools: string[];
}) {
  const [filter, setFilter] = useState<"builtin" | "custom" | "mcp">("builtin");

  const builtinCount = countEnabledTools(allowedTools);
  const customCount = allowedTools.filter(
    (t) => !CATALOG_TOOL_NAMES.has(t) && !t.endsWith("*"),
  ).length;

  const FILTERS = [
    { id: "builtin" as const, label: "Built-in" },
    { id: "custom" as const, label: "Custom" },
    { id: "mcp" as const, label: "MCP", soon: true },
  ];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        Tools this agent can call. Built-in tools run on the managed runtime,
        custom tools are authored in your project, and MCP connects external
        servers.
      </p>

      <div className="scrollbar-none flex items-center gap-1 overflow-x-auto border-b border-border">
        {FILTERS.map((f) => {
          const count =
            f.id === "builtin"
              ? builtinCount
              : f.id === "custom"
                ? customCount
                : null;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
                filter === f.id
                  ? "border-brand font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
              {count !== null && (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {count}
                </span>
              )}
              {f.soon && (
                <span className="rounded-sm bg-secondary px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-muted-foreground/60">
                  Soon
                </span>
              )}
            </button>
          );
        })}
      </div>

      {filter === "builtin" && (
        <ToolsTab
          projectId={projectId}
          agentName={agentName}
          allowedTools={allowedTools}
        />
      )}
      {filter === "custom" && (
        <CustomToolsPanel
          projectId={projectId}
          agentName={agentName}
          allowedTools={allowedTools}
        />
      )}
      {filter === "mcp" && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
            <PlugsConnected size={20} className="text-muted-foreground" />
          </span>
          <div className="max-w-sm">
            <div className="text-sm font-medium text-foreground">
              MCP Servers
            </div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              Connect this agent to external tools and data through Model
              Context Protocol servers.
            </div>
          </div>
          <span className="rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            Coming soon
          </span>
        </div>
      )}
    </div>
  );
}

type CustomTool = { name: string; description?: string | null };

export function CustomToolsPanel({
  projectId,
  agentName,
  allowedTools,
}: {
  projectId: string;
  agentName: string;
  allowedTools: string[];
}) {
  const api = useDashboardApi();
  const router = useRouter();
  const [allowed, setAllowed] = useState<string[]>(allowedTools);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: tools = [], isLoading } = useQuery({
    queryKey: ["custom-tools", projectId],
    queryFn: () =>
      api.fetchControlPlane<{ ok: boolean; data: CustomTool[] }>(
        `/v1/projects/${projectId}/tools`,
      ).then((r) => r.data ?? []),
    staleTime: 30_000,
  });

  const authorHref = `/projects/${projectId}/tools`;

  async function persist(next: string[]) {
    const prev = allowed;
    setAllowed(next);
    setSaving(true);
    setError(null);
    try {
      await api.mutateDataPlane(
        projectId,
        `/v1/agents/${encodeURIComponent(agentName)}`,
        { method: "PATCH", body: { allowedTools: next } },
      );
      router.refresh();
    } catch (e) {
      setAllowed(prev);
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  // Materialize the baseline first so enabling a custom tool doesn't silently
  // switch off the built-in baseline (empty allowedTools == baseline).
  function base(): Set<string> {
    return new Set(allowed.length ? allowed : [...BASELINE_TOOLS]);
  }
  function toggle(name: string) {
    const set = base();
    if (set.has(name)) set.delete(name);
    else set.add(name);
    persist([...set]);
  }
  function toggleAll(enable: boolean) {
    const set = base();
    for (const t of tools) {
      if (enable) set.add(t.name);
      else set.delete(t.name);
    }
    persist([...set]);
  }

  const filtered = query
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(query.toLowerCase()) ||
          (t.description ?? "").toLowerCase().includes(query.toLowerCase()),
      )
    : tools;
  const enabledCount = tools.filter((t) => allowed.includes(t.name)).length;
  const allOn = tools.length > 0 && enabledCount === tools.length;
  const isOpen = expanded || query.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {tools.length > 0 && (
        <div className="relative w-full sm:w-72">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search custom tools…"
            className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring/50 focus:outline-none"
          />
        </div>
      )}

      {error && <p className="text-[12px] text-destructive">{error}</p>}

      {isLoading ? (
        <div className="py-10 text-center">
          <CircleNotch
            size={18}
            className="mx-auto animate-spin text-muted-foreground"
          />
        </div>
      ) : tools.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <div className="text-sm font-medium text-foreground">
            No custom tools yet
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            Author them in{" "}
            <Link
              href={authorHref}
              className="text-brand transition-colors hover:underline"
            >
              Project &rarr; Tools
            </Link>
            .
          </div>
        </div>
      ) : (
        <section>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setExpanded((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded((v) => !v);
              }
            }}
            className="group -mx-2 flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-2 transition-colors hover:bg-secondary/50"
          >
            <div className="flex min-w-0 items-center gap-2">
              <CaretRight
                size={14}
                className={`shrink-0 text-muted-foreground/60 transition-transform ${isOpen ? "rotate-90" : ""}`}
              />
              <h3 className="text-[14px] font-semibold text-foreground">
                Custom tools
              </h3>
              <span
                className={`ml-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                  enabledCount > 0
                    ? "bg-brand/10 text-brand"
                    : "bg-secondary text-muted-foreground/50"
                }`}
              >
                {enabledCount}/{tools.length}
              </span>
            </div>
            <div
              onClick={(e) => e.stopPropagation()}
              className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground"
            >
              Enable all
              <Toggle
                checked={allOn}
                onChange={() => toggleAll(!allOn)}
                disabled={saving}
                label="Toggle all custom tools"
              />
            </div>
          </div>

          {isOpen &&
            (filtered.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-muted-foreground">
                No custom tools match &ldquo;{query}&rdquo;.
              </p>
            ) : (
              <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
                {filtered.map((t, i) => (
                  <div
                    key={t.name}
                    className={`flex items-center gap-3 px-3.5 py-2.5 ${
                      i > 0 ? "border-t border-border" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12px] text-foreground">
                        {t.name}
                      </div>
                      {t.description && (
                        <div className="mt-0.5 min-w-0 truncate text-[12px] text-muted-foreground">
                          {t.description}
                        </div>
                      )}
                    </div>
                    <a
                      href={`${authorHref}/${encodeURIComponent(t.name)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${t.name}`}
                      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2 text-[12px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground"
                    >
                      Open
                      <ArrowSquareOut size={13} />
                    </a>
                    <Toggle
                      checked={allowed.includes(t.name)}
                      onChange={() => toggle(t.name)}
                      disabled={saving}
                      label={t.name}
                    />
                  </div>
                ))}
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
