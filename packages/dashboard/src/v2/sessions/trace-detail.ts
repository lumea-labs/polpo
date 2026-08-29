/**
 * One trace model for every run kind, so the detail view is a single, uniform
 * timeline. A run is a flat list of steps (chat turns / execution events); a
 * loop adds one level of nesting (phases that wrap their work), rendered as
 * collapsible groups in the SAME timeline — the loop is fused in, not a
 * separate view.
 *
 *   chat  → conversation turns (user / assistant, with tool calls)
 *   task  → session log events ({ ts, event, data })
 *   loop  → phases (steps) wrapping tool/transition events
 *
 * Pure module: converters run on the server page, the client `<Trace>` renders.
 */

export type TraceActor = "user" | "assistant" | "system" | "tool" | "event";
export type TraceTone =
  | "neutral"
  | "success"
  | "running"
  | "failed"
  | "warning";

/**
 * A payload block attached to a step (tool input/output, event data). The
 * renderer auto-detects the best presentation (JSON / code / markdown / text);
 * a `format` hint forces one when the shape is known.
 */
export type TracePayload = {
  label: string;
  value: string;
  format?: "auto" | "json" | "code" | "markdown" | "text";
  lang?: string;
};

/** A leaf item — a conversation turn or an execution event. */
export type TraceStep = {
  kind?: "step";
  id: string;
  actor: TraceActor;
  label: string;
  sublabel?: string;
  body?: string;
  /** Render the body as markdown (chat turns) vs auto-detect (events). */
  markdown?: boolean;
  status?: string;
  tone?: TraceTone;
  ts?: string;
  payload?: TracePayload[];
  /** The original source object, verbatim — for the raw/log view. */
  raw?: unknown;
};

/** A group (a loop step/phase) that wraps child steps — one nesting level. */
export type TracePhase = {
  kind: "phase";
  id: string;
  label: string;
  status?: string;
  tone: TraceTone;
  startTs?: string;
  endTs?: string;
  children: TraceStep[];
};

export type TraceNode = TraceStep | TracePhase;

/** Back-compat alias — callers historically import `TraceItem`. */
export type TraceItem = TraceStep;

