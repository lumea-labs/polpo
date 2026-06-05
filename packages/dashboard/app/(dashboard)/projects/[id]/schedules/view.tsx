"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  RefreshCw,
  Clock,
  Loader2,
  Pause,
  Play,
  Pencil,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import type { Mission, ScheduleEntry, UpdateScheduleRequest } from "@polpo-ai/sdk";
import { usePolpoClient } from "../../../../../lib/polpo-client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../../../../components/ui/dialog";

/**
 * Schedules — client + pure-dogfood list of the project's active schedules.
 *
 * Schedules are mission-bound: an entry exists for every mission with a
 * `schedule` set. Reads + inline actions all go through the published SDK
 * (`usePolpoClient`): `getSchedules`/`getMissions` for the list, and
 * `updateSchedule`/`deleteSchedule` (keyed by mission id) for pause/resume,
 * edit-cron and delete. No raw `dataApi`/`api`. A schedule has no standalone
 * detail (it's a cron on a mission), so rows link to the mission's page.
 */

const typeBadge: Record<string, { label: string; className: string }> = {
  recurring: { label: "Recurring", className: "bg-blue-500/10 text-blue-400" },
  "one-shot": { label: "One-shot", className: "bg-amber-500/10 text-amber-400" },
};

type ScheduleRow = ScheduleEntry & {
  missionName?: string;
  executionCount?: number;
};

