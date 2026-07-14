"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "../host";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Plus,
  CaretRight,
  CaretDown,
  Check,
  UsersThree,
  Atom,
} from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { countEnabledTools } from "../host";
import { V2_FLAGS } from "../host";
import { Button } from "../ui/button";
import { PageHeader } from "../ui/page-header";
import { DataTable, type ColumnMeta } from "../ui/data-table";
import { RefreshButton } from "../ui/refresh-button";
import { SelfHostCreateAgentDialog } from "../agents/self-host-create-agent-dialog.js";

export type AgentRow = {
  name: string;
  role?: string;
  model?: string;
  allowedTools?: string[];
  skills?: string[];
  assignedLoops?: string[];
  team?: string;
  teamName?: string;
  team_name?: string;
};

export type TeamRow = { name: string; description?: string };

function teamOf(agent: AgentRow): string {
  const raw =
    (agent.teamName && agent.teamName.trim()) ||
    (agent.team_name && agent.team_name.trim()) ||
    (agent.team && agent.team.trim()) ||
    "default";
  return raw && raw !== "default" ? raw : "default";
}

export function AgentsTable({
  projectId,
  initialAgents,
  initialTeams,
}: {
  projectId: string;
  initialAgents: AgentRow[];
  initialTeams: TeamRow[];
}) {
  const polpo = usePolpoClient(projectId);
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);

  // "New agent" opens the Create-agent dialog, which hands off to the side
  // builder (nothing is installed directly).
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);

  const { data: agents = [], isFetching, refetch } = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => polpo.getAgents() as unknown as Promise<AgentRow[]>,
    initialData: initialAgents,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["teams", projectId],
    queryFn: () => polpo.getTeams() as unknown as Promise<TeamRow[]>,
    initialData: initialTeams,
  });

  const teamNames = useMemo(() => {
    const set = new Set<string>();
    for (const t of teams) if (t.name) set.add(t.name);
    for (const a of agents) set.add(teamOf(a));
    return [...set].sort((a, b) =>
      a === "default" ? 1 : b === "default" ? -1 : a.localeCompare(b),
    );
  }, [teams, agents]);

  const rows = useMemo(
    () =>
      selectedTeams.length
        ? agents.filter((a) => selectedTeams.includes(teamOf(a)))
        : agents,
    [agents, selectedTeams],
  );

  const columns = useMemo<ColumnDef<AgentRow, unknown>[]>(() => {
    const cols: ColumnDef<AgentRow, unknown>[] = [
      {
        id: "name",
        header: "Agent",
        accessorFn: (a) => a.name,
        cell: ({ row }) => {
          const a = row.original;
          return (
            <div className="flex items-center gap-2.5">
              {V2_FLAGS.showAvatars && <Monogram name={a.name} />}
              <div className="min-w-0 flex-1">
                <div
                  className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-brand"
                  data-mono
                >
                  {a.name}
                </div>
                {a.role && (
                  <div className="truncate text-[11px] text-muted-foreground/70">
                    {a.role}
                  </div>
                )}
              </div>
            </div>
          );
        },
        meta: { width: 300 } satisfies ColumnMeta,
      },
      {
        id: "team",
        header: "Team",
        accessorFn: (a) => teamOf(a),
        cell: ({ getValue }) => <TeamBadge name={getValue() as string} />,
        meta: { width: 150 } satisfies ColumnMeta,
      },
      {
        id: "model",
        header: "Model",
        accessorFn: (a) => a.model ?? "",
        cell: ({ getValue }) => {
          const v = getValue() as string;
          return v ? (
            <span className="font-mono text-[12px] text-muted-foreground" data-mono>
              {v}
            </span>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          );
        },
        meta: { width: 200 } satisfies ColumnMeta,
      },
      {
        id: "tools",
        header: "Tools",
        accessorFn: (a) => countEnabledTools(a.allowedTools ?? []),
        cell: ({ getValue }) => (
          <span className="text-[13px] text-muted-foreground" data-tabular>
            {getValue() as number}
          </span>
        ),
        meta: { align: "center", width: 76 } satisfies ColumnMeta,
      },
      {
        id: "skills",
        header: "Skills",
        accessorFn: (a) => a.skills?.length ?? 0,
        cell: ({ getValue }) => (
          <span className="text-[13px] text-muted-foreground" data-tabular>
            {getValue() as number}
          </span>
        ),
        meta: { align: "center", width: 76 } satisfies ColumnMeta,
      },
      {
        id: "open",
        header: "",
        enableSorting: false,
        cell: () => (
          <span data-reveal className="flex justify-end">
            <CaretRight size={14} className="text-muted-foreground" />
          </span>
        ),
        meta: { width: 44, align: "right" } satisfies ColumnMeta,
      },
    ];
    return cols.filter((c) => V2_FLAGS.showTeams || c.id !== "team");
  }, []);

  const teamCount = teamNames.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Agents"
        description={`${agents.length} ${agents.length === 1 ? "agent" : "agents"}${
          V2_FLAGS.showTeams
            ? ` · ${teamCount} ${teamCount === 1 ? "team" : "teams"}`
            : ""
        }`}
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus size={15} weight="bold" />
            New agent
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(a) => a.name}
        rowHref={(a) =>
          `/projects/${projectId}/agents/${encodeURIComponent(a.name)}`
        }
        searchPlaceholder="Search agents…"
        searchFn={(a, q) =>
          [a.name, a.role, teamOf(a), a.model].some((v) =>
            (v ?? "").toLowerCase().includes(q),
          )
        }
        filters={
          V2_FLAGS.showTeams && teamNames.length > 1 ? (
            <TeamFilter
              teams={teamNames}
              selected={selectedTeams}
              onToggle={(t) =>
                setSelectedTeams((prev) =>
                  prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
                )
              }
              onClear={() => setSelectedTeams([])}
            />
          ) : null
        }
        rightSlot={<RefreshButton onClick={() => refetch()} busy={isFetching} />}
        empty={<EmptyAgents onCreate={openCreate} />}
        emptyFiltered={
          <span className="text-sm text-muted-foreground">
            No agents match your search.
          </span>
        }
      />

      <SelfHostCreateAgentDialog
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}