/* ── helpers ──────────────────────────────────────────────────────────── */

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Pretty string for a value: objects → pretty JSON, primitives → as-is. */
function jsonish(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/* ── Chat: ChatMessage[] → turns ──────────────────────────────────────── */
type RawToolCall = {
  id?: string;
  name?: string;
  toolName?: string;
  arguments?: unknown;
  input?: unknown;
  args?: unknown;
  result?: unknown;
  output?: unknown;
  state?: string;
};
type RawChatMessage = {
  id?: string;
  role?: string;
  content?: unknown;
  ts?: string;
  createdAt?: string;
  toolCalls?: RawToolCall[];
  reasoning?: string;
  reasoningTruncated?: boolean;
};

/**
 * Flattens a chat thread into the raw transcript: one step per message, then
 * one step per tool call (name + input + output) so the full trace shows every
 * call as its own row instead of folding them into the assistant message.
 */
export function chatToItems(messages: RawChatMessage[]): TraceStep[] {
  const out: TraceStep[] = [];
  messages.forEach((m, i) => {
    const actor: TraceActor =
      m.role === "assistant"
        ? "assistant"
        : m.role === "user"
          ? "user"
          : "system";
    out.push({
      id: m.id ?? `chat-${i}`,
      actor,
      label: m.role ?? "message",
      body: contentText(m.content),
      markdown: true,
      ts: m.ts ?? m.createdAt,
      payload: m.reasoning
        ? [{
            label: m.reasoningTruncated ? "reasoning (truncated)" : "reasoning",
            value: m.reasoning,
            format: "markdown",
          }]
        : undefined,
      raw: m,
    });
    // The backend folds tool calls INSIDE the assistant message. A debug trace
    // must show them, so un-fold each into its own raw `tool_call` (and
    // `tool_result` when a result exists) row — verbatim, no reshaping.
    (m.toolCalls ?? []).forEach((call, j) => {
      const name = call.name ?? call.toolName ?? "tool";
      const args = call.arguments ?? call.input ?? call.args;
      const result = call.result ?? call.output;
      out.push({
        id: call.id ? `${call.id}-call` : `chat-${i}-call-${j}`,
        actor: "tool",
        label: "tool_call",
        sublabel: name,
        ts: m.ts ?? m.createdAt,
        raw: { id: call.id, name, arguments: args },
      });
      if (result !== undefined || call.state) {
        out.push({
          id: call.id ? `${call.id}-result` : `chat-${i}-result-${j}`,
          actor: "tool",
          label: "tool_result",
          sublabel: name,
          status: call.state,
          tone: call.state === "error" ? "failed" : "success",
          body: typeof result === "string" ? result : undefined,
          ts: m.ts ?? m.createdAt,
          raw: { id: call.id, name, result, state: call.state },
        });
      }
    });
  });
  return out;
}

/* ── Task: LogEntry[] ({ ts, event, data }) → events ──────────────────── */
type RawLogEntry = {
  ts?: string;
  event?: string;
  type?: string;
  tool?: string;
  data?: unknown;
  text?: string;
  content?: unknown;
  input?: unknown;
};

export function logToItems(entries: RawLogEntry[]): TraceStep[] {
  return entries.map((e, i) => {
    const ev = e.type ?? e.event ?? "event";
    const actor: TraceActor = /assistant|completion|response|model/i.test(ev)
      ? "assistant"
      : /user|prompt/i.test(ev)
        ? "user"
        : /tool/i.test(ev) || e.tool
          ? "tool"
          : "event";
    const d = (e.data && typeof e.data === "object" ? e.data : {}) as Record<
      string,
      unknown
    >;
    const body =
      contentText(e.content ?? d.content ?? e.text ?? d.text ?? d.message) ||
      (typeof e.data === "string" ? e.data : "");
    const tone: TraceTone = /error|fail/i.test(ev) ? "failed" : "neutral";
    const payload: TracePayload[] = [];
    if (e.input != null) payload.push({ label: "input", value: jsonish(e.input) });
    if (e.data != null && typeof e.data === "object")
      payload.push({ label: "data", value: jsonish(e.data) });
    return {
      id: `log-${i}`,
      actor,
      label: ev.replace(/[._]/g, " "),
      sublabel: e.tool,
      body: body || undefined,
      tone,
      ts: e.ts,
      payload: payload.length ? payload : undefined,
      raw: e,
    };
  });
}

type RawRunRecord = {
  id?: string;
  status?: string;
  engine?: string;
  delivery?: string;
  executionMode?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  result?: {
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    duration?: number;
  };
};

/** Durable Run lifecycle rows, independent from the conversational transcript. */
export function runToItems(run?: RawRunRecord | null): TraceStep[] {
  if (!run) return [];

  const details = {
    runId: run.id,
    engine: run.engine,
    delivery: run.delivery,
    executionMode: run.executionMode,
  };
  const rows: TraceStep[] = [
    {
      id: `${run.id ?? "run"}-started`,
      actor: "event",
      label: "run started",
      sublabel: run.executionMode ?? run.engine,
      status: "running",
      tone: "running",
      ts: run.startedAt,
      raw: { type: "run.started", ...details, startedAt: run.startedAt },
    },
  ];

  if (run.status && run.status !== "running") {
    const failed = run.status === "failed" || run.status === "killed" || (run.result?.exitCode ?? 0) !== 0;
    rows.push({
      id: `${run.id ?? "run"}-terminal`,
      actor: "event",
      label: failed ? "run failed" : "run completed",
      sublabel: run.result?.duration != null ? `${Math.max(0, run.result.duration)} ms` : undefined,
      status: run.status,
      tone: failed ? "failed" : "success",
      body: run.result?.stderr || undefined,
      ts: run.completedAt ?? run.updatedAt,
      raw: {
        type: `run.${run.status}`,
        ...details,
        completedAt: run.completedAt ?? run.updatedAt,
        result: run.result,
      },
    });
  }

  return rows;
}

/* ── Loop: trace events → phases + flat events ────────────────────────── */
type RawLoopEvent = {
  id?: string;
  type: string;
  ts?: string;
  step?: string;
  stepKey?: string;
  tool?: string;
  from?: string;
  to?: string;
  fromStepKey?: string;
  toStepKey?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  data?: unknown;
};

function loopTone(e: RawLoopEvent): TraceTone {
  if (e.status === "failed" || e.error || e.type === "loop.error") return "failed";
  if (e.status === "completed" || e.type === "loop.end") return "success";
  if (e.status === "skipped") return "warning";
  if (e.status === "started" || e.type === "loop.start") return "running";
  return "neutral";
}

function loopEventToStep(e: RawLoopEvent, i: number): TraceStep {
  const payload: TracePayload[] = [];
  if (e.input != null) payload.push({ label: "input", value: jsonish(e.input) });
  if (e.output != null) payload.push({ label: "output", value: jsonish(e.output) });
  if (e.data != null) payload.push({ label: "data", value: jsonish(e.data) });
  return {
    id: e.id ?? `loop-${i}`,
    actor: e.type.startsWith("tool.") || e.tool ? "tool" : "event",
    label: e.type,
    sublabel: e.tool ?? (e.from && e.to ? `${e.from} → ${e.to}` : undefined),
    status: e.status,
    tone: loopTone(e),
    body: e.error || undefined,
    ts: e.ts,
    payload: payload.length ? payload : undefined,
    raw: e,
  };
}

/**
 * A debug trace shows EVERY loop event as its own flat row — loop.start/end,
 * step.start/end, tool.call/result, transitions, permission/policy results —
 * verbatim, in order, no phase folding or hiding of structural markers.
 */
export function loopToNodes(events: RawLoopEvent[]): TraceNode[] {
  return events.map((e, i) => loopEventToStep(e, i));
}
