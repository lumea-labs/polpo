"use client";

/**
 * Task Studio — the task detail surface as a single fast client component.
 *
 * Mirrors AgentStudio: a server shell fetches the initial task (and activity)
 * once, hands it to this ONE client component, which renders client-switched
 * tabs (Overview / Activity / Output / Assessment) via `useState` + a URL
 * `?tab=` param (instant, deep-linkable, no per-tab navigation).
 *
 * Pure dogfood: task data is fetched through the published SDK via
 * `usePolpoClient` (getTask + getTaskActivityFull), hydrated from the
 * server shell's `initialData`. No raw `dataApi`/`api` in the client.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ListChecks,
  FileText,
  Activity,
  Terminal,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@polpo-ai/core";
import { usePolpoClient } from "../../lib/polpo-client";
import { Breadcrumb } from "../../components/dashboard/breadcrumb";
import type { BlueprintContext } from "../../app/(dashboard)/projects/[id]/tasks/[taskId]/blueprint";
import TaskOverviewView from "../../app/(dashboard)/projects/[id]/tasks/[taskId]/view";
import TaskOutputView from "../../app/(dashboard)/projects/[id]/tasks/[taskId]/output/view";
import TaskAssessmentView from "../../app/(dashboard)/projects/[id]/tasks/[taskId]/assessment/view";
import TaskActivityView, {
  type TaskActivityPayload,
} from "../../app/(dashboard)/projects/[id]/tasks/[taskId]/activity/view";

const statusColor: Record<string, string> = {
  done: "bg-brand",
  in_progress: "bg-foreground animate-pulse",
  pending: "bg-muted-foreground/30",
  failed: "bg-destructive",
  review: "bg-yellow-500",
  assigned: "bg-muted-foreground/50",
  draft: "bg-muted-foreground/20",
  awaiting_approval: "bg-yellow-500",
};

const ACTIVE_TASK_STATUSES = new Set([
  "pending",
  "assigned",
  "in_progress",
  "review",
  "awaiting_approval",
]);

type StudioTab = "overview" | "activity" | "output" | "assessment";

const TABS: { key: StudioTab; label: string; icon: LucideIcon }[] = [
  { key: "overview", label: "Overview", icon: FileText },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "output", label: "Output", icon: Terminal },
  { key: "assessment", label: "Assessment", icon: ClipboardCheck },
];

export interface TaskStudioInitialData {
  task: Task | null;
  activity: TaskActivityPayload;
  blueprint: BlueprintContext | null;
}

export function TaskStudio({
  projectId,
  taskId,
  initialData,
}: {
  projectId: string;
  taskId: string;
  initialData: TaskStudioInitialData;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const polpo = usePolpoClient(projectId);

  // Tab is URL-driven (?tab=) so deep links work and the copilot can point
  // straight at a tab. Falls back to "overview".
  const urlTab = searchParams.get("tab") as StudioTab | null;
  const validUrlTab = urlTab && TABS.some((t) => t.key === urlTab) ? urlTab : null;
  const [tab, setTab] = useState<StudioTab>(validUrlTab ?? "overview");

  // React to external URL changes (back/forward, copilot navigation).
  useEffect(() => {
    if (validUrlTab && validUrlTab !== tab) setTab(validUrlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUrlTab]);

  function selectTab(key: StudioTab) {
    setTab(key);
    const params = new URLSearchParams(searchParams.toString());
    if (key === "overview") params.delete("tab");
    else params.set("tab", key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Single source of truth for the task — dogfood via SDK getTask, hydrated
  // from the server shell. When the task is a blueprint (no real instance yet)
  // there's nothing to fetch, so we keep the synthetic initialData.
  const isBlueprint = Boolean(initialData.blueprint) && !initialData.activity.task;
  const { data: task = initialData.task } = useQuery<Task | null>({
    queryKey: ["task", projectId, taskId],
    // SDK getTask returns its own re-exported Task shape; the views consume
    // the core Task. They're structurally equivalent — cast through unknown
    // to bridge the SDK/core type-export skew (see missions/view.tsx note).
    queryFn: () => polpo.getTask(taskId) as unknown as Promise<Task | null>,
    initialData: initialData.task,
    enabled: !isBlueprint,
    refetchInterval: (query) => {
      const t = query.state.data;
      return t && ACTIVE_TASK_STATUSES.has(t.status) ? 3000 : false;
    },
  });

  const blueprint = initialData.blueprint;

  if (!task) {
    return (
      <div className="flex h-[calc(100vh-7rem)] min-h-[520px] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 pb-3">
          <Breadcrumb
            items={[
              { label: "Tasks", href: `/projects/${projectId}/tasks`, icon: ListChecks },
              { label: taskId },
            ]}
          />
        </div>
        <div className="border border-border p-10 text-center">
          <FileText
            className="mx-auto h-5 w-5 text-muted-foreground/40"
            strokeWidth={1.5}
          />
          <p className="mt-2 text-sm text-muted-foreground">Task not found.</p>
          <Link
            href={`/projects/${projectId}/tasks`}
            className="mt-3 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Back to tasks
          </Link>
        </div>
      </div>
    );
  }

  return (
    // Fills the viewport (no page scroll); only the inner pane scrolls.
    <div className="flex h-[calc(100vh-7rem)] min-h-[520px] flex-col overflow-hidden">
      {/* Top bar — breadcrumb + status. Fixed (does not scroll). */}
      <div className="flex shrink-0 items-center gap-2 pb-3">
        <Breadcrumb
          items={[
            { label: "Tasks", href: `/projects/${projectId}/tasks`, icon: ListChecks },
            { label: task.title || taskId },
          ]}
        />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${statusColor[task.status ?? "pending"]}`}
          />
          <span className="font-medium text-foreground">{task.status}</span>
        </div>
      </div>

      {/* Sticky tab nav (does not scroll) */}
      <div className="shrink-0 pr-4">
        <div className="flex flex-wrap gap-1 border-b border-border">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => selectTab(t.key)}
                className={`relative flex items-center gap-1.5 px-3 py-2 text-sm transition-colors ${
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t.label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Only the tab content scrolls */}
      <div className="min-h-0 flex-1 overflow-auto py-4 pr-4">
        {tab === "overview" && (
          <TaskOverviewView task={task} blueprint={blueprint ?? undefined} />
        )}
        {tab === "activity" && (
          <TaskActivityView
            projectId={projectId}
            taskId={taskId}
            initialActivity={initialData.activity}
          />
        )}
        {tab === "output" && (
          <TaskOutputView task={task} blueprint={blueprint} />
        )}
        {tab === "assessment" && (
          <TaskAssessmentView task={task} blueprint={blueprint} />
        )}
      </div>
    </div>
  );
}
