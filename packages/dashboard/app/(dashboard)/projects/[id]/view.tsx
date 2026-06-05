"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AgentConfig, Task, Mission } from "@polpo-ai/core";
import { Users, ListChecks, Target, MessageSquare } from "lucide-react";
import { usePolpoClient } from "@/lib/polpo-client";
import { ManualRefreshButton } from "@/components/dashboard/manual-refresh-button";
import OnboardingChecklist, { deriveChecklistSteps, hasDeployedCheck } from "./onboarding-checklist";
import {
  SwarmStatusBar,
  SwarmRunList,
  type RunRow,
  type RunStatus,
  type RunCounts,
} from "@/components/dashboard/swarm-runs";

interface SessionInfo {
  id: string;
  title?: string;
  agent?: string;
  createdAt: string;
}

// Polpo Task.status → our RunStatus. The swarm taxonomy is broader
// (scheduled / cancelled exist as well) but Polpo doesn't surface those
// on a Task today — only on Missions / runs. "draft" + "assigned" both
// roll up to "pending" because users perceive them as "not yet started".
function toRunStatus(status: string): RunStatus {
  switch (status) {
    case "in_progress": return "running";
    case "review": return "review";
    case "done": return "done";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "draft":
    case "assigned":
    case "pending":
    default: return "pending";
  }
}

function buildSwarmCounts(tasks: Array<{ status: string }>): RunCounts {
  const c: RunCounts = {
    scheduled: 0, pending: 0, running: 0, review: 0,
    done: 0, failed: 0, cancelled: 0, total: tasks.length,
  };
  for (const t of tasks) c[toRunStatus(t.status)]++;
  return c;
}


