"use client";

/**
 * Custom Swarm run row + list — replaces `@lumea-labs/orchestrator`'s
 * SwarmRunRow / SwarmRunList for the project dashboard so the design
 * matches Polpo's neo-brutalist palette (sharp edges, mono labels,
 * theme tokens, no rounded corners except the status pulse dot).
 *
 * Scope is intentionally narrow:
 *   - Accepts a thin `RunRow` shape, not the full SwarmRun (no
 *     toolCalls / artifacts / events here). The dashboard surface is
 *     a scannable list, not a drill-down.
 *   - No cancel / retry handlers yet — those land in this file when
 *     we wire the SDK to abort + re-queue tasks.
 *   - Skeleton variant lives next to the real component so layout
 *     drift is impossible.
 *
 * Columns left → right:
 *   1. Status dot (pulses on running)
 *   2. Status label (mono uppercase, e.g. RUNNING)
 *   3. Agent monogram tile + name (mono uppercase)
 *   4. Task title (truncated)
 *   5. Last log (right-aligned, muted, hidden < md)
 *   6. Elapsed / relative time (right-aligned mono)
 */

import { useEffect, useState } from "react";
import Link from "next/link";

export type RunStatus =
  | "scheduled"
  | "pending"
  | "running"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface RunRow {
  id: string;
  status: RunStatus;
  agentName: string;
  agentColor?: string;
  title: string;
  lastLog?: string;
  /** ISO timestamp. Used to compute elapsed (running) or duration (done). */
  startedAt?: string;
  /** ISO timestamp. Set when status is `done`, `failed`, or `cancelled`. */
  finishedAt?: string;
  /** Optional href — when provided, the whole row becomes a Link. */
  href?: string;
}

/** Tailwind bg + fg color tokens per status. Mapped to our theme so
 *  the palette flips correctly between light + dark mode. */
