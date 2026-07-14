"use client";

/**
 * Agent quickstart — the product's main aha-moment.
 *
 * A two-pane "create agent" surface (matches the reference Quickstart):
 * LEFT  → the Meta-Agent chat builder (`<BuilderChat>`), which renders its
 *         own landing + composer; describe an agent and it gets built.
 * RIGHT → a "Browse templates" card: search + a grid of official templates
 *         that install a complete agent (loops, skills, teams) in one click.
 *
 * Renders inside the `.v2` themed shell.
 */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "../host";
import { Link } from "../host";
import { useMutation, useQuery, useQueryClient } from "../host";
import {
  Cube,
  MagnifyingGlass,
  CircleNotch,
} from "@phosphor-icons/react/dist/ssr";
import { toast } from "../host";
import { announceNavigationStart } from "../host";
import { BuilderChat } from "../host";
import { navigateHref } from "../host";
import { fetchControlPlane, mutateControlPlane } from "../host";
import { DASHBOARD_API_URL } from "../host";

const API_URL = DASHBOARD_API_URL;

type Template = {
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  category?: string;
  resources?: Array<{ kind: string; name: string }>;
  installed?: boolean;
};

type InstallResponse = {
  ok: boolean;
  data?: { next?: { agentName?: string; loopName?: string } };
};

const STEPS: { label: string; href?: (id: string) => string }[] = [
  { label: "Create agent" },
  { label: "Configure environment", href: (id) => `/projects/${id}/settings` },
  { label: "Start session", href: (id) => `/projects/${id}/playground` },
  { label: "Integrate", href: (id) => `/projects/${id}/keys` },
];

export function AgentQuickstart({
  projectId,
  showSteps = false,
}: {
  projectId: string;
  /** Onboarding shows the aha-moment steps; the plain "New agent" flow doesn't. */
  showSteps?: boolean;
}) {
  const queryClient = useQueryClient();
  const [rightWidth, setRightWidth] = useState(480);

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const onMove = (ev: PointerEvent) =>
      setRightWidth(Math.min(760, Math.max(340, startW - (ev.clientX - startX))));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex min-h-0 flex-col lg:h-full">
      {showSteps && (
        <div className="shrink-0 border-b border-border px-6 py-4 md:px-8">
          <Steps projectId={projectId} />
        </div>
      )}

      {/* Split: builder left · templates right (right pane resizable, no divider) */}
      <div
        className="flex min-h-0 flex-1 flex-col lg:flex-row"
        style={{ "--tpl-w": `${rightWidth}px` } as CSSProperties}
      >
        <BuilderPane projectId={projectId} queryClient={queryClient} />
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          className="group hidden shrink-0 cursor-col-resize items-stretch px-1.5 lg:flex"
        >
          <div className="w-px bg-transparent transition-colors group-hover:bg-brand/40" />
        </div>
        <TemplatesPane projectId={projectId} />
      </div>
    </div>
  );
}

/* ── Steps row ────────────────────────────────────────────────────────── */