export const AgentsView = AgentsTable;

/* ── Cell pieces ──────────────────────────────────────────────────────── */

function Monogram({ name }: { name: string }) {
  const initials =
    name
      .replace(/[^a-zA-Z0-9]/g, " ")
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || name.slice(0, 2).toUpperCase();
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[5px] border border-border bg-secondary text-[10px] font-semibold text-foreground">
      {initials}
    </span>
  );
}

function TeamBadge({ name }: { name: string }) {
  const isDefault = name === "default";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] ${
        isDefault
          ? "bg-muted text-muted-foreground"
          : "bg-brand/10 text-brand"
      }`}
    >
      {isDefault ? "default" : name}
    </span>
  );
}

/* ── Toolbar pieces ───────────────────────────────────────────────────── */

function TeamFilter({
  teams,
  selected,
  onToggle,
  onClear,
}: {
  teams: string[];
  selected: string[];
  onToggle: (t: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const count = selected.length;
  const label =
    count === 0
      ? "All teams"
      : count === 1
        ? selected[0] === "default"
          ? "default"
          : selected[0]
        : `${count} teams`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors hover:border-ring/40"
      >
        <UsersThree size={14} className="text-muted-foreground" />
        <span className="max-w-[140px] truncate">{label}</span>
        <CaretDown size={12} className="text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-52 rounded-md border border-border bg-popover p-1 shadow-lg">
          <div className="max-h-64 overflow-auto">
            {teams.map((t) => {
              const on = selected.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onToggle(t)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-secondary/60"
                >
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                      on
                        ? "border-brand bg-brand text-brand-foreground"
                        : "border-border"
                    }`}
                  >
                    {on && <Check size={11} weight="bold" />}
                  </span>
                  <span className="truncate">
                    {t === "default" ? "default" : t}
                  </span>
                </button>
              );
            })}
          </div>
          {count > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={onClear}
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

/* ── Empty state ──────────────────────────────────────────────────────── */

function EmptyAgents({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
        <Atom size={20} className="text-muted-foreground" />
      </span>
      <div className="text-center">
        <div className="text-sm font-medium text-foreground">No agents yet</div>
        <div className="mt-1 text-[13px] text-muted-foreground">
          Create one here, or run{" "}
          <code className="rounded bg-secondary px-1 py-0.5 text-[12px]">
            polpo deploy
          </code>{" "}
          from your project.
        </div>
      </div>
      <Button size="sm" onClick={onCreate}>
        <Plus size={15} weight="bold" />
        New agent
      </Button>
    </div>
  );
}
