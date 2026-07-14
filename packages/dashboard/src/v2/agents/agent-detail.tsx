"use client";

import { useEffect, useState, type ComponentType } from "react";
import { useQuery } from "../host";
import { Link } from "../host";
import { useRouter, useSearchParams } from "../host";
import { AGENT_TAB_TO_SUB } from "../host";
import { AgentRunPanel } from "./agent-run-panel";
import {
  ArrowLeft,
  ArrowsClockwise,
  Lightning,
  Coins,
  CurrencyDollar,
  Play,
  Plus,
  X,
  PencilSimple,
  Gauge,
  FloppyDisk,
  CircleNotch,
  TextAa,
  Eye,
  Image as ImageIcon,
  Microphone,
  SpeakerHigh,
  VideoCamera,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { announceNavigationStart } from "../host";
import { countEnabledTools } from "../host";
import { V2_FLAGS } from "../host";
import {
  fetchControlPlane,
  fetchDataPlane,
  mutateDataPlane,
} from "../host";
import { normalizeAll } from "../sessions/trace-normalize";
import { traceColumns } from "../sessions/trace-columns";
import { DataTable } from "../ui/data-table";
import { PageBody } from "../ui/page-header";
import { EmptyBox } from "../ui/bits";
import { Button } from "../ui/button";
import { ModelSelect, type GatewayModel } from "./model-select";
import {
  ToolsPanel,
  AgentToolsPanel,
} from "./tools-panel";
import { SkillsTab } from "./skills-tab";
import { LoopsTab } from "./loops-tab";
import { Markdown } from "../host";
import { VaultTab } from "./vault-tab";
import { useCopilot } from "../host";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { CodeBlock } from "../ui/code-block";
import { CopyButton } from "../ui/copy-button";
import { PromptPreviewDialog } from "./prompt-preview-dialog";

export type AgentDetailData = {
  name: string;
  role?: string;
  model?: string;
  image_model?: string;
  vision_model?: string;
  transcribe_model?: string;
  tts_model?: string;
  video_model?: string;
  allowedTools?: string[];
  allowedPaths?: string[];
  skills?: string[];
  systemPrompt?: string;
  assignedLoops?: string[];
  team?: string;
  teamName?: string;
  team_name?: string;
};

const REFINE_TEXTAREA_CLASS =
  "h-[calc(100vh-340px)] min-h-[360px] max-h-[900px] w-full resize-y rounded-lg border border-border bg-card p-4 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none";

type VaultEntry = { service: string; type: string; label?: string | null; keys?: string[] };

const TABS = [
  "Agent",
  "Loops",
  "Credentials",
  "Sessions",
  "Tools & MCPs",
  "Skills",
] as const;
type Tab = (typeof TABS)[number];

/** Temporarily hidden from the top bar (still live in the code + Agent sub-nav). */
const HIDDEN_TABS = new Set<Tab>(["Tools & MCPs", "Skills", "Loops"]);

function teamOf(a: AgentDetailData): string {
  const raw =
    (a.teamName && a.teamName.trim()) ||
    (a.team_name && a.team_name.trim()) ||
    (a.team && a.team.trim()) ||
    "default";
  return raw && raw !== "default" ? raw : "default";
}

function monogram(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9]/g, " ")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || name.slice(0, 2).toUpperCase()
  );
}