function Steps({ projectId }: { projectId: string }) {
  return (
    <ol className="mx-auto flex w-full max-w-3xl items-center gap-3">
      {STEPS.map((step, i) => {
        const active = i === 0;
        const href = step.href?.(projectId);
        const inner = (
          <span
            className={`flex shrink-0 items-center gap-2.5 ${
              href ? "opacity-70 transition-opacity hover:opacity-100" : ""
            }`}
          >
              <span
                className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ${
                  active
                    ? "bg-foreground text-background"
                    : "border border-border bg-background text-muted-foreground"
                }`}
              >
                {i + 1}
              </span>
              <span
                className={`whitespace-nowrap text-[12px] ${
                  active ? "font-medium text-foreground" : "text-muted-foreground"
                }`}
              >
                {step.label}
              </span>
            </span>
        );
        return (
          <li key={step.label} className="flex flex-1 items-center gap-3">
            {href ? <Link href={href}>{inner}</Link> : inner}
            {i < STEPS.length - 1 && (
              <span className="h-px flex-1 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ── Left: chat builder ───────────────────────────────────────────────── */

/**
 * Reactively reports whether the builder conversation has started (≥1
 * persisted message). `BuilderChat` mirrors its thread to `localStorage`
 * under `persistKey`, but same-tab writes never emit a `storage` event, so
 * we poll the key (~800ms) and also re-check on focus + cross-tab writes.
 * Naturally flips back to `false` when "new session" clears the key.
 */
function useConversationStarted(persistKey: string): boolean {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const check = () => {
      let has = false;
      try {
        const raw = window.localStorage.getItem(persistKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          has = Array.isArray(parsed) && parsed.length > 0;
        }
      } catch {
        has = false;
      }
      setStarted((prev) => (prev === has ? prev : has));
    };

    check();
    const interval = window.setInterval(check, 800);
    const onFocus = () => check();
    const onStorage = (e: StorageEvent) => {
      if (e.key === persistKey) check();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [persistKey]);

  return started;
}

function BuilderPane({
  projectId,
  queryClient,
}: {
  projectId: string;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const router = useRouter();
  const persistKey = `polpo:quickstart:${projectId}`;
  const started = useConversationStarted(persistKey);

  return (
    <div className="flex min-h-[520px] flex-col lg:min-h-0 lg:min-w-0 lg:flex-1">
      {/* Heading — collapses + fades once the conversation begins. */}
      <div
        className={`grid shrink-0 text-center transition-all duration-500 ease-out ${
          started ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
        aria-hidden={started}
      >
        <div className="min-h-0 overflow-hidden px-6 pb-2 pt-8 md:px-10">
          <span className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-lg border border-border bg-secondary">
            <Cube size={18} className="text-muted-foreground" />
          </span>
          <h1 className="text-[19px] font-semibold tracking-tight text-foreground">
            What do you want to build?
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Describe your agent, or start with a template.
          </p>
        </div>
      </div>
      <div className="builder-scope flex min-h-0 flex-1 flex-col overflow-hidden">
        <BuilderChat
          projectId={projectId}
          apiUrl={API_URL}
          persistKey={persistKey}
          onMutation={() => queryClient.invalidateQueries()}
          onNavigate={(target) => {
            const href = navigateHref(projectId, target);
            announceNavigationStart(undefined, href);
            router.push(href);
          }}
        />
      </div>
    </div>
  );
}

/* ── Right: browse templates ──────────────────────────────────────────── */

function TemplatesPane({ projectId }: { projectId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["official-templates", projectId],
    queryFn: async () => {
      const res = await fetchControlPlane<{ ok: boolean; data: Template[] }>(
        `/v1/projects/${projectId}/official-templates`,
      );
      return res.data ?? [];
    },
  });

  const install = useMutation({
    mutationFn: (template: Template) =>
      mutateControlPlane<InstallResponse>(
        `/v1/projects/${projectId}/official-templates/${template.id}/install`,
        { method: "POST" },
      ),
    onSuccess: async (res) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["official-templates", projectId] }),
      ]);
      const agentName = res.data?.next?.agentName;
      const href = agentName
        ? `/projects/${projectId}/agents/${encodeURIComponent(agentName)}`
        : `/projects/${projectId}/agents`;
      announceNavigationStart(agentName ?? "agents", href);
      router.push(href);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : "Failed to install template",
      );
    },
  });

  const installingId = install.isPending ? install.variables?.id : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) =>
      [t.name, t.description, t.tagline].some((v) =>
        (v ?? "").toLowerCase().includes(q),
      ),
    );
  }, [templates, query]);

  return (
    <div className="flex min-h-0 w-full flex-col p-6 md:p-8 lg:w-[var(--tpl-w)] lg:shrink-0 lg:overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="shrink-0 border-b border-border p-4">
          <h2 className="text-[14px] font-semibold tracking-tight text-foreground">
            Browse templates
          </h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Install a complete agent, ready to run.
          </p>
          <div className="relative mt-3">
            <MagnifyingGlass
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search templates…"
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring/50 focus:outline-none"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
              <CircleNotch size={16} className="animate-spin" />
              Loading templates…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-[13px] text-muted-foreground">
              No templates match your search.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {filtered.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  busy={installingId === template.id}
                  disabled={install.isPending}
                  onClick={() => install.mutate(template)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  busy,
  disabled,
  onClick,
}: {
  template: Template;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const kinds = useMemo(
    () =>
      Array.from(
        new Set((template.resources ?? []).map((r) => r.kind)),
      ).slice(0, 4),
    [template.resources],
  );

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group relative flex flex-col items-start gap-2 rounded-lg border border-border bg-background p-3.5 text-left transition-colors hover:border-ring/40 hover:bg-secondary/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy && (
        <span className="absolute right-3 top-3 text-brand">
          <CircleNotch size={15} className="animate-spin" />
        </span>
      )}
      <div className="text-[13px] font-medium text-foreground">
        {template.name}
      </div>
      {(template.description || template.tagline) && (
        <p className="line-clamp-2 text-[12px] leading-5 text-muted-foreground">
          {template.description ?? template.tagline}
        </p>
      )}
      {kinds.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {kinds.map((kind) => (
            <span
              key={kind}
              className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {kind}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
