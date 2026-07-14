"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  User,
  ChatCircle,
  Wrench,
  GearSix,
  CaretRight,
  CaretDown,
  Check,
  Code,
  Rows,
} from "@phosphor-icons/react";
import { useSessionsHost, type ColumnMeta } from "./host.js";
import type {
  TraceNode,
  TraceStep,
  TraceActor,
  TraceTone,
  TracePayload,
} from "./trace-detail.js";

/* ── shared visual maps ───────────────────────────────────────────────── */

const TONE_DOT: Record<TraceTone, string> = {
  neutral: "bg-muted-foreground/40",
  success: "bg-emerald-500",
  running: "bg-brand",
  failed: "bg-destructive",
  warning: "bg-amber-500",
};
const ACTOR_DOT: Record<TraceActor, string> = {
  user: "bg-muted-foreground/40",
  assistant: "bg-brand",
  system: "bg-muted-foreground/30",
  tool: "bg-sky-500",
  event: "bg-muted-foreground/30",
};
const ACTOR_ICON: Record<TraceActor, typeof User> = {
  user: User,
  assistant: ChatCircle,
  system: GearSix,
  tool: Wrench,
  event: GearSix,
};

function fmt(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Full timestamp incl. millis, for the analytical log view. */
function fmtRaw(ts?: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
    d.getMilliseconds(),
    3,
  )}`;
}

function duration(a?: string, b?: string): string {
  if (!a || !b) return "";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function StatusPill({ status, tone }: { status: string; tone?: TraceTone }) {
  const color =
    tone === "success"
      ? "text-emerald-600 bg-emerald-500/10"
      : tone === "failed"
        ? "text-destructive bg-destructive/10"
        : tone === "running"
          ? "text-brand bg-brand/10"
          : tone === "warning"
            ? "text-amber-600 bg-amber-500/10"
            : "text-muted-foreground bg-secondary";
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[9px] tracking-[0.06em] ${color}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/* ── raw log view — dense, analytical, verbatim source objects ─────────── */

/** Flatten the tree (phases → their children) into a chronological log, each
 *  row keeping the phase it belonged to for context. */
function flatten(
  nodes: TraceNode[],
): Array<{ step: TraceStep; phase?: string }> {
  const out: Array<{ step: TraceStep; phase?: string }> = [];
  for (const node of nodes) {
    if (node.kind === "phase") {
      for (const c of node.children) out.push({ step: c, phase: node.label });
    } else {
      out.push({ step: node });
    }
  }
  return out;
}

/** A stable, filterable category token for a step — `user`, `assistant`,
 *  `tool_call`, `tool_result`, `loop_transition`, … derived from the source. */
function stepKind(step: TraceStep): string {
  if (step.actor === "user" || step.actor === "assistant" || step.actor === "system")
    return step.actor;
  const raw = step.raw as { type?: string; event?: string } | undefined;
  const t = raw?.type ?? raw?.event ?? step.label ?? step.actor;
  return String(t)
    .trim()
    .replace(/[.\s/-]+/g, "_")
    .replace(/[^\w]/g, "")
    .toLowerCase();
}

function stringifyRaw(step: TraceStep): string {
  const src = step.raw ?? {
    actor: step.actor,
    label: step.label,
    sublabel: step.sublabel,
    status: step.status,
    ts: step.ts,
    body: step.body,
    payload: step.payload,
  };
  try {
    return JSON.stringify(src, null, 2);
  } catch {
    return String(src);
  }
}

type RawTraceRow = {
  id: string;
  index: number;
  step: TraceStep;
  phase?: string;
  kind: string;
  raw: string;
};

function rowContent(row: RawTraceRow): string {
  // Debug trace: always show the raw payload (collapsed to one line), never a
  // derived summary — the content column mirrors the raw JSON of the row.
  const raw = row.raw.replace(/\s+/g, " ").trim();
  return raw && raw !== "{}" && raw !== "null" ? raw : "—";
}

/** Chips to include/exclude step kinds — generated from what the run contains. */
function FilterBar({
  kinds,
  selected,
  onChange,
}: {
  kinds: Array<{ kind: string; count: number; dot: string }>;
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const allKinds = kinds.map((item) => item.kind);
  const values = selected.length > 0 ? selected : allKinds;
  const label =
    values.length === allKinds.length
      ? "All types"
      : values.length === 1
        ? values[0]
        : `${values.length} types`;

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (kind: string) => {
    const current = selected.length > 0 ? selected : allKinds;
    const next = current.includes(kind)
      ? current.filter((item) => item !== kind)
      : [...current, kind];
    if (next.length === 0) return;
    onChange(next.length === allKinds.length ? [] : next);
  };

  if (kinds.length <= 1) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors hover:border-ring/40"
      >
        <span className="max-w-[140px] truncate">{label}</span>
        <CaretDown size={12} className="text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-md border border-border bg-popover p-1 shadow-lg">
          <div className="max-h-64 overflow-auto">
            {kinds.map(({ kind, count }) => {
              const on = values.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => toggle(kind)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-secondary/60"
                >
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                      on ? "border-brand bg-brand text-brand-foreground" : "border-border"
                    }`}
                  >
                    {on && <Check size={11} weight="bold" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{kind}</span>
                  <span className="font-mono text-[11px] text-muted-foreground" data-tabular>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          {selected.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={() => onChange([])}
                className="w-full rounded px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RawLog({ nodes, rightSlot }: { nodes: TraceNode[]; rightSlot?: ReactNode }) {
  const { DataTable } = useSessionsHost().components;
  const rows = useMemo<RawTraceRow[]>(
    () =>
      // Newest first — a debug trace reads top-down from the latest event.
      [...flatten(nodes)].reverse().map(({ step, phase }, index) => ({
        id: `${step.id}-${index}`,
        index,
        step,
        phase,
        kind: stepKind(step),
        raw: stringifyRaw(step),
      })),
    [nodes],
  );
  const kinds = useMemo(() => {
    const map = new Map<string, { count: number; dot: string }>();
    for (const row of rows) {
      const k = row.kind;
      const dot = row.step.tone ? TONE_DOT[row.step.tone] : ACTOR_DOT[row.step.actor];
      const cur = map.get(k);
      if (cur) cur.count++;
      else map.set(k, { count: 1, dot });
    }
    return [...map.entries()].map(([kind, v]) => ({ kind, ...v }));
  }, [rows]);
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);
  const visibleKinds = selectedKinds.length > 0 ? new Set(selectedKinds) : new Set(kinds.map((item) => item.kind));
  const visible = rows.filter((row) => visibleKinds.has(row.kind));
  // Multiple rows may stay open at once — a debug trace often needs to compare
  // several payloads side by side.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const columns = useMemo<ColumnDef<RawTraceRow, unknown>[]>(
    () => [
      {
        id: "event",
        header: "event",
        accessorFn: (row) => row.step.label,
        cell: ({ row }) => {
          const item = row.original.step;
          const open = expandedIds.has(row.original.id);
          return (
            <div className="flex min-w-0 items-center gap-2">
              <CaretRight
                size={11}
                className={`shrink-0 text-muted-foreground/50 transition-transform ${
                  open ? "rotate-90 text-brand" : ""
                }`}
              />
              <span className="shrink-0 font-mono text-[12px] font-medium text-foreground">
                {item.label}
              </span>
              {item.sublabel && (
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {item.sublabel}
                </span>
              )}
            </div>
          );
        },
        meta: { width: 220 } satisfies ColumnMeta,
      },
      {
        id: "content",
        header: "content",
        accessorFn: rowContent,
        cell: ({ row }) => (
          <span className="line-clamp-1 text-[12px] text-muted-foreground">
            {rowContent(row.original)}
          </span>
        ),
      },
      {
        id: "time",
        header: "time",
        accessorFn: (row) => row.step.ts ?? "",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground/70" data-tabular>
            {fmtRaw(row.original.step.ts)}
          </span>
        ),
        meta: { width: 128 } satisfies ColumnMeta,
      },
    ],
    [expandedIds],
  );

  return (
    <DataTable
      columns={columns}
      data={visible}
      getRowId={(row) => row.id}
      rowOnClick={(row) =>
        setExpandedIds((prev) => {
          const next = new Set(prev);
          if (next.has(row.id)) next.delete(row.id);
          else next.add(row.id);
          return next;
        })
      }
      isRowExpanded={(row) => expandedIds.has(row.id)}
      renderExpandedRow={(row) => <RawTraceExpanded row={row} />}
      searchPlaceholder="Search trace…"
      searchFn={(row, q) =>
        [
          row.step.label,
          row.step.sublabel,
          row.step.actor,
          row.step.status,
          row.phase,
          row.kind,
          row.raw,
        ].some((value) => (value ?? "").toLowerCase().includes(q))
      }
      filters={
        <FilterBar
          kinds={kinds}
          selected={selectedKinds}
          onChange={setSelectedKinds}
        />
      }
      rightSlot={rightSlot}
      pageSize={12}
      empty={<span className="text-sm text-muted-foreground">No trace entries.</span>}
      emptyFiltered={
        <span className="text-sm text-muted-foreground">
          No entries match the active filters.
        </span>
      }
    />
  );
}

