"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Play, Square, RotateCcw, GitBranch, List, Braces, Copy, Check, History } from "lucide-react";
// Mixed imports — see OSS issue tracking SDK type-export bugs:
//   1. NotificationRule.condition is `unknown` in SDK 0.7.9 (typed in core)
//   2. Task type is missing `missionId` in SDK 0.7.9 (present in core)
// Until SDK 0.7.10 re-exports cleanly from core, we use the type that works.
// `Task` from core because we need `missionId` to filter. `Mission` doesn't matter
// here — both shapes are equivalent for what this file consumes.
import type { Mission, Task } from "@polpo-ai/core";
import { usePolpoClient } from "@/lib/polpo-client";
import { MissionGraph } from "@/components/dashboard/mission-graph";
import { ManualRefreshButton } from "@/components/dashboard/manual-refresh-button";

function highlightJson(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*(:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, num) => {
      if (str) {
        if (colon) {
          // key
          return `<span style="color:oklch(0.75 0.1 250)">${str}</span>:`;
        }
        // string value
        return `<span style="color:oklch(0.75 0.15 155)">${str}</span>`;
      }
      if (bool) return `<span style="color:oklch(0.7 0.15 30)">${bool}</span>`;
      if (num) return `<span style="color:oklch(0.8 0.12 80)">${num}</span>`;
      return match;
    },
  );
}

const statusColor: Record<string, string> = {
  completed: "bg-brand",
  active: "bg-foreground animate-pulse",
  failed: "bg-destructive",
  paused: "bg-yellow-500",
  draft: "bg-muted-foreground/20",
  done: "bg-brand",
  in_progress: "bg-foreground animate-pulse",
  pending: "bg-muted-foreground/30",
  assigned: "bg-muted-foreground/50",
  review: "bg-yellow-500",
  awaiting_approval: "bg-yellow-500",
  recurring: "bg-blue-500",
  scheduled: "bg-blue-500/50",
};

