"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ArrowsClockwise, CaretRight, WarningCircle } from "@phosphor-icons/react";
import {
  SessionsHostProvider,
  useSessionsHost,
  type SessionsHostAdapter,
  type TaskRun,
} from "../sessions/host.js";
import { Trace } from "../sessions/trace-detail-view.js";
import {
  chatToItems,
  logToItems,
  loopToNodes,
  runToItems,
  type TraceNode,
} from "../sessions/trace-detail.js";

const KIND_LABEL: Record<string, string> = {
  chat: "Chat",
  task: "Task",
  loop: "Loop",
};

export function SessionsDetailView({
  projectId,
  runId,
  host,
}: {
  projectId: string;
  runId: string;
  host: SessionsHostAdapter;
}) {
  const decoded = decodeURIComponent(runId);
  const sep = decoded.indexOf(":");
  const kind = sep === -1 ? "loop" : decoded.slice(0, sep);
  const realId = sep === -1 ? decoded : decoded.slice(sep + 1);
  const { Link, PageBody } = host.components;

  return (
    <SessionsHostProvider host={host}>
      <PageBody>
        <Link
          href={host.routes.sessions(projectId)}
          className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} />
          Sessions
        </Link>

        {kind === "loop" ? (
          <LoopRunView projectId={projectId} runId={realId} />
        ) : kind === "chat" ? (
          <ChatRunView projectId={projectId} sessionId={realId} />
        ) : kind === "task" ? (
          <TaskRunView projectId={projectId} taskId={realId} />
        ) : (
          host.notFound()
        )}
      </PageBody>
    </SessionsHostProvider>
  );
}

export default SessionsDetailView;

