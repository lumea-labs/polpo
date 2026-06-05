"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@polpo-ai/core";
import { usePolpoClient } from "../../../../../../../lib/polpo-client";
import { ManualRefreshButton } from "../../../../../../../components/dashboard/manual-refresh-button";
import type { BlueprintContext } from "../blueprint";

export interface LogEntry {
  ts: string;
  event: string;
  data: unknown;
}

export interface RunRecord {
  id: string;
  taskId: string;
  agentName: string;
  sessionId?: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  activity: {
    toolCalls: number;
    totalTokens: number;
    filesCreated: string[];
    filesEdited: string[];
    lastUpdate: string;
    summary?: string;
    sessionId?: string;
  };
}

export interface TaskActivityPayload {
  task: Task | null;
  run: RunRecord | null;
  sessionId: string | null;
  sessionResolution: "explicit" | "matched-log-session" | "missing";
  entries: LogEntry[];
  blueprint?: BlueprintContext | null;
}

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

interface Row {
  id: string;
  type: "tool_use" | "tool_result" | "assistant" | "event";
  ts: string;
  tool?: string;
  content?: string;
  state?: string;
  args?: string;
  isError?: boolean;
}

function parseEntries(entries: LogEntry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    const d = (entry.data ?? {}) as Record<string, unknown>;
    const type = (d.type as string) ?? (d.role as string) ?? entry.event.replace("transcript:", "");

    if (type === "tool_use" || entry.event === "transcript:tool_use") {
      const input = d.input ?? d.arguments;
      rows.push({
        id: `${entry.ts}-${rows.length}`,
        type: "tool_use",
        ts: entry.ts,
        tool: (d.tool ?? d.name ?? d.toolName) as string,
        args: input != null
          ? (typeof input === "string" ? input : JSON.stringify(input, null, 2))
          : undefined,
      });
    } else if (type === "tool_result" || entry.event === "transcript:tool_result") {
      const content = d.content ?? d.result ?? d.output ?? d.error;
      rows.push({
        id: `${entry.ts}-${rows.length}`,
        type: "tool_result",
        ts: entry.ts,
        tool: ((d.tool ?? d.name ?? d.toolName) as string | undefined) ?? "result",
        content: content != null ? String(content) : undefined,
        isError: Boolean(d.isError ?? d.error),
        state: (d.isError || d.error) ? "error" : undefined,
      });
    } else if (type === "assistant" || entry.event === "transcript:assistant") {
      const content = d.text ?? d.content ?? d.message;
      rows.push({
        id: `${entry.ts}-${rows.length}`,
        type: "assistant",
        ts: entry.ts,
        content: content != null ? String(content) : undefined,
      });
    } else {
      const content = typeof entry.data === "string"
        ? entry.data
        : d.text ?? d.content ?? d.message ?? d.result;
      rows.push({
        id: `${entry.ts}-${rows.length}`,
        type: "event",
        ts: entry.ts,
        tool: entry.event,
        content: content != null ? String(content) : undefined,
      });
    }
  }
  return rows.sort((a, b) => {
    const bTime = Date.parse(b.ts) || 0;
    const aTime = Date.parse(a.ts) || 0;
    return bTime - aTime;
  });
}

interface TaskActivityViewProps {
  projectId: string;
  taskId: string;
  initialActivity: TaskActivityPayload;
}

const ACTIVE_TASK_STATUSES = new Set(["pending", "assigned", "in_progress", "review", "awaiting_approval"]);

