"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { usePolpo, useSessions, useTask, useTaskActivity, useTasks } from "@polpo-ai/react";
import { Link, useRouter } from "../host.js";
import { PageBody, PageHeader } from "../ui/page-header.js";
import { DataTable } from "../ui/data-table.js";
import { RefreshButton } from "../ui/refresh-button.js";
import { MultiSelectFilter } from "../ui/multi-select-filter.js";
import { CodeBlock } from "../ui/code-block.js";
import { CopyButton } from "../ui/copy-button.js";
import { normalizeAll, type RunRow } from "./trace-normalize.js";
import type { ChatRun, LoopRun, SessionsHostAdapter, TaskActivity } from "./host.js";
import { SessionsView } from "../views/sessions.js";
import { SessionsDetailView } from "../views/sessions-detail.js";

function Markdown({ content }: { content: string }) {
  return <div className="prose prose-sm max-w-none text-foreground prose-p:my-2 prose-pre:my-2 dark:prose-invert"><ReactMarkdown>{content}</ReactMarkdown></div>;
}

function RouteRefreshButton({ onClick }: { onClick?: () => unknown }) {
  const router = useRouter();
  return <RefreshButton onClick={() => (onClick ? onClick() : router.refresh())} />;
}

function useRuns({ initial }: { projectId: string; initial: RunRow[] }) {
  const sessionsResource = useSessions();
  const tasksResource = useTasks();
  const [error, setError] = useState<Error | null>(null);
  const refetch = useCallback(async () => {
    try {
      await Promise.all([
        sessionsResource.refetch(),
        tasksResource.refetch(),
      ]);
      setError(null);
    } catch (cause) {
      setError(cause as Error);
    }
  }, [sessionsResource.refetch, tasksResource.refetch]);
  useEffect(() => { void refetch(); }, [refetch]);
  const data = useMemo(
    () => normalizeAll(sessionsResource.sessions, tasksResource.tasks, []),
    [sessionsResource.sessions, tasksResource.tasks],
  );
  const isLoading = sessionsResource.isLoading || tasksResource.isLoading;
  return {
    data: data.length ? data : initial,
    error: error ?? sessionsResource.error ?? tasksResource.error,
    isLoading,
    isFetching: isLoading,
    refetch,
  };
}

function useLoopRun(_projectId: string, runId: string) {
  const { client } = usePolpo();
  const [data, setData] = useState<LoopRun | null>();
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setLoading] = useState(true);
  const refetch = useCallback(async () => {
    setLoading(true);
    try { setData(await client.getLoopRun(runId) as unknown as LoopRun); setError(null); }
    catch (cause) { setError(cause as Error); setData(null); }
    finally { setLoading(false); }
  }, [client, runId]);
  useEffect(() => { void refetch(); }, [refetch]);
  return { data, error, isLoading, isFetching: isLoading, refetch };
}

function useChatRun(_projectId: string, sessionId: string) {
  const sessions = useSessions();
  const [messages, setMessages] = useState<unknown[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setLoading] = useState(true);
  const refetch = useCallback(async () => {
    setLoading(true);
    try { setMessages(await sessions.getMessages(sessionId)); setError(null); }
    catch (cause) { setError(cause as Error); }
    finally { setLoading(false); }
  }, [sessionId, sessions.getMessages]);
  useEffect(() => { void refetch(); }, [refetch]);
  const data: ChatRun = { session: sessions.sessions.find((item) => item.id === sessionId), messages };
  return { data, error, isLoading: isLoading || sessions.isLoading, isFetching: isLoading, refetch };
}

function useTaskRun(_projectId: string, taskId: string) {
  const task = useTask(taskId);
  const activity = useTaskActivity(taskId);
  const data: TaskActivity = { task: task.task as TaskActivity["task"], run: null, entries: activity.entries };
  return { data, error: task.error ?? activity.error, isLoading: task.isLoading || activity.isLoading, isFetching: task.isLoading || activity.isLoading, refetch: activity.refetch };
}

export function useSelfHostSessionsAdapter(): SessionsHostAdapter {
  return useMemo(() => ({
    data: { useRuns, useLoopRun, useChatRun, useTaskRun },
    routes: {
      sessions: () => "/sessions",
      run: (_projectId: string, runId: string) => `/sessions/${encodeURIComponent(runId)}`,
      loop: (_projectId: string, loopName: string) => `/loops/${encodeURIComponent(loopName)}`,
    },
    notFound: () => <div className="py-16 text-center text-sm text-muted-foreground">Run not found.</div>,
    components: { Link, PageBody, PageHeader, DataTable, RefreshButton, RouteRefreshButton, MultiSelectFilter, Markdown, CodeBlock, CopyButton },
  }), []);
}

export function SelfHostSessionsView() {
  const host = useSelfHostSessionsAdapter();
  return <SessionsView projectId="local" host={host} />;
}

export function SelfHostSessionDetailView({ runId }: { runId: string }) {
  const host = useSelfHostSessionsAdapter();
  return <SessionsDetailView projectId="local" runId={runId} host={host} />;
}