/* ── Loop run — the step/tool trace ───────────────────────────────────── */
function LoopRunView({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const host = useSessionsHost();
  const resource = host.data.useLoopRun(projectId, runId);
  const run = resource.data ?? null;
  const err = resource.error?.message ?? null;
  if (resource.isLoading && !run) return <RunDetailLoading kind="loop run" id={runId} />;
  if (!run) return <LoadError kind="loop run" id={runId} error={err} />;

  const nodes = loopToNodes((run.trace ?? []) as never);

  return (
    <div>
      <RunHeader
        kind="loop"
        title={run.loopName ?? `Loop run ${run.id.slice(0, 8)}`}
        agent={run.agentName}
        status={run.status}
        when={run.startedAt}
      />
      {run.loopName && <LoopBand projectId={projectId} loopName={run.loopName} />}
      {run.error && (
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[13px] text-destructive">
          {run.error}
        </div>
      )}
      <TraceSection
        items={nodes}
        actions={<host.components.RouteRefreshButton onClick={resource.refetch} />}
      />
    </div>
  );
}

/* ── Chat session — the conversation ──────────────────────────────────── */
function ChatRunView({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const host = useSessionsHost();
  const resource = host.data.useChatRun(projectId, sessionId);
  const session = resource.data?.session;
  const items: TraceNode[] = chatToItems((resource.data?.messages ?? []) as never);
  const err = resource.error?.message ?? null;
  if (resource.isLoading && !resource.data) return <RunDetailLoading kind="session" id={sessionId} />;
  if (err) return <LoadError kind="session" id={sessionId} error={err} />;

  return (
    <div>
      <RunHeader
        kind="chat"
        title={session?.title ?? `Session ${sessionId.slice(0, 8)}`}
        agent={session?.agent}
        status={undefined}
        when={undefined}
      />
      <TraceSection
        items={items}
        actions={<host.components.RouteRefreshButton onClick={resource.refetch} />}
      />
    </div>
  );
}

/* ── Task — the session activity ──────────────────────────────────────── */
function TaskRunView({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const host = useSessionsHost();
  const resource = host.data.useTaskRun(projectId, taskId);
  const task = resource.data?.task ?? null;
  const run = resource.data?.run ?? null;
  const items: TraceNode[] = [
    ...runToItems(run),
    ...logToItems((resource.data?.entries ?? []) as never),
  ];
  const err = resource.error?.message ?? null;
  if (resource.isLoading && !resource.data) return <RunDetailLoading kind="task" id={taskId} />;
  if (!task) return <LoadError kind="task" id={taskId} error={err} />;

  const output = task.result?.output
    ?? task.result?.content
    ?? task.result?.stdout
    ?? run?.result?.stdout;
  const failure = run?.result?.stderr || task.result?.stderr;
  const loopName = task.loop;

  return (
    <div>
      <RunHeader
        kind="task"
        title={task.title ?? `Task ${task.id.slice(0, 8)}`}
        agent={task.assignTo}
        status={task.status}
        when={run?.startedAt ?? task.createdAt}
      />
      {loopName && <LoopBand projectId={projectId} loopName={loopName} />}
      {failure && <RunFailure message={failure} run={run} />}
      <TraceSection
        items={items}
        actions={<host.components.RouteRefreshButton onClick={resource.refetch} />}
      />

      {output != null && output !== "" && (
        <>
          <h2 className="mt-7 mb-3 text-[13px] font-medium text-foreground">
            Output
          </h2>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card p-4 font-mono text-[12px] leading-relaxed text-foreground">
            {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

function RunFailure({ message, run }: { message: string; run: TaskRun | null }) {
  const duration = run?.result?.duration;
  return (
    <div className="mt-5 flex items-start gap-3 rounded-md border border-destructive/25 bg-destructive/[0.04] px-3.5 py-3">
      <WarningCircle size={17} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-foreground">Execution failed</span>
          {run?.id && (
            <span className="font-mono text-[11px] text-muted-foreground">{run.id}</span>
          )}
          {duration != null && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {Math.max(0, duration)} ms
            </span>
          )}
        </div>
        <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-destructive">
          {message}
        </pre>
      </div>
    </div>
  );
}

/* ── Shared pieces ────────────────────────────────────────────────────── */
function TraceSection({
  items,
  actions,
}: {
  items: TraceNode[];
  actions?: ReactNode;
}) {
  return (
    <div className="mt-6">
      <Trace items={items} rightSlot={actions} />
    </div>
  );
}

function LoopBand({
  projectId,
  loopName,
}: {
  projectId: string;
  loopName: string;
}) {
  const host = useSessionsHost();
  const { Link } = host.components;
  return (
    <Link
      href={host.routes.loop(projectId, loopName)}
      className="mt-4 flex items-center gap-2.5 rounded-lg border border-brand/25 bg-brand/[0.06] px-3.5 py-2.5 transition-colors hover:border-brand/40"
    >
      <ArrowsClockwise size={15} weight="bold" className="shrink-0 text-brand" />
      <span className="text-[12px] text-muted-foreground">Ran inside loop</span>
      <span className="font-mono text-[13px] font-medium text-foreground">
        {loopName}
      </span>
      <CaretRight size={13} className="ml-auto text-muted-foreground/50" />
    </Link>
  );
}

function RunDetailLoading({ kind, id }: { kind: string; id: string }) {
  const Loading = useSessionsHost().components.RunDetailLoading;
  return Loading ? <Loading kind={kind} id={id} /> : null;
}

function LoadError({
  kind,
  id,
  error,
}: {
  kind: string;
  id: string;
  error: string | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="text-[14px] font-medium text-foreground">
        Couldn&rsquo;t load this {kind}
      </div>
      <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-muted-foreground">
        {error
          ? error
          : "It may have been removed, or the data plane is still warming up — try refreshing in a moment."}
      </p>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground/50">{id}</p>
    </div>
  );
}

function RunHeader({
  kind,
  title,
  agent,
  status,
  when,
}: {
  kind: string;
  title: string;
  agent?: string;
  status?: string;
  when?: string;
}) {
  const kindLabel = KIND_LABEL[kind] ?? kind;
  const description =
    kind === "chat"
      ? agent
        ? `Conversation with ${agent}`
        : "Conversation trace"
      : kind === "task"
        ? agent
          ? `Task run assigned to ${agent}`
          : "Task run activity"
        : agent
          ? `Loop execution by ${agent}`
          : "Loop execution trace";

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h1 className="min-w-0 truncate font-mono text-[19px] font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          <span className="shrink-0 rounded border border-border bg-secondary/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
            {kindLabel}
          </span>
        </div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>

        {(status || when) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {status && (
              <span className="rounded-md bg-secondary px-2.5 py-1 text-[12px] text-muted-foreground">
                {status.replace(/_/g, " ")}
              </span>
            )}
            {when && (
              <span className="rounded-md bg-secondary px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
                {new Date(when).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