function formatDate(d: string | undefined) {
  if (!d) return "\u2014";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export function MissionHeader({
  projectId,
  missionId,
  initialMission,
}: {
  projectId: string;
  missionId: string;
  initialMission: Mission | null;
}) {
  const queryClient = useQueryClient();
  const [recentlyExecuted, setRecentlyExecuted] = useState(false);
  const polpo = usePolpoClient(projectId);

  const { data: mission = null, isFetching, refetch } = useQuery({
    queryKey: ["mission", projectId, missionId],
    queryFn: () => polpo.getMission(missionId) as unknown as Promise<Mission | null>,
    initialData: initialMission,
    refetchInterval: (query) => {
      const m = query.state.data;
      return m?.status === "active" || recentlyExecuted ? 5000 : false;
    },
  });

  const executeMutation = useMutation({
    mutationFn: () => polpo.executeMission(missionId),
    onMutate: () => {
      setRecentlyExecuted(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mission", projectId, missionId] });
      queryClient.invalidateQueries({ queryKey: ["mission-tasks", projectId, missionId] });
    },
    onSettled: () => {
      window.setTimeout(() => setRecentlyExecuted(false), 30000);
    },
  });

  const resumeMutation = useMutation({
    mutationFn: () => polpo.resumeMission(missionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mission", projectId, missionId] });
      queryClient.invalidateQueries({ queryKey: ["mission-tasks", projectId, missionId] });
    },
  });

  const abortMutation = useMutation({
    mutationFn: () =>
      polpo.abortMission(missionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mission", projectId, missionId] });
      queryClient.invalidateQueries({ queryKey: ["mission-tasks", projectId, missionId] });
    },
  });

  if (!mission) {
    return (
      <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
        Mission not found.
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor[mission.status ?? "draft"]}`} />
          <h2 className="text-lg font-extrabold tracking-tight font-mono">{mission.name}</h2>
        </div>
        <ManualRefreshButton
          onRefresh={() => Promise.all([
            refetch(),
            queryClient.invalidateQueries({ queryKey: ["mission-tasks", projectId, missionId] }),
          ])}
          isRefreshing={isFetching}
          className="mt-1 shrink-0"
        />
      </div>
      {mission.prompt && (
        <p className="mt-2 text-sm text-muted-foreground">{mission.prompt}</p>
      )}

      {/* Meta inline */}
      <div className="mt-4 flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
        <span>Status: <span className="font-medium text-foreground">{mission.status}</span></span>
        <span>Runs: <span className="font-mono font-medium text-foreground">{mission.executionCount ?? 0}</span></span>
        {mission.schedule && <span>Schedule: <span className="font-mono font-medium text-foreground">{mission.schedule}</span></span>}
        {mission.deadline && <span>Deadline: <span className="font-medium text-foreground">{formatDate(mission.deadline)}</span></span>}
        <span className="text-muted-foreground/40">Created {formatDate(mission.createdAt)}</span>
      </div>

      {/* Actions */}
      <div className="mt-5 flex gap-3">
        {mission.status === "draft" && (
          <button
            onClick={() => executeMutation.mutate()}
            disabled={executeMutation.isPending}
            className="inline-flex items-center gap-2 bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
          >
            {executeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Execute
          </button>
        )}
        {(mission.status === "failed" || mission.status === "paused") && (
          <button
            onClick={() => resumeMutation.mutate()}
            disabled={resumeMutation.isPending}
            className="inline-flex items-center gap-2 bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
          >
            {resumeMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Resume
          </button>
        )}
        {mission.status === "active" && (
          <button
            onClick={() => abortMutation.mutate()}
            disabled={abortMutation.isPending}
            className="inline-flex items-center gap-2 border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            {abortMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            Abort
          </button>
        )}
      </div>
    </div>
  );
}

type TaskView = "graph" | "table" | "json" | "runs";
const TASK_VIEWS: readonly TaskView[] = ["graph", "table", "json", "runs"] as const;

export function MissionTasksPanel({
  projectId,
  missionId,
  initialTasks,
  initialMission,
}: {
  projectId: string;
  missionId: string;
  initialTasks: Task[];
  initialMission?: Mission | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isRecurringOrScheduled =
    initialMission?.status === "recurring" || initialMission?.status === "scheduled";
  // Task view is URL-driven (?tab=) → deep-linkable, like agent/task studio.
  // "runs" only exists on recurring/scheduled missions; guard it.
  const urlTab = searchParams.get("tab") as TaskView | null;
  const validUrlTab =
    urlTab && TASK_VIEWS.includes(urlTab) && (urlTab !== "runs" || isRecurringOrScheduled)
      ? urlTab
      : null;
  const [taskView, setTaskView] = useState<TaskView>(validUrlTab ?? "graph");
  useEffect(() => {
    if (validUrlTab && validUrlTab !== taskView) setTaskView(validUrlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUrlTab]);
  function selectView(key: TaskView) {
    setTaskView(key);
    const params = new URLSearchParams(searchParams.toString());
    if (key === "graph") params.delete("tab");
    else params.set("tab", key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }
  const [copied, setCopied] = useState(false);
  const polpo = usePolpoClient(projectId);

  const { data: missionTasks = [] } = useQuery({
    queryKey: ["mission-tasks", projectId, missionId],
    queryFn: async () => {
      // SDK TaskFilters has status/group/assignTo but no missionId — track:
      // todo-sdk-task-filters-missionid. Workaround: fetch all + filter
      // client-side (same as the pre-SDK call did).
      const all = (await polpo.getTasks()) as unknown as Task[];
      return all.filter((t) => t.missionId === missionId);
    },
    initialData: initialTasks,
    refetchInterval: (query) => {
      const tasks = query.state.data ?? [];
      const hasActive = tasks.some(
        (t) => t.status === "in_progress" || t.status === "pending" || t.status === "assigned" || t.status === "review",
      );
      return hasActive ? 5000 : false;
    },
  });

  // Preview: when no tasks have been spawned yet (mission is draft) but the
  // mission document defines them in `mission.data`, synthesize Task-shaped
  // objects so the user sees the planned DAG before clicking Execute. The
  // mission document references dependsOn by task TITLE (not id, since
  // titles are unique within the document); we mirror that by using the
  // title as the synthetic id — MissionGraph then wires edges correctly.
  const previewTasks = useMemo<Task[] | null>(() => {
    if (missionTasks.length > 0) return null;
    if (!initialMission?.data) return null;
    try {
      const raw = typeof initialMission.data === "string"
        ? JSON.parse(initialMission.data)
        : initialMission.data;
      if (!raw?.tasks || !Array.isArray(raw.tasks)) return null;
      const created = initialMission.createdAt ?? new Date().toISOString();
      return raw.tasks.map((t: { title: string; description?: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[] }) => ({
        id: t.title,
        title: t.title,
        description: t.description ?? "",
        assignTo: t.assignTo ?? "—",
        status: "draft" as const,
        expectations: (t.expectations ?? []) as Task["expectations"],
        expectedOutcomes: (t.expectedOutcomes ?? []) as Task["expectedOutcomes"],
        dependsOn: t.dependsOn ?? [],
        missionId,
        retries: 0,
        maxRetries: 0,
        createdAt: created,
        updatedAt: created,
      })) as Task[];
    } catch {
      return null;
    }
  }, [missionTasks.length, initialMission, missionId]);

  const isPreview = missionTasks.length === 0 && (previewTasks?.length ?? 0) > 0;
  const tasksToRender = isPreview ? previewTasks! : missionTasks;

  if (tasksToRender.length === 0) {
    return (
      <section className="mt-4">
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No tasks in this mission yet.
        </div>
      </section>
    );
  }

  // Stats
  const done = tasksToRender.filter(t => t.status === "done").length;
  const failed = tasksToRender.filter(t => t.status === "failed").length;
  const inProgress = tasksToRender.filter(t => t.status === "in_progress" || t.status === "review").length;

  return (
    <section className="mt-4">
      {/* Preview banner — mission is draft, tasks shown are from mission.data,
          not actual spawned task records. They'll be created on Execute. */}
      {isPreview && (
        <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Preview</span> — these {tasksToRender.length} task{tasksToRender.length === 1 ? "" : "s"} will be created when you execute the mission.
        </div>
      )}

      {/* Task stats — only for real spawned tasks (preview has no runtime state) */}
      {!isPreview && (
        <div className="mb-4 flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
          <span>Tasks: <span className="font-medium text-foreground">{done}/{tasksToRender.length} done</span></span>
          {inProgress > 0 && <span>In progress: <span className="font-medium text-foreground">{inProgress}</span></span>}
          {failed > 0 && <span>Failed: <span className="font-medium text-destructive">{failed}</span></span>}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
          <button
            onClick={() => selectView("graph")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              taskView === "graph" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitBranch className="h-3.5 w-3.5" />
            Graph
          </button>
          <button
            onClick={() => selectView("table")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              taskView === "table" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            Table
          </button>
          <button
            onClick={() => selectView("json")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              taskView === "json" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Braces className="h-3.5 w-3.5" />
            JSON
          </button>
          {isRecurringOrScheduled && !isPreview && (
            <button
              onClick={() => selectView("runs")}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                taskView === "runs" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <History className="h-3.5 w-3.5" />
              Runs
            </button>
          )}
        </div>
      </div>

      <div className="mt-3">
        {taskView === "runs" ? (
          <RunsView tasks={missionTasks} projectId={projectId} />
        ) : taskView === "graph" ? (
          <MissionGraph tasks={tasksToRender} projectId={projectId} />
        ) : taskView === "json" ? (
          <div className="border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/40">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Tasks JSON</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify({ tasks: tasksToRender }, null, 2));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre
              className="p-4 text-xs font-mono overflow-y-auto max-h-[560px] whitespace-pre-wrap break-all"
              dangerouslySetInnerHTML={{
                __html: highlightJson(JSON.stringify({ tasks: tasksToRender }, null, 2)),
              }}
            />
          </div>
        ) : (
          <div className="border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium w-8"></th>
                  <th className="px-4 py-2.5 text-left font-medium">Task</th>
                  <th className="px-4 py-2.5 text-left font-medium w-24">Agent</th>
                  <th className="px-4 py-2.5 text-left font-medium w-24">Status</th>
                  <th className="px-4 py-2.5 text-left font-medium w-32 hidden sm:table-cell">Dependencies</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {tasksToRender.map((task) => (
                  <tr key={task.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <span className={`h-2.5 w-2.5 rounded-full inline-block ${statusColor[task.status ?? "pending"]}`} />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${projectId}/tasks/${task.id}`}
                        className="text-sm font-medium hover:underline underline-offset-2"
                      >
                        {task.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{task.assignTo}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 text-[10px] ${
                        task.status === "done" ? "text-brand" :
                        task.status === "failed" ? "text-destructive" :
                        task.status === "in_progress" ? "text-foreground" :
                        "text-muted-foreground"
                      }`}>
                        {task.status}
                        {task.phase && task.status === "in_progress" && (
                          <span className="text-muted-foreground/50">({task.phase})</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground/50 hidden sm:table-cell">
                      {task.dependsOn && task.dependsOn.length > 0
                        ? task.dependsOn.map(dep => {
                            const depTask = tasksToRender.find(t => t.id === dep);
                            return depTask?.title ?? dep.slice(0, 8);
                          }).join(", ")
                        : "\u2014"
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ── Runs view ───────────────────────────────────────────────────────────────
//
// For recurring / scheduled missions, the mission is fired repeatedly and
// each fire instantiates a fresh batch of tasks from `mission.data.tasks`.
// All tasks in a single fire are inserted within ~1 second of each other,
// so we cluster by `created_at` proximity (60s window) and treat each
// cluster as one "run". Newest fires first.
//
// Status badge per run is derived: failed > in-progress > done.

interface RunCluster {
  startedAt: string;
  tasks: Task[];
}

const RUN_CLUSTER_WINDOW_MS = 60_000;

function clusterTaskRuns(tasks: Task[]): RunCluster[] {
  if (tasks.length === 0) return [];
  // Sort newest first by createdAt
  const sorted = [...tasks].sort((a, b) =>
    new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
  );
  const clusters: RunCluster[] = [];
  let current: RunCluster | null = null;
  for (const task of sorted) {
    const ts = new Date(task.createdAt ?? 0).getTime();
    if (!current || Math.abs(new Date(current.startedAt).getTime() - ts) > RUN_CLUSTER_WINDOW_MS) {
      current = { startedAt: task.createdAt ?? new Date().toISOString(), tasks: [task] };
      clusters.push(current);
    } else {
      current.tasks.push(task);
    }
  }
  return clusters;
}

function runStatus(tasks: Task[]): { label: string; className: string } {
  if (tasks.some(t => t.status === "failed")) return { label: "failed", className: "bg-destructive/10 text-destructive" };
  if (tasks.some(t => t.status === "in_progress" || t.status === "assigned" || t.status === "review" || t.status === "pending")) {
    return { label: "running", className: "bg-amber-500/10 text-amber-500" };
  }
  if (tasks.every(t => t.status === "done")) return { label: "done", className: "bg-emerald-500/10 text-emerald-500" };
  return { label: "unknown", className: "bg-muted text-muted-foreground" };
}

function formatRunTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return d.toLocaleString();
}

function RunsView({ tasks, projectId }: { tasks: Task[]; projectId: string }) {
  const runs = useMemo(() => clusterTaskRuns(tasks), [tasks]);

  if (runs.length === 0) {
    return (
      <div className="border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No runs yet. This mission hasn’t fired since it was scheduled.
      </div>
    );
  }

  return (
    <div className="border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium w-32">Started</th>
            <th className="px-4 py-2.5 text-left font-medium w-20">Tasks</th>
            <th className="px-4 py-2.5 text-left font-medium w-24">Status</th>
            <th className="px-4 py-2.5 text-left font-medium">Tasks in this run</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, idx) => {
            const status = runStatus(run.tasks);
            return (
              <tr key={`${run.startedAt}-${idx}`} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 text-muted-foreground" title={new Date(run.startedAt).toISOString()}>
                  {formatRunTimestamp(run.startedAt)}
                </td>
                <td className="px-4 py-3 text-foreground font-medium">{run.tasks.length}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-medium ${status.className}`}>
                    {status.label}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {run.tasks.map((t) => (
                      <Link
                        key={t.id}
                        href={`/projects/${projectId}/tasks/${t.id}`}
                        className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted/40 transition-colors"
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${statusColor[t.status ?? "pending"]}`} />
                        {t.title}
                      </Link>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
