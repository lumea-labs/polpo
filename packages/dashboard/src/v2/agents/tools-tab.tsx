"use client";

import { useState } from "react";
import { useRouter } from "../host";
import { Key, MagnifyingGlass, CaretRight } from "@phosphor-icons/react/dist/ssr";
import {
  TOOL_CATALOG,
  isToolEnabled,
  type CatalogGroup,
  type CatalogTool,
} from "../host";
import { useDashboardApi } from "../../host";
import { Toggle } from "../ui/bits";

/** When allowedTools is empty the runtime grants this baseline set. */
const BASELINE = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
  "ls",
  "http_fetch",
  "http_download",
]);

function toolOn(name: string, allowed: string[], core?: boolean): boolean {
  if (core) return true;
  if (allowed.length === 0) return BASELINE.has(name);
  return isToolEnabled(name, allowed);
}

function matches(tool: CatalogTool, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    tool.name.toLowerCase().includes(s) ||
    tool.description.toLowerCase().includes(s)
  );
}

export function ToolsTab({
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(TOOL_CATALOG.filter((g) => !g.core).map((g) => g.key)),
  );

  const toggleExpand = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

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

  function materialize(): Set<string> {
    return new Set(allowed.length ? allowed : [...BASELINE]);
  }

  function toggleTool(group: CatalogGroup, name: string) {
    const set = materialize();
    const wildcard = `${group.key}*`;
    if (group.explicitToolsOnly && set.has(wildcard)) {
      set.delete(wildcard);
      for (const tool of group.tools) set.add(tool.name);
    }
    if (set.has(name)) set.delete(name);
    else set.add(name);
    persist([...set]);
  }

  function toggleGroup(g: CatalogGroup, enable: boolean) {
    const set = materialize();
    set.delete(`${g.key}*`);
    for (const t of g.tools) {
      if (enable) set.add(t.name);
      else set.delete(t.name);
    }
    persist([...set]);
  }

  function groupCount(g: CatalogGroup) {
    return g.tools.filter((t) => toolOn(t.name, allowed, g.core)).length;
  }

  // Core tools are always on and can't be toggled — no point listing them.
  const visible = TOOL_CATALOG.filter((g) => !g.core)
    .map((g) => ({
      group: g,
      tools: g.tools.filter((t) => matches(t, query)),
    }))
    .filter((x) => x.tools.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {/* Search */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <MagnifyingGlass
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring/50 focus:outline-none"
          />
        </div>
        {error && <p className="text-[12px] text-destructive">{error}</p>}
      </div>

      {/* Categories, stacked */}
      {visible.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted-foreground">
          No tools match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map(({ group: g, tools }) => {
            const on = groupCount(g);
            const allOn = on === g.tools.length;
            const isOpen = expanded.has(g.key) || query.length > 0;
            return (
              <section key={g.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleExpand(g.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleExpand(g.key);
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
                      {g.label}
                    </h3>
                    {g.requiresKey && (
                      <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        <Key size={10} /> {g.credentialLabel ?? "needs vault"}
                      </span>
                    )}
                    <span
                      className={`ml-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
                        on > 0
                          ? "bg-brand/10 text-brand"
                          : "bg-secondary text-muted-foreground/50"
                      }`}
                    >
                      {on}/{g.tools.length}
                    </span>
                  </div>
                  {g.core ? (
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      Always on
                    </span>
                  ) : (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground"
                    >
                      Enable all
                      <Toggle
                        checked={allOn}
                        onChange={() => toggleGroup(g, !allOn)}
                        disabled={saving}
                        label={`Toggle all ${g.label}`}
                      />
                    </div>
                  )}
                </div>

                {isOpen && (
                  <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
                    {tools.map((tool, i) => (
                      <div
                        key={tool.name}
                        className={`flex items-center gap-3 px-3.5 py-2.5 ${
                          i > 0 ? "border-t border-border" : ""
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[12px] text-foreground">
                            {tool.name}
                          </div>
                          <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
                            {tool.description}
                          </div>
                        </div>
                        <Toggle
                          checked={toolOn(tool.name, allowed, g.core)}
                          onChange={() => toggleTool(g, tool.name)}
                          disabled={saving || g.core}
                          label={tool.name}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