function RawTraceExpanded({ row }: { row: RawTraceRow }) {
  const { CodeBlock, CopyButton } = useSessionsHost().components;
  return (
    <div className="overflow-hidden rounded-md border border-border border-l-2 border-l-brand bg-card">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-2.5 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          Raw payload
        </span>
        <CopyButton text={row.raw} label="Copy" />
      </div>
      <CodeBlock
        code={row.raw}
        lang="json"
        bare
        wrap
        showCopy={false}
        maxHeightClass="max-h-[44vh]"
        className="[&_.shiki-block]:rounded-none [&_.shiki-block]:border-0 [&_.shiki-block]:bg-transparent [&_pre]:rounded-none [&_pre]:border-0 [&_pre]:bg-transparent"
      />
    </div>
  );
}

/* ── smart value — pick the best presentation for a payload string ─────── */

function detect(value: string): { mode: "json" | "code" | "markdown" | "text"; lang?: string } {
  const v = value.trim();
  if (!v) return { mode: "text" };
  if (
    (v.startsWith("{") && v.endsWith("}")) ||
    (v.startsWith("[") && v.endsWith("]"))
  ) {
    try {
      JSON.parse(v);
      return { mode: "json" };
    } catch {
      /* not JSON */
    }
  }
  if (
    /```/.test(v) ||
    /^#{1,6}\s/m.test(v) ||
    /^\s*[-*+]\s+/m.test(v) ||
    /\[[^\]]+\]\([^)]+\)/.test(v) ||
    /\|.*\|/.test(v)
  ) {
    return { mode: "markdown" };
  }
  if (v.includes("\n")) return { mode: "code", lang: "text" };
  return { mode: "text" };
}

function SmartValue({
  value,
  format = "auto",
  lang,
}: {
  value: string;
  format?: TracePayload["format"];
  lang?: string;
}) {
  const { CodeBlock, Markdown } = useSessionsHost().components;
  const v = value.trim();
  const resolved =
    format && format !== "auto"
      ? { mode: format, lang }
      : detect(v);

  if (resolved.mode === "json") {
    let pretty = v;
    try {
      pretty = JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      /* keep as-is */
    }
    return (
      <CodeBlock
        code={pretty}
        lang="json"
        showCopy
        maxHeightClass="max-h-[45vh]"
      />
    );
  }
  if (resolved.mode === "code") {
    return (
      <CodeBlock
        code={v}
        lang={resolved.lang ?? lang ?? "text"}
        showCopy
        maxHeightClass="max-h-[45vh]"
      />
    );
  }
  if (resolved.mode === "markdown") {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] leading-relaxed">
        <Markdown content={v} />
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground">
      {v}
    </div>
  );
}

/* Collapsible payload blocks (tool input/output, event data). */
function Payloads({ payload }: { payload?: TracePayload[] }) {
  if (!payload || payload.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {payload.map((p, i) => {
        // Short single-line values render inline — no need to collapse.
        const short = !p.value.includes("\n") && p.value.length <= 80;
        if (short) {
          return (
            <div key={i} className="flex items-baseline gap-2 text-[12px]">
              <span className="font-mono text-[10px] tracking-[0.06em] text-muted-foreground/60">
                {p.label}
              </span>
              <span className="font-mono text-foreground">{p.value}</span>
            </div>
          );
        }
        return (
          <details key={i} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
              <CaretRight
                size={11}
                className="transition-transform group-open:rotate-90"
              />
              <span className="font-mono tracking-[0.06em]">
                {p.label}
              </span>
            </summary>
            <div className="mt-1.5">
              <SmartValue value={p.value} format={p.format} lang={p.lang} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

/* ── step renderers ───────────────────────────────────────────────────── */

/* Conversation turn — bubble with markdown body. */
function Turn({ item }: { item: TraceStep }) {
  const { Markdown } = useSessionsHost().components;
  const Icon = ACTOR_ICON[item.actor];
  const assistant = item.actor === "assistant";
  return (
    <div
      className={`rounded-lg border px-3.5 py-2.5 ${
        assistant ? "border-border bg-card" : "border-transparent bg-secondary/40"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Icon
          size={13}
          className={assistant ? "text-brand" : "text-muted-foreground"}
        />
        <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground/60">
          {item.label}
        </span>
        {item.sublabel && (
          <span className="text-[10px] text-muted-foreground/50">
            · {item.sublabel}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/40">
          {fmt(item.ts)}
        </span>
      </div>
      {item.body ? (
        <div className="text-[13px] leading-relaxed text-foreground [&_p]:my-1 [&_pre]:my-2">
          <Markdown content={item.body} />
        </div>
      ) : (
        <span className="text-[12px] text-muted-foreground/40">(no content)</span>
      )}
      <Payloads payload={item.payload} />
    </div>
  );
}

/* Execution event — compact row, smart body. */
function Event({ item }: { item: TraceStep }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[12px] font-medium text-foreground">
          {item.label}
        </span>
        {item.sublabel && (
          <span className="font-mono text-[12px] text-muted-foreground">
            {item.sublabel}
          </span>
        )}
        {item.status && <StatusPill status={item.status} tone={item.tone} />}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground/40">
          {fmt(item.ts)}
        </span>
      </div>
      {item.body && (
        <div className="mt-1.5">
          {item.tone === "failed" ? (
            <div className="whitespace-pre-wrap rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              {item.body}
            </div>
          ) : (
            <SmartValue value={item.body} />
          )}
        </div>
      )}
      <Payloads payload={item.payload} />
    </div>
  );
}

function Step({ item }: { item: TraceStep }) {
  return item.actor === "user" || item.actor === "assistant" ? (
    <Turn item={item} />
  ) : (
    <Event item={item} />
  );
}

/* Loop phase — a collapsible group wrapping its work, in the same timeline. */
function Phase({ phase }: { phase: Extract<TraceNode, { kind: "phase" }> }) {
  const dur = duration(phase.startTs, phase.endTs);
  return (
    <details open className="group/phase">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <CaretRight
          size={13}
          className="text-muted-foreground/60 transition-transform group-open/phase:rotate-90"
        />
        <span className="font-mono text-[12px] font-medium text-foreground">
          {phase.label}
        </span>
        {phase.status && <StatusPill status={phase.status} tone={phase.tone} />}
        {dur && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/40">
            {dur}
          </span>
        )}
      </summary>
      {phase.children.length > 0 ? (
        <ol className="mt-2.5 ml-1.5 flex flex-col gap-3 border-l border-border/60 pl-4">
          {phase.children.map((c) => (
            <li key={c.id}>
              <Step item={c} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-1.5 ml-1.5 pl-4 text-[11px] text-muted-foreground/40">
          no events
        </div>
      )}
    </details>
  );
}

/* The human-readable timeline. */
function ReadableTrace({ items }: { items: TraceNode[] }) {
  return (
    <ol className="relative flex flex-col gap-0 border-l border-border pl-5">
      {items.map((node) => {
        const isPhase = node.kind === "phase";
        const tone = isPhase ? node.tone : node.tone;
        const actor = isPhase ? "event" : node.actor;
        const dot = tone ? TONE_DOT[tone] : ACTOR_DOT[actor];
        return (
          <li key={node.id} className="relative pb-3 last:pb-0">
            <span
              className={`absolute -left-[26px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-background ${dot}`}
            />
            {isPhase ? <Phase phase={node} /> : <Step item={node} />}
          </li>
        );
      })}
    </ol>
  );
}

/* ── view toggle ──────────────────────────────────────────────────────── */

type View = "raw" | "readable";

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const opts: Array<{ id: View; label: string; icon: typeof Code }> = [
    { id: "raw", label: "Raw", icon: Code },
    { id: "readable", label: "Readable", icon: Rows },
  ];
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-secondary/50 p-0.5">
      {opts.map((o) => {
        const active = view === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon size={13} weight={active ? "bold" : "regular"} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── the one unified Trace ────────────────────────────────────────────── */

export function Trace({ items, rightSlot }: { items: TraceNode[]; rightSlot?: ReactNode }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3.5 py-4 text-[13px] text-muted-foreground/60">
        Nothing recorded yet.
      </div>
    );
  }
  return <RawLog nodes={items} rightSlot={rightSlot} />;
}