export default function ProjectOverviewView({
  initialAgents,
  initialTasks,
  initialMissions,
  projectName,
  projectSlug,
  initialChecklist,
  welcomeBanner,
}: {
  initialAgents: AgentConfig[];
  initialTasks: Task[];
  initialMissions: Mission[];
  projectName: string;
  projectSlug?: string;
  initialChecklist?: import("@/lib/api").OnboardingChecklist;
  welcomeBanner?: React.ReactNode;
}) {
  const { id } = useParams<{ id: string }>();

  // Polling interval for checklist auto-completion (15s)
  const CHECKLIST_POLL = 15_000;

  const polpo = usePolpoClient(id);
  const { data: agents = [], isFetching: agentsFetching, refetch: refetchAgents } = useQuery({
    queryKey: ["agents", id],
    queryFn: () => polpo.getAgents() as unknown as Promise<AgentConfig[]>,
    initialData: initialAgents,
    refetchInterval: CHECKLIST_POLL,
  });

  const { data: tasks = [], isFetching: tasksFetching, refetch: refetchTasks } = useQuery({
    queryKey: ["tasks", id],
    queryFn: () => polpo.getTasks() as unknown as Promise<Task[]>,
    initialData: initialTasks,
    refetchInterval: CHECKLIST_POLL,
  });

  const { data: missions = [], isFetching: missionsFetching, refetch: refetchMissions } = useQuery({
    queryKey: ["missions", id],
    queryFn: () => polpo.getMissions() as unknown as Promise<Mission[]>,
    initialData: initialMissions,
    refetchInterval: CHECKLIST_POLL,
  });

  const { data: sessions = [], isFetching: sessionsFetching, refetch: refetchSessions } = useQuery({
    queryKey: ["sessions", id],
    queryFn: async () => {
      const r = await polpo.getSessions();
      return (r.sessions ?? []) as unknown as SessionInfo[];
    },
    refetchInterval: CHECKLIST_POLL,
  });

  const { data: skillsList = [], isFetching: skillsFetching, refetch: refetchSkills } = useQuery({
    queryKey: ["skills", id],
    queryFn: () => polpo.getSkills() as unknown as Promise<Array<{ name: string }>>,
    refetchInterval: CHECKLIST_POLL,
  });

  // Has any memory? Either shared or on any agent. A single truthy
  // signals the step done.
  const { data: hasMemory = false, isFetching: memoryFetching, refetch: refetchMemory } = useQuery({
    queryKey: ["memory-any", id, agents.map((a) => a.name).join(",")],
    queryFn: async () => {
      const shared = await polpo.getMemory().then((r) => r.exists === true).catch(() => false);
      if (shared) return true;
      for (const a of agents) {
        const agentMem = await polpo
          .getAgentMemory(a.name)
          .then((r) => r.exists === true)
          .catch(() => false);
        if (agentMem) return true;
      }
      return false;
    },
    enabled: agents.length > 0,
    refetchInterval: CHECKLIST_POLL,
  });

  // Persist onboarding checklist flags to control plane (idempotent).
  // initialChecklist comes from the SSR-fetched project row. We track
  // which flags we've already PATCHed in this session to avoid repeat
  // calls (the PATCH is idempotent anyway, but there's no point).
  const persistedFlags = useRef<Set<string>>(
    new Set(
      Object.entries(initialChecklist ?? {})
        .filter(([, v]) => typeof v === "string")
        .map(([k]) => k),
    ),
  );

  const derived = useMemo(() => ({
    firstCompletion: sessions.length > 0,
    firstSkill: skillsList.length > 0,
    firstMemory: hasMemory,
    firstTask: tasks.length > 0,
    firstDeploy: hasDeployedCheck(agents),
  }), [sessions, skillsList, hasMemory, agents, tasks]);

  useEffect(() => {
    const toSend: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(derived)) {
      if (value && !persistedFlags.current.has(key)) {
        toSend[key] = true;
      }
    }
    if (Object.keys(toSend).length === 0) return;

    const ctrl = new AbortController();
    fetch(`${process.env.NEXT_PUBLIC_API_URL}/v1/projects/${id}/onboarding-checklist`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toSend),
      signal: ctrl.signal,
    })
      .then(() => {
        for (const k of Object.keys(toSend)) persistedFlags.current.add(k);
      })
      .catch(() => { /* best-effort */ });

    return () => ctrl.abort();
  }, [derived, id]);

  // Single-pass derivation of all stats — avoids 13+ filter passes on every render
  const stats = useMemo(() => {
    let taskDone = 0, taskInProgress = 0, taskPending = 0, taskFailed = 0, taskReview = 0;
    const busyAgentNames = new Set<string>();

    for (const t of tasks) {
      const agent = t.assignTo ?? "";

      switch (t.status) {
        case "done": taskDone++; break;
        case "in_progress": taskInProgress++; busyAgentNames.add(agent); break;
        case "failed": taskFailed++; break;
        case "review": taskReview++; break;
        case "pending":
        case "assigned":
          taskPending++; break;
        case "draft": taskPending++; break;
      }
    }

    let missionActive = 0, missionCompleted = 0;
    for (const m of missions) {
      if (m.status === "active") missionActive++;
      else if (m.status === "completed") missionCompleted++;
    }

    const recentActivity = tasks
      .filter(t => t.updatedAt)
      .sort((a, b) => new Date(b.updatedAt!).getTime() - new Date(a.updatedAt!).getTime())
      .slice(0, 8)
      .map(t => ({
        time: new Date(t.updatedAt!).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
        date: new Date(t.updatedAt!).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        event: `${t.assignTo ?? "agent"} ${t.status === "done" ? "completed" : t.status === "in_progress" ? "started" : t.status === "failed" ? "failed" : "updated"} "${t.title}"`,
        type: t.status === "done" ? "success" : t.status === "failed" ? "error" : t.status === "in_progress" ? "active" : "info",
      }));

    return {
      taskDone, taskInProgress, taskPending, taskFailed, taskReview,
      missionActive, missionCompleted,
      isActive: taskInProgress > 0 || missionActive > 0,
      busyAgentNames,
      recentActivity,
    };
  }, [tasks, missions, agents]);

  const {
    taskDone, taskInProgress, taskFailed,
    missionActive, missionCompleted,
    isActive, busyAgentNames,
    recentActivity,
  } = stats;

  const isRefreshing = agentsFetching || tasksFetching || missionsFetching || sessionsFetching || skillsFetching || memoryFetching;

  async function refreshOverview() {
    await Promise.all([
      refetchAgents(),
      refetchTasks(),
      refetchMissions(),
      refetchSessions(),
      refetchSkills(),
      refetchMemory(),
    ]);
  }

  return (
    <div>
      {/* Project title + live state badge — always visible at page top */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl tracking-tight text-foreground">
            {projectName}
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            <span className={`h-1.5 w-1.5 rounded-full bg-brand ${isActive ? "animate-pulse" : ""}`} />
            {isActive ? "Running" : "Ready"}
          </span>
        </div>
        <ManualRefreshButton onRefresh={refreshOverview} isRefreshing={isRefreshing} className="shrink-0" />
      </div>

      {/* First-visit welcome banner — rendered by server parent when the
          ?welcome=1 flag is set. Sits between the title and the stats. */}
      {welcomeBanner}

      {/* Stats grid */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <Link href={`/projects/${id}/agents`} className="border border-border bg-card p-4 hover:border-foreground/10 transition-colors">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agents</span>
          </div>
          <span className="text-2xl font-extrabold">{agents.length}</span>
          {busyAgentNames.size > 0 && (
            <p className="text-[10px] text-brand mt-1">{busyAgentNames.size} busy</p>
          )}
        </Link>

        <Link href={`/projects/${id}/sessions`} className="border border-border bg-card p-4 hover:border-foreground/10 transition-colors">
          <div className="flex items-center gap-2 mb-2">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Chat Sessions</span>
          </div>
          <span className="text-2xl font-extrabold">{sessions.length}</span>
        </Link>

        <Link href={`/projects/${id}/tasks`} className="border border-border bg-card p-4 hover:border-foreground/10 transition-colors">
          <div className="flex items-center gap-2 mb-2">
            <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tasks</span>
          </div>
          <span className="text-2xl font-extrabold">{tasks.length}</span>
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            {taskDone > 0 && <span className="text-brand">{taskDone} done</span>}
            {taskInProgress > 0 && <span className="text-foreground">{taskInProgress} run</span>}
            {taskFailed > 0 && <span className="text-destructive">{taskFailed} fail</span>}
          </div>
        </Link>

        <Link href={`/projects/${id}/missions`} className="border border-border bg-card p-4 hover:border-foreground/10 transition-colors">
          <div className="flex items-center gap-2 mb-2">
            <Target className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Missions</span>
          </div>
          <span className="text-2xl font-extrabold">{missions.length}</span>
          <div className="flex items-center gap-2 mt-1 text-[10px]">
            {missionActive > 0 && <span className="text-foreground">{missionActive} active</span>}
            {missionCompleted > 0 && <span className="text-brand">{missionCompleted} done</span>}
          </div>
        </Link>

      </div>

      {/* Onboarding checklist — below stats, auto-derived from project data.
          Replaces recent activity while visible. */}
      {(() => {
        const checklistSteps = deriveChecklistSteps({
          hasSession: sessions.length > 0,
          hasSkill: skillsList.length > 0,
          hasMemory,
          hasTask: tasks.length > 0,
          hasDeployed: hasDeployedCheck(agents),
          projectSlug,
          projectId: id,
          apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
          agentName: agents[0]?.name,
          agentNames: agents.map((a) => a.name),
          agentConfigs: agents,
        });
        const allChecklistDone = checklistSteps.every((s) => s.completed);
        if (allChecklistDone) return null;
        return (
          <div className="mt-6">
            <OnboardingChecklist steps={checklistSteps} projectId={id} />
          </div>
        );
      })()}

      {/* Swarm status — custom status bar (all 7 run states, always
          shown — 0 across the board for a fresh project) + a scannable
          recent-runs list (only when there are tasks). The status bar is
          our own component, not @lumea-labs/orchestrator's, because that
          one is hardcoded to 3 buckets (running/done/failed). */}
      <div className="mt-8 flex flex-col gap-4">
        <SwarmStatusBar counts={buildSwarmCounts(tasks)} />

        {tasks.length > 0 && (
          <div className="border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Recent runs
              </h3>
              <Link
                href={`/projects/${id}/tasks`}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                View all →
              </Link>
            </div>
            <SwarmRunList
              runs={tasks
                .slice()
                .sort((a, b) =>
                  new Date(b.updatedAt ?? b.createdAt ?? 0).getTime()
                  - new Date(a.updatedAt ?? a.createdAt ?? 0).getTime(),
                )
                .slice(0, 8)
                .map<RunRow>((t) => ({
                  id: t.id,
                  status: toRunStatus(t.status),
                  agentName: t.assignTo ?? "—",
                  title: t.title ?? "Untitled task",
                  startedAt: t.updatedAt,
                  finishedAt: t.status === "done" || t.status === "failed"
                    ? t.updatedAt
                    : undefined,
                  href: `/projects/${id}/tasks/${t.id}`,
                }))}
            />
          </div>
        )}
      </div>

      {/* Recent activity — only shown once onboarding checklist is fully completed */}
      {(() => {
        const checkDone = sessions.length > 0
          && skillsList.length > 0
          && hasMemory
          && tasks.length > 0
          && hasDeployedCheck(agents);
        if (!checkDone) return null;
        return (
          <section className="mt-8">
            <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-3">Recent activity</h3>
            {recentActivity.length > 0 ? (
              <div className="border border-border overflow-hidden">
                {recentActivity.map((a, i) => (
                  <div key={`${a.date}-${a.time}-${a.event}-${i}`} className="flex items-center gap-3 border-b border-border last:border-0 px-4 py-2.5">
                    <span className="font-mono text-[10px] text-muted-foreground/40 w-20 shrink-0">
                      {a.date} {a.time}
                    </span>
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                      a.type === "success" ? "bg-brand"
                      : a.type === "error" ? "bg-destructive"
                      : a.type === "active" ? "bg-foreground animate-pulse"
                      : "bg-muted-foreground/30"
                    }`} />
                    <span className="text-xs text-muted-foreground truncate">{a.event}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-border p-8 text-center text-sm text-muted-foreground">
                No recent activity.
              </div>
            )}
          </section>
        );
      })()}
    </div>
  );
}
