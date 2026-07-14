/**
 * Unified Trace — normalizes the execution sources into one row shape.
 *
 * The two ways to invoke an agent are the only real "kinds": Chat (sync) and
 * Task (async). A LOOP is not a kind — it's the deterministic recipe a run
 * follows, and it runs *inside* chat and tasks. So loop is a property on the
 * row (`loop`), not a category. Loop runs are surfaced as chat runs that used
 * a loop (the runtime starts a loop from a chat completion).
 *
 * Pure module → imported by both the server page and the client table.
 */

export type RunKind = "chat" | "task";
export type Tone = "success" | "running" | "failed" | "warning" | "neutral";

export type RunRow = {
  id: string;
  kind: RunKind;
  title: string;
  agent?: string;
  loop?: string; // the recipe this run followed, if any
  status: string;
  tone: Tone;
  ts: number; // sort key (ms since epoch)
  durationMs?: number;
  messageCount?: number;
};

type RawSession = {
  id: string;
  title?: string;
  agent?: string;
  messageCount?: number;
  createdAt?: string;
  updatedAt?: string;
};
type RawTask = {
  id: string;
  title?: string;
  status?: string;
  assignTo?: string;
  loop?: string;
  createdAt?: string;
  updatedAt?: string;
  retries?: number;
  maxRetries?: number;
  result?: { duration?: number };
};
type RawLoopRun = {
  id: string;
  loopName?: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  trace?: unknown[];
};

function ms(date?: string): number {
  if (!date) return 0;
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function taskTone(status: string): Tone {
  if (status === "done") return "success";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "running";
  if (status === "review" || status === "awaiting_approval") return "warning";
  return "neutral";
}

function loopTone(status: string): Tone {
  if (status === "completed" || status === "approval_approved") return "success";
  if (status === "failed" || status === "approval_rejected") return "failed";
  if (status === "running" || status === "resuming") return "running";
  if (status === "awaiting_approval") return "warning";
  return "neutral";
}

export function normalizeAll(
  sessions: RawSession[],
  tasks: RawTask[],
  loopRuns: RawLoopRun[],
): RunRow[] {
  const rows: RunRow[] = [];

  for (const s of sessions) {
    rows.push({
      id: `chat:${s.id}`,
      kind: "chat",
      title: s.title?.trim() || `Session ${s.id.slice(0, 8)}`,
      agent: s.agent,
      status: "",
      tone: "neutral",
      ts: ms(s.updatedAt) || ms(s.createdAt),
      messageCount: s.messageCount,
    });
  }

  for (const t of tasks) {
    const status = t.status ?? "pending";
    rows.push({
      id: `task:${t.id}`,
      kind: "task",
      title: t.title?.trim() || `Task ${t.id.slice(0, 8)}`,
      agent: t.assignTo,
      loop: t.loop,
      status,
      tone: taskTone(status),
      ts: ms(t.updatedAt) || ms(t.createdAt),
      durationMs: t.result?.duration,
    });
  }

  // Loop runs are chat-mode executions that followed a loop recipe.
  for (const r of loopRuns) {
    const status = r.status ?? "running";
    const start = ms(r.startedAt);
    const end = ms(r.completedAt);
    rows.push({
      id: `loop:${r.id}`,
      kind: "chat",
      title: r.loopName?.trim() || `Loop run ${r.id.slice(0, 8)}`,
      agent: r.agentName,
      loop: r.loopName,
      status,
      tone: loopTone(status),
      ts: ms(r.updatedAt) || end || start,
      durationMs: end && start ? end - start : undefined,
    });
  }

  return rows.sort((a, b) => b.ts - a.ts);
}
