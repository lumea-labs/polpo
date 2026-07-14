"use client";

import { Fragment, useMemo, useState } from "react";
import { Link } from "../host";
import { useRouter } from "../host";
import { useQuery, useQueryClient } from "../host";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Plus,
  Minus,
  Envelope,
  PencilSimple,
  MagnifyingGlass,
  PaperPlaneTilt,
  Robot,
  Wrench,
  User,
  ArrowsClockwise,
  CaretRight,
} from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { mutateDataPlane } from "../host";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { EmptyBox } from "../ui/bits";
import { DataTable, type ColumnMeta } from "../ui/data-table";

type LoopStep = { type?: string };
type Loop = {
  name: string;
  description?: string;
  start?: string;
  steps?: Record<string, LoopStep>;
};

function breakdown(loop: Loop) {
  const steps = Object.values(loop.steps ?? {});
  const by = (t: string) => steps.filter((s) => (s.type ?? "agent") === t).length;
  return {
    total: steps.length,
    agent: by("agent"),
    tool: by("tool"),
    human: by("human"),
    parallel: by("parallel"),
    while: by("while"),
  };
}

export function LoopsTab({
  projectId,
  agentName,
  assignedLoops,
}: {
  projectId: string;
  agentName: string;
  assignedLoops: string[];
}) {
  const polpo = usePolpoClient(projectId);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [assigned, setAssigned] = useState<string[]>(assignedLoops);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);

  const { data: loops = [] } = useQuery({
    queryKey: ["loops", projectId],
    queryFn: () => polpo.getLoops() as unknown as Promise<Loop[]>,
  });

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await mutateDataPlane(
        projectId,
        `/v1/agents/${encodeURIComponent(agentName)}`,
        { method: "PATCH", body },
      );
      await queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  function assign(name: string) {
    const next = [...new Set([...assigned, name])];
    setAssigned(next);
    patch({ assignedLoops: next });
    setAddOpen(false);
  }
  function unassign(name: string) {
    const next = assigned.filter((n) => n !== name);
    setAssigned(next);
    patch({ assignedLoops: next });
  }

  const { assignedCards, available } = useMemo(() => {
    const set = new Set(assigned);
    const byName = new Map(loops.map((l) => [l.name, l]));
    const assignedCards = assigned.map(
      (name) => byName.get(name) ?? ({ name } as Loop),
    );
    const available = loops.filter((l) => !set.has(l.name));
    return { assignedCards, available };
  }, [assigned, loops]);

  const columns = useMemo<ColumnDef<Loop, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Loop",
        accessorFn: (l) => l.name,
        cell: ({ row }) => {
          const loop = row.original;
          const missing = !loop.steps;
          return (
            <span className="flex items-center gap-1.5">
              <span
                className="font-mono text-[13px] font-medium text-foreground"
                data-mono
              >
                {loop.name}
              </span>
              {missing && (
                <span className="shrink-0 rounded bg-destructive/10 px-1 py-0.5 font-mono text-[9px] uppercase text-destructive">
                  missing
                </span>
              )}
            </span>
          );
        },
        meta: { width: 260 } satisfies ColumnMeta,
      },
      {
        id: "steps",
        header: "Steps",
        enableSorting: false,
        accessorFn: (l) => Object.keys(l.steps ?? {}).length,
        cell: ({ row }) => {
          const loop = row.original;
          if (!loop.steps)
            return <span className="text-muted-foreground/40">—</span>;
          const b = breakdown(loop);
          const parts = [
            b.agent && `${b.agent} agent`,
            b.tool && `${b.tool} tool`,
            b.human && `${b.human} human`,
            b.parallel && `${b.parallel} parallel`,
            b.while && `${b.while} while`,
          ].filter(Boolean);
          return (
            <span className="text-[12px] text-muted-foreground">
              {b.total} step{b.total === 1 ? "" : "s"}
              {parts.length > 0 && ` · ${parts.join(" · ")}`}
            </span>
          );
        },
      },
      {
        id: "remove",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const loop = row.original;
          return (
            <span data-reveal="" className="flex justify-end">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  unassign(loop.name);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={busy}
                aria-label="Unassign loop"
                className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
              >
                <Minus size={14} weight="bold" />
              </button>
            </span>
          );
        },
        meta: { width: 56, align: "right" } satisfies ColumnMeta,
      },
    ],
    [busy, unassign],
  );

  return (
    <div>
      <p className="mb-4 text-[13px] text-muted-foreground">
        A loop is a repeatable recipe your agent can run — a fixed set of steps it
        follows on its own, the same way every time. The default one runs when you
        don&rsquo;t pick a specific loop.{" "}
        <button
          type="button"
          onClick={() => setLearnOpen(true)}
          className="font-medium text-brand transition-colors hover:underline"
        >
          Learn more
        </button>
      </p>

      <LoopsHelpDialog open={learnOpen} onOpenChange={setLearnOpen} />

      <DataTable
        columns={columns}
        data={assignedCards}
        getRowId={(loop) => loop.name}
        rowHref={(loop) =>
          loop.steps
            ? `/projects/${projectId}/loops/${encodeURIComponent(loop.name)}`
            : ""
        }
        searchPlaceholder="Search loops…"
        searchFn={(loop, q) => loop.name.toLowerCase().includes(q)}
        rightSlot={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus size={14} weight="bold" />
            Add loop
          </Button>
        }
        empty={
          <span className="text-sm text-muted-foreground">
            No loops assigned. This agent runs the built-in loop.
          </span>
        }
        emptyFiltered={
          <span className="text-sm text-muted-foreground">
            No loops match your search.
          </span>
        }
      />

      {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="v2 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[14px] font-semibold">Add a loop</DialogTitle>
          </DialogHeader>
          {available.length === 0 ? (
            <EmptyBox>
              No other loops defined in this project.{" "}
              <Link
                href={`/projects/${projectId}/loops`}
                className="text-brand transition-colors hover:underline"
              >
                Create one
              </Link>
              .
            </EmptyBox>
          ) : (
            <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
              {available.map((loop) => (
                <LoopCard
                  key={loop.name}
                  projectId={projectId}
                  loop={loop}
                  busy={busy}
                  onAssign={() => assign(loop.name)}
                />
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LoopsHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const flow = [
    { icon: Envelope, label: "Read the request" },
    { icon: PencilSimple, label: "Draft a reply" },
    { icon: MagnifyingGlass, label: "Double-check it" },
    { icon: PaperPlaneTilt, label: "Send it" },
  ];
  const stepTypes = [
    { icon: Robot, label: "Agent", desc: "thinks or writes" },
    { icon: Wrench, label: "Tool", desc: "runs an action" },
    { icon: User, label: "Human", desc: "reviews or approves" },
    { icon: ArrowsClockwise, label: "Repeat", desc: "until it's done" },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-[14px] font-semibold">
            How loops work
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            A loop is a{" "}
            <span className="font-medium text-foreground">repeatable recipe</span>{" "}
            your agent follows — the same steps, in the same order, every time.
            Instead of improvising, it just runs the plan.
          </p>

          <div>
            <div className="mb-2 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
              Example — answering a support request
            </div>
            <div className="flex items-start gap-1 rounded-xl border border-border bg-card p-4">
              {flow.map((s, i) => {
                const Icon = s.icon;
                return (
                  <Fragment key={s.label}>
                    <div className="flex flex-1 flex-col items-center gap-2 text-center">
                      <span className="grid h-12 w-12 place-items-center rounded-xl border border-brand/25 bg-brand/[0.08] text-brand">
                        <Icon size={22} />
                      </span>
                      <span className="text-[11.5px] leading-tight text-foreground">
                        {s.label}
                      </span>
                    </div>
                    {i < flow.length - 1 && (
                      <CaretRight
                        size={16}
                        weight="bold"
                        className="mt-3.5 shrink-0 text-muted-foreground/35"
                      />
                    )}
                  </Fragment>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
              A step can be
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {stepTypes.map((s) => {
                const Icon = s.icon;
                return (
                  <div
                    key={s.label}
                    className="flex flex-col gap-0.5 rounded-lg border border-border bg-card p-3"
                  >
                    <Icon size={18} className="mb-1 text-brand" />
                    <div className="text-[13px] font-medium text-foreground">
                      {s.label}
                    </div>
                    <div className="text-[11.5px] leading-tight text-muted-foreground">
                      {s.desc}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-secondary/30 p-3.5">
              <div className="text-[13px] font-medium text-foreground">
                Why use one?
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                Predictable, consistent results for things you do often — perfect
                for automations. For open-ended chatting, you don&rsquo;t need one.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 p-3.5">
              <div className="text-[13px] font-medium text-foreground">
                The default loop
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                The one the agent runs automatically when you don&rsquo;t pick a
                specific loop.
              </p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LoopCard({
  loop,
  missing,
  busy,
  onUnassign,
  onAssign,
  projectId,
}: {
  loop: Loop;
  projectId: string;
  missing?: boolean;
  busy?: boolean;
  onUnassign?: () => void;
  onAssign?: () => void;
}) {
  const b = breakdown(loop);
  const parts = [
    b.agent && `${b.agent} agent`,
    b.tool && `${b.tool} tool`,
    b.human && `${b.human} human`,
    b.parallel && `${b.parallel} parallel`,
    b.while && `${b.while} while`,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {missing ? (
            <span className="truncate font-mono text-[12px] font-medium text-foreground">
              {loop.name}
            </span>
          ) : (
            <Link
              href={`/projects/${projectId}/loops/${encodeURIComponent(loop.name)}`}
              className="truncate font-mono text-[12px] font-medium text-foreground transition-colors hover:text-brand"
            >
              {loop.name}
            </Link>
          )}
          {missing && (
            <span className="shrink-0 rounded bg-destructive/10 px-1 py-0.5 font-mono text-[9px] uppercase text-destructive">
              missing
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onAssign && (
            <IconBtn label="Assign" onClick={onAssign} disabled={busy} variant="assign">
              <Plus size={14} weight="bold" />
            </IconBtn>
          )}
          {onUnassign && (
            <IconBtn label="Unassign" onClick={onUnassign} disabled={busy} variant="remove">
              <Minus size={14} weight="bold" />
            </IconBtn>
          )}
        </div>
      </div>
      {loop.description && (
        <p className="line-clamp-2 text-[12px] leading-snug text-muted-foreground">
          {loop.description}
        </p>
      )}
      {!missing && (
        <div className="font-mono text-[11px] text-muted-foreground/60">
          {b.total} step{b.total === 1 ? "" : "s"}
          {parts.length > 0 && ` · ${parts.join(" · ")}`}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  variant,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant: "assign" | "remove";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`grid h-6 w-6 place-items-center rounded-md border transition-colors disabled:opacity-50 ${
        variant === "assign"
          ? "border-border text-muted-foreground hover:border-brand/40 hover:text-brand"
          : "border-border text-muted-foreground hover:border-destructive/40 hover:text-destructive"
      }`}
    >
      {children}
    </button>
  );
}