export function AgentDetail({
  projectId,
  agent,
  initialMemory,
  initialVault,
}: {
  projectId: string;
  agent: AgentDetailData;
  initialMemory: string;
  initialVault: VaultEntry[];
}) {
  const [tab, setTab] = useState<Tab>("Agent");
  const [editOpen, setEditOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const { openChat } = useCopilot();
  const team = teamOf(agent);
  const code = agentConfigCode(agent);

  const tabCount = (t: Tab): number | null =>
    t === "Tools & MCPs"
      ? countEnabledTools(agent.allowedTools ?? [])
      : t === "Skills"
        ? agent.skills?.length ?? 0
        : t === "Loops"
          ? agent.assignedLoops?.length ?? 0
          : null;

  return (
    <PageBody>
      <Link
        href={`/projects/${projectId}/agents`}
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        Agents
      </Link>

      {/* Identity */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
        {V2_FLAGS.showAvatars && (
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-border bg-secondary text-[15px] font-semibold text-foreground">
            {monogram(agent.name)}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="font-mono text-[20px] font-semibold tracking-tight text-foreground">
              {agent.name}
            </h1>
            {V2_FLAGS.showTeams && (
              <span
                className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                  team === "default"
                    ? "bg-muted text-muted-foreground"
                    : "bg-brand/10 text-brand"
                }`}
              >
                {team}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {agent.role || "No role set"}
          </p>
        </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
          >
            <PencilSimple size={15} />
            Edit
          </Button>
          <Button type="button" size="sm" onClick={() => setRunOpen(true)}>
            <Play size={15} weight="fill" />
            Run
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="scrollbar-none mt-6 flex items-center gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((t) => !HIDDEN_TABS.has(t)).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors ${
              tab === t
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
            {tabCount(t) !== null && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                {tabCount(t)}
              </span>
            )}
            {t === "Loops" && (
              <span className="rounded-sm bg-brand/15 px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-brand">
                New
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "Sessions" && (
          <OverviewPanel projectId={projectId} agent={agent} />
        )}
        {tab === "Agent" && (
          <SystemPanel
            projectId={projectId}
            agent={agent}
            initialMemory={initialMemory}
          />
        )}
        {tab === "Tools & MCPs" && (
          <ToolsPanel
            projectId={projectId}
            agentName={agent.name}
            allowedTools={agent.allowedTools ?? []}
          />
        )}
        {tab === "Skills" && (
          <SkillsTab
            projectId={projectId}
            agentName={agent.name}
            fallbackSkills={agent.skills ?? []}
          />
        )}
        {tab === "Loops" && (
          <LoopsTab
            projectId={projectId}
            agentName={agent.name}
            assignedLoops={agent.assignedLoops ?? []}
          />
        )}
        {tab === "Credentials" && (
          <VaultTab
            projectId={projectId}
            agentName={agent.name}
            initialEntries={initialVault}
          />
        )}
      </div>

      <EditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        agentName={agent.name}
        code={code}
        onSubmit={(prompt) => {
          openChat({ kind: "agent", name: agent.name, prompt });
          setEditOpen(false);
        }}
      />

      <RunDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        projectId={projectId}
        agentName={agent.name}
      />
    </PageBody>
  );
}

/* ── Edit — review config + request a change via the builder ──────────── */

function EditDialog({
  open,
  onOpenChange,
  agentName,
  code,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  agentName: string;
  code: string;
  onSubmit: (prompt: string) => void;
}) {
  const [msg, setMsg] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setMsg("");
      }}
    >
      <DialogContent className="v2 w-[calc(100vw-2rem)] sm:max-w-5xl">
        <DialogHeader className="border-b border-border pb-4">
          <DialogTitle className="flex items-center gap-2 text-[18px] font-semibold tracking-tight text-foreground">
            Edit
            <span className="rounded-md bg-secondary px-2 py-0.5 font-mono text-[14px] font-medium text-foreground">
              {agentName}
            </span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Describe a change and send it to the builder.
          </DialogDescription>
        </DialogHeader>

        {/* Ask for a change */}
        <div>
          <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
            What do you want to change?
          </label>
          <textarea
            autoFocus
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                (e.metaKey || e.ctrlKey) &&
                msg.trim()
              ) {
                e.preventDefault();
                onSubmit(msg.trim());
              }
            }}
            placeholder="e.g. add the web_search tool and make it always cite its sources"
            className="h-24 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">
              Opens the builder with your request — it edits the config for you.
            </span>
            <Button
              size="sm"
              disabled={!msg.trim()}
              onClick={() => onSubmit(msg.trim())}
            >
              <PencilSimple size={14} />
              Request change
            </Button>
          </div>
        </div>

        {/* Current config (read-only) */}
        <div className="min-w-0">
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">
            Current configuration
          </div>
          <CodeBlock code={code} lang="json" maxHeightClass="max-h-[42vh]" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ── Run — playground + call-from-code (chat / task) ──────────────────── */


function RunDialog({
  open,
  onOpenChange,
  projectId,
  agentName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  agentName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 flex h-[88dvh] max-h-[88dvh] w-[calc(100vw-2rem)] flex-col sm:max-w-[94rem]">
        <DialogHeader className="shrink-0 border-b border-border pb-4">
          <DialogTitle className="flex items-center gap-2 text-[18px] font-semibold tracking-tight text-foreground">
            Integrate
            <span className="rounded-md bg-secondary px-2 py-0.5 font-mono text-[14px] font-medium text-foreground">
              {agentName}
            </span>
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Call it from your app with the snippet — or run a quick test here to
            see it work.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <AgentRunPanel projectId={projectId} agentName={agentName} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function agentConfigCode(a: AgentDetailData): string {
  const cfg: Record<string, unknown> = { name: a.name };
  if (a.role) cfg.role = a.role;
  if (a.model) cfg.model = a.model;
  if (a.image_model) cfg.image_model = a.image_model;
  if (a.vision_model) cfg.vision_model = a.vision_model;
  if (a.transcribe_model) cfg.transcribe_model = a.transcribe_model;
  if (a.tts_model) cfg.tts_model = a.tts_model;
  if (a.video_model) cfg.video_model = a.video_model;
  if (a.allowedTools?.length) cfg.allowedTools = a.allowedTools;
  if (a.skills?.length) cfg.skills = a.skills;
  if (a.assignedLoops?.length) cfg.assignedLoops = a.assignedLoops;
  const t = teamOf(a);
  if (t !== "default") cfg.team = t;
  if (a.systemPrompt) cfg.systemPrompt = a.systemPrompt;
  return JSON.stringify(cfg, null, 2);
}

/* ── Overview ─────────────────────────────────────────────────────────── */

/**
 * Overview = a small activity dashboard for this agent (what it has actually
 * done), not a re-list of its config — model / tools / skills / loops each have
 * their own tab.
 */
function OverviewPanel({
  projectId,
  agent,
}: {
  projectId: string;
  agent: AgentDetailData;
}) {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["agent-activity", projectId, agent.name],
    queryFn: async () => {
      const [s, t, l] = await Promise.all([
        fetchDataPlane<{ data?: { sessions?: unknown[] } }>(
          projectId,
          "/v1/chat/sessions",
        ).catch(() => ({ data: { sessions: [] } })),
        fetchDataPlane<{ data?: unknown[] }>(projectId, "/v1/tasks").catch(
          () => ({ data: [] }),
        ),
        fetchDataPlane<{ data?: unknown[] }>(
          projectId,
          "/v1/loop-runs?limit=100",
        ).catch(() => ({ data: [] })),
      ]);
      return normalizeAll(
        (s.data?.sessions ?? []) as never,
        (t.data ?? []) as never,
        (l.data ?? []) as never,
      );
    },
    staleTime: 30_000,
  });

  const mine = rows.filter((r) => r.agent === agent.name);
  const runs = mine.length;
  const chatRuns = mine.filter((r) => r.kind === "chat").length;
  const taskRuns = mine.filter((r) => r.kind === "task").length;

  const { data: spend } = useQuery({
    queryKey: ["agent-spend", projectId, agent.name],
    queryFn: () =>
      fetchControlPlane<{
        ok: boolean;
        data: {
          byAgent?: Array<{
            agent: string;
            cost: number;
            calls: number;
            inputTokens: number;
            outputTokens: number;
          }>;
        };
      }>(`/v1/projects/${projectId}/spending?range=30d`).catch(() => ({
        ok: false,
        data: { byAgent: [] },
      })),
    staleTime: 60_000,
  });
  const spent = spend?.data?.byAgent?.find((x) => x.agent === agent.name);
  const calls = spent?.calls ?? 0;
  const tokens = (spent?.inputTokens ?? 0) + (spent?.outputTokens ?? 0);
  const cost = spent?.cost ?? 0;
  const avgTokPerCall = calls ? Math.round(tokens / calls) : 0;

  return (
    <div className="flex flex-col gap-6">
      {isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-3.5"
            >
              <div className="h-3 w-14 animate-pulse rounded bg-muted" />
              <div className="mt-2.5 h-6 w-20 animate-pulse rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={ArrowsClockwise}
          label="Runs"
          value={runs}
          sub={runs ? `${chatRuns} chat · ${taskRuns} task` : undefined}
        />
        <StatTile
          icon={Lightning}
          label="LLM calls"
          value={calls}
          sub={calls ? `~${fmtCompact(avgTokPerCall)} tok/call` : undefined}
        />
        <StatTile
          icon={Coins}
          label="Tokens"
          value={fmtCompact(tokens)}
          sub={`${fmtCompact(spent?.inputTokens ?? 0)} in · ${fmtCompact(
            spent?.outputTokens ?? 0,
          )} out`}
        />
        <StatTile
          icon={CurrencyDollar}
          label="Spend"
          value={fmtUsd(cost)}
          sub="last 30 days"
        />
      </div>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-foreground">Activity</h2>
          <Link
            href={`/projects/${projectId}/sessions`}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            All sessions
          </Link>
        </div>

        {isLoading ? (
          <div className="rounded-lg border border-dashed border-border px-3.5 py-6 text-center text-[13px] text-muted-foreground/60">
            Loading…
          </div>
        ) : (
          <DataTable
            columns={traceColumns}
            data={mine}
            getRowId={(r) => r.id}
            rowHref={(r) =>
              `/projects/${projectId}/sessions/${encodeURIComponent(r.id)}`
            }
            initialSorting={[{ id: "when", desc: true }]}
            searchPlaceholder="Search this agent’s runs…"
            searchFn={(r, q) =>
              [r.title, r.loop, r.status, r.id].some((v) =>
                (v ?? "").toLowerCase().includes(q),
              )
            }
            empty={
              <span className="text-sm text-muted-foreground">
                This agent hasn&rsquo;t run yet — hit Test to start a session.
              </span>
            }
          />
        )}
      </div>

    </div>
  );
}

/* ── Danger zone (lives at the bottom of the Agent tab) ───────────────── */

function AgentDangerZone({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  async function del() {
    setDeleting(true);
    setDelError(null);
    try {
      await mutateDataPlane(
        projectId,
        `/v1/agents/${encodeURIComponent(agentName)}`,
        { method: "DELETE" },
      );
      const href = `/projects/${projectId}/agents`;
      announceNavigationStart("agents", href);
      router.push(href);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/[0.04] p-4">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-foreground">Danger zone</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Permanently delete this agent and its entire configuration.
          </p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash size={14} />
          Delete agent
        </Button>
      </div>

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(false);
        }}
      >
        <DialogContent showCloseButton={false} className="v2">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <WarningCircle size={16} className="text-destructive" weight="fill" />
              <DialogTitle>Delete agent</DialogTitle>
            </div>
            <DialogDescription>
              Permanently deletes{" "}
              <span className="font-mono font-medium text-foreground">
                {agentName}
              </span>{" "}
              and its configuration — model, tools, skills and loop assignments.
              This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          {delError && <p className="text-[12px] text-destructive">{delError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={del}
            >
              {deleting ? (
                <>
                  <CircleNotch size={14} className="animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete agent"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}
function fmtUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
        <Icon size={13} />
        {label}
      </div>
      <div className="mt-1 text-[22px] font-semibold text-foreground tabular-nums">
        {value}
      </div>
      <div
        className="mt-0.5 h-[15px] font-mono text-[11px] text-muted-foreground/55"
        data-tabular
      >
        {sub ?? ""}
      </div>
    </div>
  );
}

/* ── System (additive trial: Models + Instructions under a vertical sub-nav) ── */

export type SystemSub =
  | "models"
  | "instructions"
  | "memory"
  | "tools"
  | "skills"
  | "loops"
  | "permissions"
  | "settings";

export function SystemPanel({
  projectId,
  agent,
  initialMemory,
  hiddenSubs,
  fillHeight,
  sub: subProp,
  onSubChange,
}: {
  projectId: string;
  agent: AgentDetailData;
  initialMemory: string;
  /** Sub-nav ids to hide (e.g. ["settings"] in onboarding). */
  hiddenSubs?: readonly string[];
  /** Fill the parent height and scroll ONLY the panel — the sub-nav stays put
   *  (used in the onboarding card). */
  fillHeight?: boolean;
  /** Controlled active sub. Omit for internal state + `?tab=` URL focus. */
  sub?: SystemSub;
  onSubChange?: (sub: SystemSub) => void;
}) {
  // The Meta Agent's `navigate` tool lands here via `?tab=<sub>` (mapped
  // through AGENT_TAB_TO_SUB) — so the builder can focus a vertical tab.
  const searchParams = useSearchParams();
  const paramSub = (() => {
    const raw = searchParams.get("tab");
    const mapped = raw ? AGENT_TAB_TO_SUB[raw] : undefined;
    return (mapped as SystemSub | undefined) ?? undefined;
  })();
  const [internalSub, setInternalSub] = useState<SystemSub>(
    paramSub ?? "instructions",
  );
  const sub = subProp ?? internalSub;
  const setSub = (s: SystemSub) =>
    onSubChange ? onSubChange(s) : setInternalSub(s);
  // Follow later `?tab=` changes (client nav to the same page) when uncontrolled.
  useEffect(() => {
    if (!subProp && paramSub) setInternalSub(paramSub);
  }, [subProp, paramSub]);
  const items = [
    { id: "instructions" as const, label: "Prompt" },
    { id: "models" as const, label: "Models" },
    { id: "tools" as const, label: "Tools & MCPs" },
    { id: "skills" as const, label: "Skills" },
    { id: "loops" as const, label: "Loops" },
    { id: "permissions" as const, label: "Permissions" },
    { id: "settings" as const, label: "Settings" },
  ].filter((it) => !hiddenSubs?.includes(it.id));
  return (
    <div
      className={`flex flex-col gap-5 md:flex-row md:gap-6 ${
        fillHeight ? "md:h-full md:min-h-0" : ""
      }`}
    >
      <nav
        className={`flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col md:gap-0.5 md:overflow-visible ${
          fillHeight ? "md:self-start" : ""
        }`}
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => setSub(it.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
              sub === it.id
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
          >
            {it.label}
            {it.id === "loops" && (
              <span className="rounded-sm bg-brand/15 px-1 py-px text-[9px] font-semibold uppercase leading-none tracking-wide text-brand">
                New
              </span>
            )}
          </button>
        ))}
      </nav>
      <div
        className={`min-w-0 flex-1 ${
          fillHeight ? "md:min-h-0 md:overflow-y-auto md:pr-1" : ""
        }`}
      >
        {sub === "models" && <ModelPanel projectId={projectId} agent={agent} />}
        {sub === "instructions" && (
          <InstructionsPanel
            projectId={projectId}
            agentName={agent.name}
            model={agent.model}
            initial={agent.systemPrompt ?? ""}
          />
        )}
        {sub === "memory" && (
          <MemoryPanel
            projectId={projectId}
            agentName={agent.name}
            initial={initialMemory}
          />
        )}
        {sub === "tools" && (
          <AgentToolsPanel
            projectId={projectId}
            agentName={agent.name}
            allowedTools={agent.allowedTools ?? []}
          />
        )}
        {sub === "skills" && (
          <SkillsTab
            projectId={projectId}
            agentName={agent.name}
            fallbackSkills={agent.skills ?? []}
          />
        )}
        {sub === "loops" && (
          <LoopsTab
            projectId={projectId}
            agentName={agent.name}
            assignedLoops={agent.assignedLoops ?? []}
          />
        )}
        {sub === "permissions" && (
          <SecurityPanel projectId={projectId} agent={agent} />
        )}
        {sub === "settings" && (
          <AgentSettingsPanel projectId={projectId} agent={agent} />
        )}
      </div>
    </div>
  );
}

/**
 * Inline agent editor — the SAME panels as SystemPanel (DRY), but stacked in a
 * single scroll instead of a vertical sub-nav. Used by the onboarding studio's
 * "Agent" tab where a compact, no-navigation layout reads better. Only the
 * agent-definition panels (no Credentials / Sessions, and Settings lives in the
 * Config tab already).
 */
export function AgentInlinePanel({
  projectId,
  agent,
}: {
  projectId: string;
  agent: AgentDetailData;
}) {
  const sections: { title: string; node: React.ReactNode }[] = [
    {
      title: "Prompt",
      node: (
        <InstructionsPanel
          projectId={projectId}
          agentName={agent.name}
          model={agent.model}
          initial={agent.systemPrompt ?? ""}
        />
      ),
    },
    { title: "Models", node: <ModelPanel projectId={projectId} agent={agent} /> },
    {
      title: "Tools & MCPs",
      node: (
        <AgentToolsPanel
          projectId={projectId}
          agentName={agent.name}
          allowedTools={agent.allowedTools ?? []}
        />
      ),
    },
    {
      title: "Skills",
      node: (
        <SkillsTab
          projectId={projectId}
          agentName={agent.name}
          fallbackSkills={agent.skills ?? []}
        />
      ),
    },
    {
      title: "Loops",
      node: (
        <LoopsTab
          projectId={projectId}
          agentName={agent.name}
          assignedLoops={agent.assignedLoops ?? []}
        />
      ),
    },
  ];
  return (
    <div className="flex flex-col divide-y divide-border">
      {sections.map((s) => (
        <section key={s.title} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0">
          <h3 className="text-[13px] font-semibold text-foreground">{s.title}</h3>
          {s.node}
        </section>
      ))}
    </div>
  );
}

/* ── Settings (identity + lifecycle) ──────────────────────────────────── */

function AgentSettingsPanel({
  projectId,
  agent,
}: {
  projectId: string;
  agent: AgentDetailData;
}) {
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] text-muted-foreground">
            The full definition of this agent — copy it to version-control or
            recreate it elsewhere.
          </p>
          <CopyButton text={agentConfigCode(agent)} label="Copy" />
        </div>
        <CodeBlock code={agentConfigCode(agent)} lang="json" showCopy={false} />
      </section>

      <AgentDangerZone projectId={projectId} agentName={agent.name} />
    </div>
  );
}

/* ── Security (filesystem sandbox) ────────────────────────────────────── */

function SecurityPanel({
  projectId,
  agent,
}: {
  projectId: string;
  agent: AgentDetailData;
}) {
  const router = useRouter();
  const initial = agent.allowedPaths ?? [];
  const [paths, setPaths] = useState<string[]>(initial);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    paths.length !== initial.length || paths.some((p, i) => p !== initial[i]);

  function add() {
    const p = draft.trim();
    if (!p || paths.includes(p)) return;
    setPaths([...paths, p]);
    setDraft("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await mutateDataPlane(
        projectId,
        `/v1/agents/${encodeURIComponent(agent.name)}`,
        { method: "PATCH", body: { allowedPaths: paths } },
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <p className="text-[13px] text-muted-foreground">
          Directories this agent may read and write. Leave empty to use the
          runtime&rsquo;s default sandbox.
        </p>

        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="/workspace/data"
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 font-mono text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!draft.trim()}
            onClick={add}
          >
            <Plus size={14} weight="bold" />
            Add
          </Button>
        </div>

        {paths.length > 0 ? (
          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-card">
            {paths.map((p, i) => (
              <div
                key={p}
                className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${
                  i > 0 ? "border-t border-border" : ""
                }`}
              >
                <code className="min-w-0 truncate font-mono text-[12px] text-foreground">
                  {p}
                </code>
                <button
                  type="button"
                  onClick={() => setPaths(paths.filter((x) => x !== p))}
                  aria-label={`Remove ${p}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
                >
                  <X size={13} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-border py-8 text-center text-[13px] text-muted-foreground">
            No paths set — using the default sandbox.
          </div>
        )}
      </div>

      {error && <p className="text-[12px] text-destructive">{error}</p>}

      <div>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? <CircleNotch size={14} className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

/* ── Model (capability slots) ─────────────────────────────────────────── */

const IMAGE_MODELS: GatewayModel[] = [
  { id: "fal/fal-ai/flux/dev", provider: "fal", name: "flux/dev" },
  { id: "fal/fal-ai/flux/schnell", provider: "fal", name: "flux/schnell" },
  { id: "fal/fal-ai/flux-pro/v1.1", provider: "fal", name: "flux-pro v1.1" },
  { id: "openai/gpt-image-1", provider: "openai", name: "gpt-image-1" },
];
const STT_MODELS: GatewayModel[] = [
  { id: "openai/whisper-1", provider: "openai", name: "whisper-1" },
  { id: "openai/gpt-4o-transcribe", provider: "openai", name: "gpt-4o-transcribe" },
];
const TTS_MODELS: GatewayModel[] = [
  { id: "edge/edge-tts", provider: "edge", name: "edge-tts (free)" },
  { id: "openai/tts-1", provider: "openai", name: "tts-1" },
  { id: "openai/gpt-4o-mini-tts", provider: "openai", name: "gpt-4o-mini-tts" },
];
const VIDEO_MODELS: GatewayModel[] = [
  { id: "fal/luma-ray-2-flash", provider: "fal", name: "luma-ray-2-flash" },
  { id: "fal/luma-ray-2", provider: "fal", name: "luma-ray-2" },
];

function ModelPanel({
  projectId,
  agent,
}: {
  projectId: string;
  agent: AgentDetailData;
}) {
  const slots: Array<{
    field: string;
    label: string;
    desc: string;
    icon: ComponentType<{ size?: number; className?: string }>;
    current?: string;
    options?: GatewayModel[];
  }> = [
    { field: "model", label: "Text generation", desc: "Reasoning and tool calls", icon: TextAa, current: agent.model },
    { field: "vision_model", label: "Vision", desc: "Understands images", icon: Eye, current: agent.vision_model },
    { field: "image_model", label: "Image generation", desc: "Creates images from prompts", icon: ImageIcon, current: agent.image_model, options: IMAGE_MODELS },
    { field: "transcribe_model", label: "Speech-to-text", desc: "Transcribes audio", icon: Microphone, current: agent.transcribe_model, options: STT_MODELS },
    { field: "tts_model", label: "Text-to-speech", desc: "Generates speech", icon: SpeakerHigh, current: agent.tts_model, options: TTS_MODELS },
    { field: "video_model", label: "Video generation", desc: "Creates video from prompts", icon: VideoCamera, current: agent.video_model, options: VIDEO_MODELS },
  ];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        The model this agent uses for each capability. Text generation is the
        core; the others only apply when it works with images, audio, or video.
      </p>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
      {slots.map((s) => {
        const Icon = s.icon;
        return (
          <div
            key={s.field}
            className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5"
          >
            <div className="flex items-start gap-2.5">
              <Icon size={17} className="mt-0.5 shrink-0 text-muted-foreground" />
              <div>
                <div className="text-[14px] font-medium text-foreground">
                  {s.label}
                </div>
                {s.desc && (
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {s.desc}
                  </div>
                )}
              </div>
            </div>
            <ModelSelect
              projectId={projectId}
              agentName={agent.name}
              currentModel={s.current}
              field={s.field}
              options={s.options}
            />
          </div>
        );
      })}
      </div>
    </div>
  );
}

/* ── Instructions ─────────────────────────────────────────────────────── */

function InstructionsPanel({
  projectId,
  agentName,
  model,
  initial,
}: {
  projectId: string;
  agentName: string;
  model?: string;
  initial: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [mode, setMode] = useState<"read" | "edit">(initial ? "read" : "edit");
  const [promptOpen, setPromptOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== initial;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await mutateDataPlane(
        projectId,
        `/v1/agents/${encodeURIComponent(agentName)}`,
        { method: "PATCH", body: { systemPrompt: value } },
      );
      router.refresh();
      setMode("read");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-muted-foreground">
            Extra instructions appended to the agent&rsquo;s system prompt.
          </p>
          <span className="font-mono text-[11px] text-muted-foreground/50" data-tabular>
            {value.length} chars · ~{Math.ceil(value.length / 4)} tokens
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPromptOpen(true)}
          >
            <Gauge size={15} />
            Inspect prompt
          </Button>
          {mode === "read" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMode("edit")}
            >
              <PencilSimple size={15} />
              Refine
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <FloppyDisk size={14} />
                    Save
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setValue(initial);
                  setError(null);
                  setMode("read");
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      <PromptPreviewDialog
        projectId={projectId}
        agentName={agentName}
        model={model}
        open={promptOpen}
        onOpenChange={setPromptOpen}
      />

      {mode === "read" ? (
        value.trim() ? (
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground">
            <Markdown content={value} />
          </div>
        ) : (
          <EmptyBox>No instructions yet — click Edit to add them.</EmptyBox>
        )
      ) : (
        <>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            placeholder="You are a meticulous research assistant…"
            className={REFINE_TEXTAREA_CLASS}
          />
          {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}

/* ── Memory ───────────────────────────────────────────────────────────── */

function MemoryPanel({
  projectId,
  agentName,
  initial,
}: {
  projectId: string;
  agentName: string;
  initial: string;
}) {
  const router = useRouter();
  const polpo = usePolpoClient(projectId);
  const [value, setValue] = useState(initial);
  const [mode, setMode] = useState<"read" | "edit">(initial ? "read" : "edit");
  const [savedAt, setSavedAt] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== savedAt;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await polpo.saveAgentMemory(agentName, value);
      setSavedAt(value);
      setMode("read");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-[13px] text-muted-foreground">
            Persistent notes the agent reads and writes across runs (Markdown).
          </p>
          <span className="font-mono text-[11px] text-muted-foreground/50" data-tabular>
            {value.length} chars · ~{Math.ceil(value.length / 4)} tokens
          </span>
        </div>
        <div className="flex items-center gap-2">
          {mode === "read" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMode("edit")}
            >
              <PencilSimple size={15} />
              Refine
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <FloppyDisk size={14} />
                    Save memory
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setValue(savedAt);
                  setError(null);
                  setMode(savedAt ? "read" : "edit");
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {mode === "read" ? (
        value.trim() ? (
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground">
            <Markdown content={value} />
          </div>
        ) : (
          <EmptyBox>No agent memory yet. Click Refine to add it.</EmptyBox>
        )
      ) : (
        <>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            placeholder="Things this agent should remember across runs…"
            className={REFINE_TEXTAREA_CLASS}
          />
          {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
        </>
      )}
    </div>
  );
}
