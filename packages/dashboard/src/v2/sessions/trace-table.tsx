"use client";

import { useMemo, useState } from "react";
import { ClockCounterClockwise } from "@phosphor-icons/react";
import type { SessionsHostAdapter } from "./host.js";
import { type RunRow, type RunKind } from "./trace-normalize.js";
import { traceColumns } from "./trace-columns.js";

export function TraceTable({
  projectId,
  initial,
  host,
}: {
  projectId: string;
  initial: RunRow[];
  host: SessionsHostAdapter;
}) {
  const { PageHeader, DataTable, RefreshButton, MultiSelectFilter } = host.components;
  const [selectedKinds, setSelectedKinds] = useState<RunKind[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  const { data: runs = initial, isFetching, refetch } = host.data.useRuns({
    projectId,
    initial,
  });

  const agents = useMemo(
    () =>
      [...new Set(runs.map((r) => r.agent).filter(Boolean) as string[])].sort(),
    [runs],
  );
  const rows = useMemo(
    () =>
      runs.filter(
        (r) =>
          (selectedKinds.length === 0 || selectedKinds.includes(r.kind)) &&
          (selectedAgents.length === 0 ||
            (r.agent != null && selectedAgents.includes(r.agent))),
      ),
    [runs, selectedKinds, selectedAgents],
  );

  const columns = traceColumns;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="All runs in this project — chat sessions, tasks, and loop executions."
      />
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        rowHref={(r) => host.routes.run(projectId, r.id)}
        initialSorting={[{ id: "when", desc: true }]}
        searchPlaceholder="Search runs…"
        searchFn={(r, q) =>
          [r.title, r.agent, r.loop, r.status, r.id].some((v) =>
            (v ?? "").toLowerCase().includes(q),
          )
        }
        filters={
          <div className="flex items-center gap-2">
            <MultiSelectFilter
              allLabel="All types"
              options={[
                { value: "chat", label: "Chat" },
                { value: "task", label: "Task" },
              ]}
              selected={selectedKinds}
              onToggle={(v) =>
                setSelectedKinds((prev) =>
                  prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v],
                )
              }
              onClear={() => setSelectedKinds([])}
            />
            {agents.length > 0 && (
              <MultiSelectFilter
                allLabel="All agents"
                options={agents.map((a) => ({ value: a, label: a }))}
                selected={selectedAgents}
                onToggle={(v) =>
                  setSelectedAgents((prev) =>
                    prev.includes(v)
                      ? prev.filter((x) => x !== v)
                      : [...prev, v],
                  )
                }
                onClear={() => setSelectedAgents([])}
              />
            )}
          </div>
        }
        rightSlot={<RefreshButton onClick={() => refetch()} busy={isFetching} />}
        empty={
          isFetching ? (
            <span className="text-sm text-muted-foreground">Loading runs…</span>
          ) : (
            <div className="flex flex-col items-center gap-3 py-8">
              <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
                <ClockCounterClockwise
                  size={20}
                  className="text-muted-foreground"
                />
              </span>
              <div className="text-center">
                <div className="text-sm font-medium text-foreground">
                  No runs yet
                </div>
                <div className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                  Chat with an agent or start a task — chat sessions, tasks and
                  loop runs all show up here.
                </div>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