function relativeTime(date?: string, mode: "past" | "future" = "past"): string {
  if (!date) return "—";
  const now = Date.now();
  const target = new Date(date).getTime();
  const diff = mode === "future" ? target - now : now - target;
  if (diff < 0) return mode === "future" ? "due" : "—";
  const min = Math.floor(diff / 60_000);
  const prefix = mode === "future" ? "in " : "";
  const suffix = mode === "past" ? " ago" : "";
  if (min < 1) return mode === "future" ? "<1m" : "just now";
  if (min < 60) return `${prefix}${min}m${suffix}`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${prefix}${hours}h${suffix}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${prefix}${days}d${suffix}`;
  return new Date(date).toLocaleDateString();
}

function isoTooltip(date?: string): string {
  return date ? new Date(date).toISOString() : "";
}

export default function SchedulesView({
  initialSchedules,
  initialMissions,
}: {
  initialSchedules: ScheduleEntry[];
  initialMissions: Mission[];
}) {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const polpo = usePolpoClient(id);

  const { data: schedules = [], isFetching, refetch } = useQuery({
    queryKey: ["schedules", id],
    queryFn: () => polpo.getSchedules(),
    initialData: initialSchedules,
  });

  const { data: missions = [] } = useQuery({
    queryKey: ["missions", id],
    queryFn: () => polpo.getMissions(),
    initialData: initialMissions,
  });

  const missionById = useMemo(
    () => new Map(missions.map((m) => [m.id, m])),
    [missions],
  );

  const rows: ScheduleRow[] = useMemo(
    () =>
      schedules.map((s) => {
        const mission = missionById.get(s.missionId);
        return { ...s, missionName: mission?.name, executionCount: mission?.executionCount };
      }),
    [schedules, missionById],
  );

  // ── Mutations (dogfood SDK) — keyed by mission id, per the SDK signature.
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["schedules", id] });

  const updateMutation = useMutation({
    mutationFn: ({ missionId, patch }: { missionId: string; patch: UpdateScheduleRequest }) =>
      polpo.updateSchedule(missionId, patch),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (missionId: string) => polpo.deleteSchedule(missionId),
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
    },
  });

  const [editTarget, setEditTarget] = useState<ScheduleRow | null>(null);
  const [editExpression, setEditExpression] = useState("");
  const [editRecurring, setEditRecurring] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleRow | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  function openEdit(row: ScheduleRow) {
    setEditTarget(row);
    setEditExpression(row.expression);
    setEditRecurring(row.recurring);
  }
  function saveEdit() {
    if (!editTarget) return;
    updateMutation.mutate(
      { missionId: editTarget.missionId, patch: { expression: editExpression.trim(), recurring: editRecurring } },
      { onSuccess: () => setEditTarget(null) },
    );
  }
  function toggleEnabled(row: ScheduleRow) {
    setTogglingId(row.id);
    updateMutation.mutate(
      { missionId: row.missionId, patch: { enabled: !row.enabled } },
      { onSettled: () => setTogglingId(null) },
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Schedules</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {schedules.length} active {schedules.length === 1 ? "schedule" : "schedules"}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {rows.length > 0 ? (
        <div className="mt-4 border border-border overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-20">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Mission</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-24">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-32">Expression</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-28">Next run</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-16">Runs</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground w-28">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const type = row.recurring ? "recurring" : "one-shot";
                const badge = typeBadge[type];
                const isOrphan = !row.missionName;
                const isToggling = togglingId === row.id;
                return (
                  <tr
                    key={row.id}
                    className="border-b border-border last:border-0 hover:bg-secondary/30 transition-colors"
                  >
                    <td className="px-4 py-3 w-20">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`h-2 w-2 rounded-full ${row.enabled ? "bg-brand" : "bg-muted-foreground/30"}`}
                        />
                        <span className="text-xs text-muted-foreground">
                          {row.enabled ? "Active" : "Paused"}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {isOrphan ? (
                        <span className="font-mono text-xs italic text-muted-foreground">
                          mission {row.missionId.slice(0, 8)}… (deleted)
                        </span>
                      ) : (
                        <Link
                          href={`/projects/${id}/missions/${row.missionId}`}
                          className="font-mono text-xs font-medium hover:underline underline-offset-2"
                        >
                          {row.missionName}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 w-24">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 w-32 font-mono text-xs text-muted-foreground">{row.expression}</td>
                    <td
                      className="px-4 py-3 w-28 text-xs text-muted-foreground"
                      title={isoTooltip(row.nextRunAt)}
                    >
                      {relativeTime(row.nextRunAt, "future")}
                    </td>
                    <td className="px-4 py-3 w-16 text-xs text-muted-foreground">{row.executionCount ?? 0}</td>
                    <td className="px-4 py-3 w-28">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => toggleEnabled(row)}
                          disabled={isToggling}
                          title={row.enabled ? "Pause schedule" : "Resume schedule"}
                          className="inline-flex h-7 w-7 items-center justify-center border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
                        >
                          {isToggling ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : row.enabled ? (
                            <Pause className="h-3.5 w-3.5" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => openEdit(row)}
                          title="Edit cron expression"
                          className="inline-flex h-7 w-7 items-center justify-center border border-border text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(row)}
                          title="Delete schedule"
                          className="inline-flex h-7 w-7 items-center justify-center border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState />
      )}

      {/* Edit-cron dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit schedule</DialogTitle>
            <DialogDescription>
              {editTarget?.missionName
                ? `Cron + recurrence for "${editTarget.missionName}".`
                : "Update the cron expression and recurrence for this schedule."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div>
              <label className="mb-1 block font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/60">
                Cron expression
              </label>
              <input
                value={editExpression}
                onChange={(e) => setEditExpression(e.target.value)}
                placeholder="0 9 * * *"
                className="h-8 w-full border border-border bg-transparent px-3 font-mono text-xs placeholder:text-muted-foreground/30 focus:border-foreground/30 focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={editRecurring}
                onChange={(e) => setEditRecurring(e.target.checked)}
                className="h-3.5 w-3.5 accent-foreground"
              />
              Recurring (re-run on every cron tick)
            </label>
            <div className="flex items-center justify-end gap-2 pt-1">
              {updateMutation.isError && (
                <span className="mr-auto text-[10px] text-destructive">Failed — check the expression.</span>
              )}
              <button
                onClick={() => setEditTarget(null)}
                className="px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={!editExpression.trim() || updateMutation.isPending}
                className="inline-flex items-center gap-1.5 border border-foreground bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-40"
              >
                {updateMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete-confirm dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" strokeWidth={1.5} />
              Delete schedule
            </DialogTitle>
            <DialogDescription>
              Remove the schedule for{" "}
              <span className="font-mono font-medium text-foreground">
                {deleteTarget?.missionName ?? `mission ${deleteTarget?.missionId.slice(0, 8)}…`}
              </span>
              ? The mission itself is kept — only the cron is removed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-end gap-2 pt-1">
            {deleteMutation.isError && (
              <span className="mr-auto text-[10px] text-destructive">Failed to delete.</span>
            )}
            <button
              onClick={() => setDeleteTarget(null)}
              className="px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.missionId)}
              disabled={deleteMutation.isPending}
              className="inline-flex items-center gap-1.5 border border-destructive bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {deleteMutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Delete
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mt-4 border border-border p-10 text-center">
      <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-secondary/50">
        <Clock className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-medium">No schedules yet</h3>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
        Schedule a mission to run automatically on a cron expression or a one-shot date.
        Currently supported: <span className="font-medium text-foreground">missions</span>.
        Coming soon: scheduled completions and channel delivery.
      </p>
      <p className="mt-3 text-[11px] text-muted-foreground/60">
        Create via <code className="rounded bg-secondary/50 px-1 py-0.5 font-mono">POST /v1/schedules</code>
      </p>
    </div>
  );
}
