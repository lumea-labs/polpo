"use client";

/**
 * The live "Run" experience — the same shape as onboarding's Call step, reused
 * DRY: call snippets + inputs on the LEFT, a live result on the RIGHT.
 *
 *   • Chat → the real Playground (`PolpoChat`, seeded with your message) plus a
 *     Raw stream teed off that same call — one request, two views.
 *   • Task → creates the task on the data plane and shows its execution Trace
 *     (the v2 sessions renderer) once the run resolves a session, with the raw
 *     creation Response alongside.
 *
 * Both hit the data plane through the session proxy (dogfooding, no CORS). The
 * copyable snippet still targets the tenant URL + Bearer key for the user's app.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "../host";
import { CircleNotch, Play, Key, Check } from "@phosphor-icons/react/dist/ssr";
import { Button } from "../ui/button";
import { CodeEditor } from "../ui/code-editor";
import { CopyButton } from "../ui/copy-button";
import { PolpoChat } from "../host";
import { chatToItems } from "../sessions/trace-detail";
import { Trace } from "../sessions/trace-detail-view";
import { useDashboardApi, useDashboardHost } from "../../host";
import {
  CALL_LANGS,
  buildCallSnippets,
  tenantBase,
  type CallLang,
} from "../host";

type Mode = "chat" | "task";

export function AgentRunPanel({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string;
}) {
  const api = useDashboardApi();
  const RunChat = useDashboardHost().components?.AgentRunChat ?? PolpoChat;
  const [mode, setMode] = useState<Mode>("chat");
  const [message, setMessage] = useState("Hello! What can you do?");
  const [taskTitle, setTaskTitle] = useState("Summarize this week's issues");
  const [taskDesc, setTaskDesc] = useState(
    "Detailed instructions for the background task…",
  );
  const [lang, setLang] = useState<CallLang>("curl");
  const [apiKey, setApiKey] = useState<string | null>(null);

  // Chat run — mirror the onboarding playground: one call, seeded + teed.
  const [chatRunKey, setChatRunKey] = useState(0);
  const [chatStatus, setChatStatus] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const [chatRaw, setChatRaw] = useState("");
  const [chatView, setChatView] = useState<"playground" | "raw">("playground");
  const rawRef = useRef<HTMLPreElement>(null);
  // Keep the raw stream pinned to the bottom as frames arrive.
  useEffect(() => {
    if (chatView === "raw" && rawRef.current) {
      rawRef.current.scrollTop = rawRef.current.scrollHeight;
    }
  }, [chatRaw, chatView]);

  // Task run — create it, then poll + resolve a session for the Trace.
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskView, setTaskView] = useState<"trace" | "response">("trace");
  const [taskError, setTaskError] = useState<string | null>(null);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      api.fetchControlPlane<{ slug?: string; orgId: string }>(
        `/v1/projects/${projectId}`,
      ),
    staleTime: 60_000,
  });
  const base = tenantBase(project?.slug);

  const { code, codeLang } = buildCallSnippets({
    base,
    agentName,
    streaming: mode === "chat",
    message,
    taskTitle,
    taskDesc,
  }).pick(lang);

  const createKey = useMutation({
    mutationFn: () =>
      api.mutateControlPlane<{ rawKey: string }>("/v1/api-keys", {
        method: "POST",
        body: {
          orgId: project?.orgId,
          name: `${agentName} · run`,
          scopes: [{ type: "project", projectId }],
          environment: "live",
        },
      }),
    onSuccess: (d) => setApiKey(d.rawKey),
  });

  // Poll the created task, then its session's transcript for the live Trace.
  const { data: taskData } = useQuery({
    queryKey: ["run-task", projectId, taskId],
    queryFn: () =>
      api.fetchDataPlane<{
        data?: {
          task?: { status?: string; sessionId?: string };
          run?: {
            sessionId?: string;
            activity?: { sessionId?: string };
            result?: { stderr?: string };
          };
        };
      }>(
        projectId,
        `/v1/tasks/${encodeURIComponent(taskId!)}/activity`,
      ),
    enabled: !!taskId,
    refetchInterval: taskId ? 2000 : false,
  });
  const taskObj = taskData?.data?.task;
  const taskRun = taskData?.data?.run;
  const taskSessionId = taskRun?.sessionId
    ?? taskRun?.activity?.sessionId
    ?? taskObj?.sessionId;
  const executionError = taskError ?? taskRun?.result?.stderr;

  const { data: traceData, isFetching: traceFetching } = useQuery({
    queryKey: ["run-task-trace", projectId, taskSessionId],
    queryFn: () =>
      api.fetchDataPlane<{ data?: { messages?: unknown[] } }>(
        projectId,
        `/v1/chat/sessions/${encodeURIComponent(taskSessionId!)}/messages`,
      ),
    enabled: !!taskSessionId,
    refetchInterval: taskSessionId ? 2000 : false,
  });
  const traceItems = chatToItems((traceData?.data?.messages ?? []) as never);

  const createTask = useMutation({
    // Raw fetch preserves the streamed response shape used by this panel.
    mutationFn: async () => {
      const r = await fetch(
        api.runtimeUrl(projectId, "/v1/tasks"),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignTo: agentName,
            title: taskTitle,
            description: taskDesc,
          }),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { data?: { id?: string } };
    },
    onSuccess: (r) => {
      setTaskId(r.data?.id ?? null);
      setTaskView("trace");
    },
    onError: (e) =>
      setTaskError(e instanceof Error ? e.message : "Failed to create task"),
  });

  const run = () => {
    if (mode === "chat") {
      setChatRaw("");
      setChatStatus("running");
      setChatView("playground");
      setChatRunKey((k) => k + 1);
    } else {
      setTaskError(null);
      createTask.mutate();
    }
  };

  const inputCls =
    "w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      {/* ── Left: integrate the call (the point) — test here is secondary ── */}
      <div className="flex min-w-0 flex-col gap-3 md:min-h-0 md:w-[44%] md:shrink-0">
        <div className="shrink-0 space-y-3">
          <div>
            <div className="text-[14px] font-semibold text-foreground">
              Call it from your app
            </div>
            <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
              This is how you integrate{" "}
              <span className="font-mono text-foreground">{agentName}</span> —
              drop the snippet into your code. You can also run it here first
              just to test.
            </p>
          </div>

          {/* mode toggle — drives both the snippet and the test on the right */}
          <div className="inline-flex rounded-md border border-border p-0.5 text-[13px]">
            {(["chat", "task"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-3 py-1 font-medium transition-colors ${
                  mode === m
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "chat" ? "Chat" : "Task"}
              </button>
            ))}
          </div>

          {/* request fields */}
          {mode === "chat" ? (
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Ask it something…"
              className={`${inputCls} h-16 resize-none`}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder="Task title"
                className={inputCls}
              />
              <textarea
                value={taskDesc}
                onChange={(e) => setTaskDesc(e.target.value)}
                placeholder="Description — what to do, and what a good result looks like."
                className={`${inputCls} h-16 resize-none`}
              />
            </div>
          )}

          {/* Test here — clearly secondary to integrating the snippet */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={run}
              disabled={mode === "task" && createTask.isPending}
              className="gap-1.5"
            >
              {mode === "task" && createTask.isPending ? (
                <CircleNotch size={15} className="animate-spin" />
              ) : (
                <Play size={15} weight="fill" />
              )}
              {mode === "chat" ? "Test it here" : "Run a test task"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Just a quick test — your app calls it with the snippet.
            </span>
          </div>
        </div>

        {/* the snippet — tall, fills to the bottom of the dialog (Monaco) */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border">
            <div className="flex">
              {CALL_LANGS.filter((l) => l.id !== "agent").map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLang(l.id)}
                  className={`-mb-px border-b-2 px-2.5 py-1.5 text-[12px] transition-colors ${
                    lang === l.id
                      ? "border-brand font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 pb-1">
              {!apiKey && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!project?.orgId || createKey.isPending}
                  onClick={() => createKey.mutate()}
                >
                  {createKey.isPending ? (
                    <CircleNotch size={13} className="animate-spin" />
                  ) : (
                    <Key size={13} />
                  )}
                  Generate key
                </Button>
              )}
              <CopyButton text={code} label="Copy" />
            </div>
          </div>
          {apiKey && (
            <div className="mt-2 flex shrink-0 items-center gap-2 rounded-md border border-brand/30 bg-brand/5 px-2.5 py-1.5">
              <Check size={13} weight="bold" className="shrink-0 text-brand" />
              <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                {apiKey}
              </code>
              <CopyButton text={`export POLPO_API_KEY=${apiKey}`} label="Copy" />
            </div>
          )}
          <div className="mt-2 min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
            <CodeEditor
              language={
                codeLang === "typescript"
                  ? "typescript"
                  : codeLang === "python"
                    ? "python"
                    : "shell"
              }
              value={code}
              onChange={() => {}}
              readOnly
              height="100%"
            />
          </div>
        </div>
      </div>

      {/* ── Right: the live result ────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
        {mode === "chat" ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex items-center gap-1">
                {(["playground", "raw"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setChatView(v)}
                    className={`rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                      chatView === v
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {v === "playground" ? "Playground" : "Raw stream"}
                  </button>
                ))}
              </div>
              {chatStatus === "running" && (
                <span className="text-[11px] text-muted-foreground">
                  streaming…
                </span>
              )}
              {chatStatus === "done" && (
                <span className="text-[11px] font-medium text-emerald-600">
                  200 OK
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {chatStatus === "idle" ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
                  Enter a message and hit “Run chat” to talk to {agentName}.
                </div>
              ) : (
                <>
                  <div
                    className={
                      chatView === "playground"
                        ? "flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
                        : "hidden"
                    }
                  >
                    <RunChat
                      key={chatRunKey}
                      baseUrl={api.dataPlaneBaseUrl(projectId)}
                      agent={agentName}
                      initialMessage={message}
                      seedKey={`run:${projectId}:${agentName}:${chatRunKey}`}
                      onRawChunk={(c) => setChatRaw((r) => r + c)}
                      onRawDone={() => setChatStatus("done")}
                      onRawError={() => setChatStatus("error")}
                    />
                  </div>
                  <pre
                    ref={rawRef}
                    className={`h-full overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground ${
                      chatView === "raw" ? "" : "hidden"
                    }`}
                  >
                    {chatRaw || "…"}
                  </pre>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
              <div className="flex items-center gap-1">
                {(["trace", "response"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setTaskView(v)}
                    className={`rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                      taskView === v
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {v === "trace" ? "Trace" : "Response"}
                  </button>
                ))}
              </div>
              {taskObj?.status && (
                <span className="text-[11px] font-medium text-muted-foreground">
                  {taskObj.status}
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {executionError ? (
                <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-destructive">
                  {executionError}
                </pre>
              ) : !taskId ? (
                <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
                  Describe a task and hit “Run task” — its execution trace shows
                  up here.
                </div>
              ) : taskView === "trace" ? (
                traceItems.length > 0 ? (
                  <div className="p-4">
                    <Trace items={traceItems} />
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                    <CircleNotch
                      size={20}
                      className="animate-spin text-brand"
                    />
                    <p className="text-[13px] text-muted-foreground">
                      Task created — waiting for the run to start…
                    </p>
                  </div>
                )
              ) : (
                <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(taskData?.data ?? { id: taskId }, null, 2)}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
