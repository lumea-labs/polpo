import type { ComponentType } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ChatCircleText, ListChecks } from "@phosphor-icons/react";
import type { ColumnMeta } from "./host.js";
import { type RunRow, type RunKind, type Tone } from "./trace-normalize.js";

/**
 * Shared trace/run table columns — used by the Sessions page and the agent
 * Overview so the "recent activity" list stays identical to the full trace.
 */

type IconComponent = ComponentType<{ size?: number; className?: string }>;

const KIND_META: Record<RunKind, { label: string; icon: IconComponent }> = {
  chat: { label: "Chat", icon: ChatCircleText },
  task: { label: "Task", icon: ListChecks },
};

const TONE_DOT: Record<Tone, string> = {
  success: "bg-emerald-500",
  running: "bg-brand animate-pulse",
  failed: "bg-destructive",
  warning: "bg-amber-500",
  neutral: "bg-muted-foreground/40",
};

function fmtDuration(msVal?: number): string {
  if (!msVal) return "—";
  const s = Math.floor(msVal / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function timeAgo(ts: number): string {
  if (!ts) return "—";
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const traceColumns: ColumnDef<RunRow, unknown>[] = [
  {
    id: "type",
    header: "Type",
    accessorFn: (r) => r.kind,
    cell: ({ row }) => {
      const { label, icon: Icon } = KIND_META[row.original.kind];
      return (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Icon size={14} />
          {label}
        </span>
      );
    },
    meta: {} satisfies ColumnMeta,
  },
  {
    id: "run",
    header: "Run",
    accessorFn: (r) => r.title,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">
            {r.title}
          </div>
          {r.loop && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground/50">Loop</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                {r.loop}
              </span>
            </div>
          )}
        </div>
      );
    },
  },
  {
    id: "agent",
    header: "Agent",
    accessorFn: (r) => r.agent ?? "",
    cell: ({ getValue }) => {
      const v = getValue() as string;
      return v ? (
        <span className="font-mono text-[12px] text-muted-foreground">{v}</span>
      ) : (
        <span className="text-muted-foreground/40">—</span>
      );
    },
    meta: {} satisfies ColumnMeta,
  },
  {
    id: "status",
    header: "Status",
    accessorFn: (r) => r.status,
    cell: ({ row }) => {
      const r = row.original;
      if (!r.status) {
        return <span className="text-muted-foreground/40">—</span>;
      }
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${TONE_DOT[r.tone]}`} />
          <span className="text-[12px] text-muted-foreground">
            {r.status.replace(/_/g, " ")}
          </span>
        </span>
      );
    },
    meta: {} satisfies ColumnMeta,
  },
  {
    id: "metric",
    // Chat/loop runs are measured in messages; tasks in wall-clock duration.
    header: "",
    accessorFn: (r) => r.durationMs ?? r.messageCount ?? 0,
    cell: ({ row }) => {
      const r = row.original;
      const text =
        r.kind === "chat" && r.messageCount != null
          ? `${r.messageCount} ${r.messageCount === 1 ? "msg" : "msgs"}`
          : fmtDuration(r.durationMs);
      return (
        <span
          className="font-mono text-[12px] text-muted-foreground"
          data-tabular
        >
          {text}
        </span>
      );
    },
    meta: { align: "right" } satisfies ColumnMeta,
  },
  {
    id: "when",
    header: "When",
    accessorFn: (r) => r.ts,
    cell: ({ getValue }) => (
      <span className="text-[12px] text-muted-foreground" data-tabular>
        {timeAgo(getValue() as number)}
      </span>
    ),
    meta: { align: "right" } satisfies ColumnMeta,
  },
];