const STATUS_STYLE: Record<RunStatus, { dot: string; text: string }> = {
  scheduled: { dot: "bg-violet-500", text: "text-violet-500" },
  pending: { dot: "bg-muted-foreground/60", text: "text-muted-foreground" },
  running: { dot: "bg-brand", text: "text-brand" },
  review: { dot: "bg-amber-500", text: "text-amber-500" },
  done: { dot: "bg-emerald-500", text: "text-emerald-500" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  cancelled: { dot: "bg-muted-foreground/30", text: "text-muted-foreground/60" },
};

const STATUS_LABEL: Record<RunStatus, string> = {
  scheduled: "scheduled",
  pending: "pending",
  running: "running",
  review: "review",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Counts for every run status. Mirrors @lumea-labs/orchestrator's
 *  SwarmCounts but is the source of truth for our own status bar so we
 *  can render ALL states (the package bar only shows running/done/failed). */
export interface RunCounts {
  scheduled: number;
  pending: number;
  running: number;
  review: number;
  done: number;
  failed: number;
  cancelled: number;
  total: number;
}

/** The order states appear in the bar, left → right (lifecycle order). */
const BAR_ORDER: RunStatus[] = [
  "running",
  "pending",
  "scheduled",
  "review",
  "done",
  "failed",
  "cancelled",
];

/**
 * Horizontal status bar — one stat per run status. Always rendered (shows
 * 0 across the board when a project has no tasks yet). Replaces
 * @lumea-labs/orchestrator's SwarmStatusBar, which is hardcoded to three
 * buckets. Running pulses when > 0; all states use the shared
 * STATUS_STYLE tokens so the dot colours match the run rows exactly.
 */
export function SwarmStatusBar({ counts }: { counts: RunCounts }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border border-border bg-card px-4 py-2.5">
      {BAR_ORDER.map((status, i) => {
        const value = counts[status];
        const style = STATUS_STYLE[status];
        const dim = value === 0;
        return (
          <span key={status} className="flex items-center gap-3">
            {i > 0 && <span className="h-4 w-px bg-border" aria-hidden />}
            <span className="inline-flex items-center gap-1.5">
              <span className="relative inline-flex size-2 shrink-0">
                {status === "running" && value > 0 && (
                  <span className={`absolute inset-0 rounded-full opacity-60 animate-ping ${style.dot}`} aria-hidden />
                )}
                <span
                  className={`relative inline-block size-2 rounded-full ${style.dot} ${dim ? "opacity-30" : ""}`}
                  aria-hidden
                />
              </span>
              <span className={`font-mono text-sm font-bold tabular-nums ${dim ? "text-muted-foreground/40" : style.text}`}>
                {value}
              </span>
              <span className={`font-mono text-[10px] font-medium uppercase tracking-[0.12em] ${dim ? "text-muted-foreground/40" : "text-muted-foreground"}`}>
                {STATUS_LABEL[status]}
              </span>
            </span>
          </span>
        );
      })}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Returns the elapsed seconds between startedAt and finishedAt (or
 * `now` when still running). Recomputed every second via the parent
 * `now` prop so running rows tick live without forcing each row to
 * own a timer.
 */
function elapsedSeconds(
  startedAt: string | undefined,
  finishedAt: string | undefined,
  now: number,
): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return Math.max(0, (end - start) / 1000);
}

function AgentBadge({
  name,
  color,
}: {
  name: string;
  color?: string;
}) {
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center text-[9px] font-bold leading-none text-white"
      style={{ background: color ?? "hsl(220 8% 50%)" }}
    >
      {initial}
    </span>
  );
}

export function SwarmRunRowItem({
  run,
  now,
}: {
  run: RunRow;
  now: number;
}) {
  const isLive = run.status === "running" || run.status === "pending";
  const elapsed = elapsedSeconds(run.startedAt, run.finishedAt, now);
  const elapsedLabel = run.startedAt ? formatElapsed(elapsed) : "—";
  const style = STATUS_STYLE[run.status];
  const label = STATUS_LABEL[run.status];

  const inner = (
    <div className="group flex items-center gap-3 border-b border-border px-3 py-2 transition-colors last:border-0 hover:bg-foreground/5">
      {/* Status dot — pulses on running */}
      <span className="relative inline-flex size-2 shrink-0">
        {run.status === "running" && (
          <span
            aria-hidden
            className={`absolute inset-0 rounded-full opacity-60 animate-ping ${style.dot}`}
          />
        )}
        <span
          aria-hidden
          className={`relative inline-block size-2 rounded-full ${style.dot}`}
        />
      </span>

      {/* Status label — mono uppercase */}
      <span
        className={`w-[68px] shrink-0 truncate font-mono text-[10px] font-bold uppercase tracking-[0.14em] ${style.text}`}
      >
        {label}
      </span>

      {/* Agent — monogram tile + name */}
      <span className="flex shrink-0 items-center gap-1.5">
        <AgentBadge name={run.agentName} color={run.agentColor} />
        <span className="w-[88px] truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
          {run.agentName || "—"}
        </span>
      </span>

      {/* Title — flex-1, truncates */}
      <span className="min-w-0 flex-1 truncate text-[12.5px] leading-tight text-foreground">
        {run.title}
      </span>

      {/* Last log — hidden below md */}
      {run.lastLog ? (
        <span className="hidden min-w-0 max-w-[28%] truncate font-mono text-[10px] text-muted-foreground/70 md:inline">
          {run.lastLog}
        </span>
      ) : null}

      {/* Elapsed / duration */}
      <span className="w-12 shrink-0 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground">
        {isLive && run.startedAt ? `${elapsedLabel} ago` : elapsedLabel}
      </span>
    </div>
  );

  if (run.href) {
    return (
      <Link
        href={run.href}
        className="block"
        data-testid={`swarm-run-row-${run.id}`}
      >
        {inner}
      </Link>
    );
  }
  return <div data-testid={`swarm-run-row-${run.id}`}>{inner}</div>;
}

export function SwarmRunList({
  runs,
  emptyLabel = "No runs yet.",
}: {
  runs: RunRow[];
  emptyLabel?: string;
}) {
  // Tick every second so running rows show live elapsed time without
  // each row owning its own setInterval. Pauses when nothing is live.
  const hasLive = runs.some(
    (r) => r.status === "running" || r.status === "pending",
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasLive]);

  if (runs.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div data-testid="swarm-run-list">
      {runs.map((run) => (
        <SwarmRunRowItem key={run.id} run={run} now={now} />
      ))}
    </div>
  );
}

/**
 * Skeleton row — matches the real row's column layout exactly so the
 * transition from skeleton → real content has zero layout shift.
 */
export function SwarmRunRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0">
      <span className="size-2 shrink-0 rounded-full bg-muted-foreground/20" />
      <span className="h-3 w-[68px] shrink-0 bg-muted-foreground/15" />
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="size-4 shrink-0 bg-muted-foreground/15" />
        <span className="h-3 w-[88px] bg-muted-foreground/15" />
      </span>
      <span className="h-3 min-w-0 flex-1 bg-muted-foreground/10" />
      <span className="hidden h-3 w-[18%] bg-muted-foreground/10 md:inline-block" />
      <span className="h-3 w-12 shrink-0 bg-muted-foreground/15" />
    </div>
  );
}
