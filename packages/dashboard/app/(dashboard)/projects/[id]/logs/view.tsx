"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { usePolpoClient } from "../../../../../lib/polpo-client";
import { LogsViewSkeleton, LogsEntriesSkeleton } from "../../../../../components/dashboard/skeletons";
import { ManualRefreshButton } from "../../../../../components/dashboard/manual-refresh-button";

interface SessionInfo {
  sessionId: string;
  startedAt: string;
  entries: number;
}

interface LogEntry {
  ts: string;
  event: string;
  data: unknown;
}

const eventColor: Record<string, string> = {
  "task:created": "text-blue-500",
  "task:transition": "text-foreground",
  "task:updated": "text-muted-foreground",
  "agent:spawned": "text-green-500",
  "agent:finished": "text-green-600",
  "agent:activity": "text-muted-foreground",
  "assessment:started": "text-yellow-500",
  "assessment:complete": "text-yellow-600",
  "mission:started": "text-blue-500",
  "mission:completed": "text-green-500",
  "mission:failed": "text-destructive",
  "log": "text-muted-foreground",
};

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(ts: string) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function summarizeData(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const parts: string[] = [];
  if (d.id) parts.push(`id:${String(d.id).slice(0, 8)}`);
  if (d.title) parts.push(String(d.title));
  if (d.name) parts.push(String(d.name));
  if (d.from && d.to) parts.push(`${d.from} → ${d.to}`);
  if (d.status) parts.push(String(d.status));
  if (d.agent) parts.push(String(d.agent));
  return parts.join(" · ");
}

export default function LogsView() {
  const { id } = useParams<{ id: string }>();
  const [selectedSession, setSelectedSession] = useState<string | null>(null);

  const polpo = usePolpoClient(id);
  const { data: sessions = [], isLoading, isFetching: sessionsFetching, refetch: refetchSessions } = useQuery({
    queryKey: ["log-sessions", id],
    queryFn: () => polpo.getLogs() as unknown as Promise<SessionInfo[]>,
  });

  const { data: entries = [], isLoading: loadingEntries, isFetching: entriesFetching, refetch: refetchEntries } = useQuery({
    queryKey: ["log-entries", id, selectedSession],
    queryFn: () => polpo.getLogEntries(selectedSession!) as unknown as Promise<LogEntry[]>,
    enabled: !!selectedSession,
  });

  if (isLoading) {
    return <div data-testid="logs-loading"><LogsViewSkeleton /></div>;
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Orchestrator session logs. Each session captures events from a single
            orchestrator run.
          </p>
        </div>
        <ManualRefreshButton
          onRefresh={() => Promise.all([refetchSessions(), selectedSession ? refetchEntries() : Promise.resolve()])}
          isRefreshing={sessionsFetching || entriesFetching}
          className="mt-1 shrink-0"
        />
      </div>

      <div className="mt-6 flex gap-6">
        {/* Session list */}
        <div data-testid="logs-sessions" className="w-64 shrink-0">
          <p className="text-xs font-medium text-muted-foreground mb-3">
            {sessions.length} sessions
          </p>
          {sessions.length > 0 ? (
            <div className="border border-border overflow-hidden">
              {sessions.map((s) => (
                <button
                  key={s.sessionId}
                  onClick={() => setSelectedSession(s.sessionId)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border last:border-0 transition-colors ${
                    selectedSession === s.sessionId
                      ? "bg-secondary"
                      : "hover:bg-secondary/30"
                  }`}
                >
                  <p className="font-mono text-xs font-medium truncate">
                    {s.sessionId.slice(0, 12)}...
                  </p>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{timeAgo(s.startedAt)}</span>
                    <span>{s.entries} events</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div data-testid="logs-sessions-empty" className="border border-border p-6 text-center text-xs text-muted-foreground">
              No sessions yet.
            </div>
          )}
        </div>

        {/* Log entries */}
        <div className="flex-1 min-w-0">
          {selectedSession ? (
            loadingEntries ? (
              <div data-testid="logs-entries-loading">
                <LogsEntriesSkeleton />
              </div>
            ) : entries.length > 0 ? (
              <div data-testid="logs-entries" className="border border-border overflow-hidden">
                {entries.map((entry, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 border-b border-border last:border-0 px-3 py-2 font-mono text-xs"
                  >
                    <span className="text-muted-foreground/40 w-16 shrink-0 pt-0.5">
                      {formatTime(entry.ts)}
                    </span>
                    <span
                      className={`shrink-0 pt-0.5 w-40 truncate font-medium ${
                        eventColor[entry.event] ?? "text-muted-foreground"
                      }`}
                    >
                      {entry.event}
                    </span>
                    <span className="text-muted-foreground truncate">
                      {summarizeData(entry.data)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div data-testid="logs-entries-empty" className="border border-border p-8 text-center text-sm text-muted-foreground">
                No entries in this session.
              </div>
            )
          ) : (
            <div className="border border-border p-8 text-center text-sm text-muted-foreground">
              Select a session to view logs.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
