"use client";

/**
 * CopilotLayout — wraps the dashboard main content and docks a global,
 * context-aware Builder panel BESIDE it (push, not overlay): when open the
 * content shrinks and the panel takes its place on the right.
 *
 * The Meta Agent is the same one the Agent Studio uses; here it picks up the
 * page CONTEXT (current agent / skill / section) from the route so it acts
 * on what you're looking at.
 *
 * The panel is ALWAYS mounted (it collapses by WIDTH, never unmounts), so
 * the conversation survives open/close and navigation between project pages.
 * It's keyed by projectId so switching projects starts a fresh session.
 *
 * Phase 1: additive. It coexists with the Studio's docked builder;
 * convergence (one surface) is a later decision.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SquarePen, X } from "lucide-react";
import { BuilderChat } from "#/components/dashboard/builder-chat";
import { useBuilderContext, type NavigateTarget } from "#/lib/builder-context";
import { fetchControlPlane } from "#/lib/data-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** localStorage key for persisted copilot UI preferences. */
const COPILOT_PREFS_KEY = "polpo.copilot.prefs";

interface CopilotContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const CopilotContext = createContext<CopilotContextValue | null>(null);

/** Open/close the global Copilot panel from anywhere under the dashboard
 *  layout (e.g. the Agent Studio "Edit" button). Returns null outside it. */
export function useCopilot(): CopilotContextValue | null {
  return useContext(CopilotContext);
}

/** The Polpo mark — two offset squares (no wordmark). Inherits color. */
function PolpoMark({ className = "" }: { className?: string }) {
  return (
    <span className={`relative inline-block ${className}`} aria-hidden>
      <span className="absolute left-0 top-0 h-[45%] w-[45%] bg-current" />
      <span className="absolute bottom-0 right-0 h-[45%] w-[45%] bg-current" />
    </span>
  );
}

export function CopilotLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Bumping this remounts <BuilderChat>, resetting its in-memory state.
  const [sessionNonce, setSessionNonce] = useState(0);
  const { projectId, context } = useBuilderContext();

  // Persist UI preferences (currently: was the panel open) across reloads.
  const prefsHydrated = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(COPILOT_PREFS_KEY);
      if (raw) {
        const prefs = JSON.parse(raw);
        if (typeof prefs?.open === "boolean") setOpen(prefs.open);
      }
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!prefsHydrated.current) {
      prefsHydrated.current = true;
      return;
    }
    try {
      window.localStorage.setItem(COPILOT_PREFS_KEY, JSON.stringify({ open }));
    } catch {
      /* ignore */
    }
  }, [open]);

  const copilotCtx = useMemo<CopilotContextValue>(
    () => ({ open, setOpen, toggle: () => setOpen((v) => !v) }),
    [open],
  );

  // Clear the locally-persisted conversation and start fresh.
  const clearConversation = useCallback(() => {
    if (projectId && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(`polpo.builder.${projectId}`);
      } catch {
        /* ignore */
      }
    }
    setSessionNonce((n) => n + 1);
  }, [projectId]);

  // When the Meta Agent mutates something, refresh only the relevant data:
  // router.refresh() re-fetches server components (e.g. the Studio agent
  // detail), and we invalidate the matching client queries so lists update
  // live too. Keyed by which tool ran.
  const handleMutation = useCallback(
    (tool: string) => {
      router.refresh();
      const inv = (key: unknown[]) => queryClient.invalidateQueries({ queryKey: key });
      // Tool name is `polpo_<resource>_<action>` — invalidate that resource's
      // queries, plus the cross-referenced ones (team ↔ agent membership).
      const resource = tool.split("_")[1] ?? "";
      inv([resource, projectId]);
      if (resource === "agents") inv(["teams", projectId]);
      if (resource === "skills" || resource === "teams") inv(["agents", projectId]);
    },
    [router, queryClient, projectId],
  );

  // Client-side navigation requested by the Meta Agent (navigate tool):
  // build the URL and push it. The panel is global, so it stays open and
  // its context auto-updates to the new page.
  const handleNavigate = useCallback(
    (t: NavigateTarget) => {
      if (!projectId) return;
      let url = `/projects/${projectId}`;
      if (t.section && t.section !== "overview") url += `/${t.section}`;
      if (t.name) url += `/${encodeURIComponent(t.name)}`;
      if (t.tab) url += `?tab=${encodeURIComponent(t.tab)}`;
      router.push(url);
    },
    [router, projectId],
  );

  // Only meaningful inside a project (the Meta Agent operates on one).
  const show = !!projectId;

  // Project name for the context line — shares the ["project", id] query
  // with sidebar/top-header (cache hit, no extra fetch).
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      fetchControlPlane<{ name: string; orgId: string }>(`/v1/projects/${projectId}`),
    enabled: show,
    staleTime: 60_000,
  });

  // Dynamic, human explanation of what the Meta Agent is scoped to —
  // always names the specific thing (which agent / skill / project).
  const projectName = project?.name ?? "this project";
  const contextDetail =
    context.type === "agent"
      ? `Agent ${context.agentName}`
      : context.type === "skill"
        ? `Skill ${context.skill}`
        : context.type === "section"
          ? context.label
          : "Overview";
  const contextExplain = `${contextDetail} · ${projectName}`;

  return (
    <CopilotContext.Provider value={copilotCtx}>
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>

      {show && (
        <>
          {/* Launcher — Intercom-style, bottom-right; only visible when closed. */}
          {!open && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="group fixed bottom-5 right-5 z-40 inline-flex items-center gap-2.5 border border-border bg-card px-3 py-2.5 shadow-lg transition-colors hover:border-foreground/40 hover:bg-card"
            >
              <PolpoMark className="h-3.5 w-3.5 text-foreground" />
              <span className="text-xs font-semibold text-foreground">Polpo AI</span>
            </button>
          )}

          {/* Panel — docked beside content; collapses by width, stays mounted. */}
          <aside
            className={`shrink-0 overflow-hidden border-l border-border transition-[width] duration-200 ease-out ${
              open ? "w-[500px]" : "w-0"
            }`}
          >
            <div className="flex h-full w-[500px] flex-col overflow-hidden">
              {/* Header — title + dynamic context on one row. The context
                  names the specific thing the agent acts on. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
                <PolpoMark className="h-3.5 w-3.5 shrink-0 text-foreground" />
                <span className="shrink-0 text-sm font-semibold text-foreground">Polpo AI</span>
                <span className="ml-1 flex min-w-0 items-center gap-1.5 border-l border-border pl-2">
                  <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/55">
                    Context
                  </span>
                  <span className="min-w-0 truncate text-xs text-foreground" title={contextExplain}>
                    {contextExplain}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={clearConversation}
                  aria-label="New conversation"
                  title="New conversation"
                  className="ml-auto shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <SquarePen className="h-4 w-4" strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </div>

              <div className="copilot-chat-dense flex min-h-0 flex-1 flex-col overflow-hidden">
                <BuilderChat
                  key={`${projectId ?? "none"}:${sessionNonce}`}
                  projectId={projectId as string}
                  apiUrl={API_URL}
                  context={context}
                  onMutation={handleMutation}
                  onNavigate={handleNavigate}
                  persistKey={`polpo.builder.${projectId}`}
                />
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
    </CopilotContext.Provider>
  );
}