export default function TaskActivityView({
  projectId,
  taskId,
  initialActivity,
}: TaskActivityViewProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (rowId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
      return next;
    });
  };

  const polpo = usePolpoClient(projectId);
  const { data: activity = initialActivity, isFetching, refetch } = useQuery({
    queryKey: ["task-activity", projectId, taskId],
    queryFn: async () => {
      // Server returns the SDK's TaskActivityPayload shape; dashboard
      // augments with `blueprint` (set only via SSR pre-fetch in
      // page.tsx) to render the recurring-mission banner. We preserve
      // blueprint from initialData on refetch.
      const fresh = await polpo.getTaskActivityFull(taskId);
      return {
        ...fresh,
        blueprint: initialActivity.blueprint,
      } as unknown as TaskActivityPayload;
    },
    initialData: initialActivity,
    refetchInterval: (query) => {
      const current = query.state.data;
      const task = current?.task;
      const run = current?.run;
      return run?.status === "running" || Boolean(task && ACTIVE_TASK_STATUSES.has(task.status)) ? 3000 : false;
    },
  });

  const task = activity.task;
  const run = activity.run;
  const sessionId = activity.sessionId;
  const rows = parseEntries(activity.entries ?? []);
  const blueprint = activity.blueprint;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ManualRefreshButton onRefresh={() => refetch()} isRefreshing={isFetching} />
      </div>

      {blueprint && (
        <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-xs">
          <p className="font-medium text-foreground">Blueprint task</p>
          <p className="mt-1 text-muted-foreground">
            This is the template definition from mission <span className="font-mono">{blueprint.missionName}</span>.
            Runtime activity appears here only after the mission creates a real task instance.
          </p>
        </div>
      )}

      {/* Run info */}
      {run && (
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Agent: <span className="font-mono font-medium text-foreground">{run.agentName}</span></span>
          <span>Status: <span className="font-medium">{run.status}</span></span>
          {task?.result?.duration != null && (
            <span>Duration: <span className="font-mono font-medium text-foreground">{formatDuration(task.result.duration)}</span></span>
          )}
          {run.activity.toolCalls > 0 && (
            <span>Tools: <span className="font-mono font-medium text-foreground">{run.activity.toolCalls}</span></span>
          )}
          {activity.sessionResolution === "matched-log-session" && (
            <span>Matched logs by start time</span>
          )}
          {isFetching && <span>Updating...</span>}
        </div>
      )}

      {/* Transcript table */}
      {rows.length > 0 ? (
        <div className="border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium w-16">Type</th>
                <th className="px-3 py-2 text-left font-medium w-28">Tool</th>
                <th className="px-3 py-2 text-left font-medium w-20">Time</th>
                <th className="px-3 py-2 text-left font-medium w-20">State</th>
                <th className="px-3 py-2 text-left font-medium">Content</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((row) => {
                const isExpanded = expanded.has(row.id);

                return (
                  <tr
                    key={row.id}
                    onClick={() => toggle(row.id)}
                    className={`border-b border-border last:border-0 cursor-pointer transition-colors hover:bg-muted/20 ${
                      row.type === "tool_use" || row.type === "tool_result" ? "bg-muted/10" : ""
                    }`}
                  >
                    <td className="px-3 py-2 align-top">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        row.type === "tool_use"
                          ? "bg-blue-500/10 text-blue-400"
                          : row.type === "tool_result"
                            ? row.isError ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"
                            : row.type === "assistant"
                              ? "bg-foreground/10 text-foreground"
                              : "bg-muted-foreground/10 text-muted-foreground"
                      }`}>
                        {row.type === "tool_use" ? "call" : row.type === "tool_result" ? "result" : row.type === "assistant" ? "agent" : "event"}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground">
                      {row.tool ?? "—"}
                    </td>
                    <td className="px-3 py-2 align-top text-muted-foreground/60">
                      {formatTime(row.ts)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.state ? (
                        <span className={`inline-flex items-center gap-1 text-[10px] ${
                          row.state === "completed" ? "text-green-500" : "text-red-400"
                        }`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${
                            row.state === "completed" ? "bg-green-500" : "bg-red-500"
                          }`} />
                          {row.state}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {isExpanded ? (
                        <div className="space-y-3 pb-2">
                          {row.args && (
                            <div>
                              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">arguments</span>
                              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-muted-foreground max-h-40 overflow-auto">{row.args}</pre>
                            </div>
                          )}
                          {row.content && (
                            <div>
                              <span className={`text-[10px] uppercase tracking-wider ${row.isError ? "text-red-400" : "text-muted-foreground"}`}>
                                {row.type === "tool_result" ? (row.isError ? "error" : "result") : "content"}
                              </span>
                              <pre className={`mt-1 whitespace-pre-wrap break-words rounded bg-muted/50 p-2 max-h-60 overflow-auto ${
                                row.isError ? "text-red-400" : "text-foreground"
                              }`}>{row.content}</pre>
                            </div>
                          )}
                          {!row.args && !row.content && (
                            <span className="text-muted-foreground/40 italic">No data</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground truncate block max-w-md">
                          {row.args
                            ? row.args.substring(0, 80) + (row.args.length > 80 ? "…" : "")
                            : row.content
                              ? row.content.substring(0, 100) + (row.content.length > 100 ? "…" : "")
                              : <span className="text-muted-foreground/30 italic">—</span>
                          }
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="border border-border p-8 text-center text-sm text-muted-foreground">
          {blueprint
            ? "No runtime activity yet. Execute the mission to create a task instance."
            : sessionId
              ? "No activity recorded for this task."
              : run?.activity?.toolCalls
                ? "Tool calls were recorded, but no matching transcript session was found yet."
                : "No activity recorded for this task yet."}
        </div>
      )}

      {/* Outcomes */}
      {task?.outcomes && task.outcomes.length > 0 && (
        <div className="border border-border bg-card p-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-3">Outcomes</h3>
          <div className="space-y-2">
            {task.outcomes.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{o.type}</span>
                <span className="text-sm font-medium">{o.label}</span>
                {o.path && <span className="font-mono text-xs text-muted-foreground">{o.path}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
