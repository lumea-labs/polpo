"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState, useMemo } from "react";
import Link from "next/link";
import { ChevronRight, RefreshCw, X, ListFilter, Search } from "lucide-react";
// Mixed imports — SDK 0.7.9 Task is missing `missionId` (present in core).
// Mission from SDK is fine. Track in OSS issue: SDK types should re-export from core.
import type { Task } from "@polpo-ai/core";
import type { Mission } from "@polpo-ai/sdk";
import { usePolpoClient } from "#/lib/polpo-client";
import { Button } from "#/components/ui/button";
import { Badge } from "#/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import {
  Command, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem,
} from "#/components/ui/command";

const ALL_STATUSES = [
  "draft", "pending", "awaiting_approval", "assigned",
  "in_progress", "review", "done", "failed",
] as const;

const statusColor: Record<string, string> = {
  done: "bg-brand",
  in_progress: "bg-foreground animate-pulse",
  pending: "bg-muted-foreground/30",
  failed: "bg-destructive",
  review: "bg-yellow-500",
  assigned: "bg-muted-foreground/50",
  draft: "bg-muted-foreground/20",
  awaiting_approval: "bg-yellow-500",
};

const LIVE_STATUSES = new Set(["pending", "assigned", "in_progress", "review", "awaiting_approval"]);

function timeAgo(date?: string) {
  if (!date) return "\u2014";
  const diff = Date.now() - new Date(date).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function duration(ms?: number) {
  if (!ms) return "\u2014";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function TasksView({
  initialTasks,
  initialMissions,
}: {
  initialTasks: Task[];
  initialMissions: Mission[];
}) {
  const { id } = useParams<{ id: string }>();
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [filterMission, setFilterMission] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [statusOpen, setStatusOpen] = useState(false);
  const [missionOpen, setMissionOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const PER_PAGE = 15;

  const polpo = usePolpoClient(id);
  const { data: tasks = [], isFetching, refetch } = useQuery({
    queryKey: ["tasks", id],
    queryFn: () => polpo.getTasks() as unknown as Promise<Task[]>,
    initialData: initialTasks,
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((task) => LIVE_STATUSES.has(task.status)) ? 5000 : false;
    },
  });

  const { data: missions = [] } = useQuery({
    queryKey: ["missions", id],
    queryFn: () => polpo.getMissions(),
    initialData: initialMissions,
  });

  const activeStatuses = useMemo(
    () => [...new Set(tasks.map(t => t.status).filter(Boolean))].sort(
      (a, b) => ALL_STATUSES.indexOf(a as typeof ALL_STATUSES[number]) - ALL_STATUSES.indexOf(b as typeof ALL_STATUSES[number])
    ),
    [tasks]
  );

  const taskMissionIds = useMemo(
    () => [...new Set(tasks.map(t => t.missionId).filter(Boolean))] as string[],
    [tasks]
  );

  const activeAgents = useMemo(
    () => [...new Set(tasks.map(t => t.assignTo).filter(Boolean))].sort() as string[],
    [tasks]
  );

  const missionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of missions) map.set(m.id, m.name ?? m.id.slice(0, 8));
    return map;
  }, [missions]);

  const filtered = useMemo(() => {
    let result = tasks;
    if (filterStatus) result = result.filter(t => t.status === filterStatus);
    if (filterMission === "__none__") result = result.filter(t => !t.missionId);
    else if (filterMission) result = result.filter(t => t.missionId === filterMission);
    if (filterAgent) result = result.filter(t => t.assignTo === filterAgent);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        (t.title ?? "").toLowerCase().includes(q) ||
        (t.assignTo ?? "").toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    }
    return result;
  }, [tasks, filterStatus, filterMission, filterAgent, search]);

  const hasFilters = filterStatus !== null || filterMission !== null || filterAgent !== null;
  const paged = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(filtered.length / PER_PAGE);

  return (
    <div>
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Tasks</h2>
        <p className="mt-1 text-xs text-muted-foreground">{tasks.length} total</p>
      </div>

      {/* Filters + Search */}
      {tasks.length > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search..."
              className="w-48 border border-border bg-transparent pl-9 pr-3 py-1.5 text-xs placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors"
            />
          </div>

          {/* Status filter */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger
              render={
                <Button variant="outline" size="sm" data-testid="filter-status">
                  <ListFilter className="h-3 w-3" />
                  {filterStatus ? (
                    <>
                      Status: <Badge variant="secondary" className="ml-1 font-normal">{filterStatus.replace(/_/g, " ")}</Badge>
                    </>
                  ) : (
                    "Status"
                  )}
                </Button>
              }
            />
            <PopoverContent className="w-52 p-0" align="start">
              <Command>
                <CommandInput placeholder="Search status..." />
                <CommandList>
                  <CommandEmpty>No status found.</CommandEmpty>
                  <CommandGroup>
                    {activeStatuses.map(s => (
                      <CommandItem
                        key={s}
                        value={s}
                        data-checked={filterStatus === s || undefined}
                        onSelect={() => {
                          setFilterStatus(filterStatus === s ? null : s);
                          setStatusOpen(false);
                        }}
                      >
                        <span className={`h-2 w-2 rounded-full shrink-0 ${statusColor[s]}`} />
                        {s.replace(/_/g, " ")}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {/* Mission filter */}
          {taskMissionIds.length > 0 && (
            <Popover open={missionOpen} onOpenChange={setMissionOpen}>
              <PopoverTrigger
                render={
                  <Button variant="outline" size="sm" data-testid="filter-mission">
                    <ListFilter className="h-3 w-3" />
                    {filterMission ? (
                      <>
                        Mission: <Badge variant="secondary" className="ml-1 font-normal">
                          {filterMission === "__none__" ? "No mission" : (missionMap.get(filterMission) ?? filterMission.slice(0, 8))}
                        </Badge>
                      </>
                    ) : (
                      "Mission"
                    )}
                  </Button>
                }
              />
              <PopoverContent className="w-56 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search mission..." />
                  <CommandList>
                    <CommandEmpty>No mission found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="__none__"
                        data-checked={filterMission === "__none__" || undefined}
                        onSelect={() => {
                          setFilterMission(filterMission === "__none__" ? null : "__none__");
                          setMissionOpen(false);
                        }}
                      >
                        <span className="text-muted-foreground">No mission</span>
                      </CommandItem>
                      {taskMissionIds.map(mid => (
                        <CommandItem
                          key={mid}
                          value={missionMap.get(mid) ?? mid}
                          data-checked={filterMission === mid || undefined}
                          onSelect={() => {
                            setFilterMission(filterMission === mid ? null : mid);
                            setMissionOpen(false);
                          }}
                        >
                          {missionMap.get(mid) ?? mid.slice(0, 8)}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}

          {/* Agent filter */}
          {activeAgents.length > 1 && (
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger
                render={
                  <Button variant="outline" size="sm" data-testid="filter-agent">
                    <ListFilter className="h-3 w-3" />
                    {filterAgent ? (
                      <>
                        Agent: <Badge variant="secondary" className="ml-1 font-normal">{filterAgent}</Badge>
                      </>
                    ) : (
                      "Agent"
                    )}
                  </Button>
                }
              />
              <PopoverContent className="w-52 p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search agent..." />
                  <CommandList>
                    <CommandEmpty>No agent found.</CommandEmpty>
                    <CommandGroup>
                      {activeAgents.map(a => (
                        <CommandItem
                          key={a}
                          value={a}
                          data-checked={filterAgent === a || undefined}
                          onSelect={() => {
                            setFilterAgent(filterAgent === a ? null : a);
                            setAgentOpen(false);
                            setPage(0);
                          }}
                        >
                          {a}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}

          {/* Active filter badges + clear */}
          {hasFilters && (
            <>
              <span className="text-xs text-muted-foreground">
                {filtered.length} of {tasks.length}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { setFilterStatus(null); setFilterMission(null); setFilterAgent(null); setSearch(""); setPage(0); }}
                data-testid="clear-filters"
              >
                <X className="h-3 w-3" />
                Clear
              </Button>
            </>
          )}

          {/* Refresh */}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="refresh-btn"
            className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      )}

      {/* Table */}
      {filtered.length > 0 ? (
        <div data-testid="tasks-table" className="mt-4 border border-border overflow-hidden overflow-x-auto min-w-[600px]">
          <div className="flex items-center border-b border-border bg-secondary/50 text-left text-xs font-medium text-muted-foreground">
            <span className="px-4 py-2.5 w-28">Status</span>
            <span className="px-4 py-2.5 flex-1">Task</span>
            <span className="px-4 py-2.5 w-24">Agent</span>
            <span className="px-4 py-2.5 w-20">Duration</span>
            <span className="px-4 py-2.5 w-16">Retries</span>
            <span className="px-4 py-2.5 w-20 text-right">Updated</span>
            <span className="w-8" />
          </div>
          {paged.map((task) => (
            <Link
              key={task.id}
              href={`/projects/${id}/tasks/${task.id}`}
              data-testid={`task-row-${task.id}`}
              className="flex items-center border-b border-border last:border-0 hover:bg-secondary/30 transition-colors group"
            >
              <span className="px-4 py-3 w-28">
                <span className="inline-flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${statusColor[task.status ?? "pending"]}`} />
                  <span className="text-xs text-muted-foreground">{task.status}</span>
                </span>
              </span>
              <span className="px-4 py-3 flex-1">
                <span className="text-sm font-medium block">{task.title}</span>
                {task.missionId && (
                  <span className="block mt-0.5 text-[11px] text-muted-foreground/50">
                    mission: {missionMap.get(task.missionId) ?? task.missionId.slice(0, 8)}
                  </span>
                )}
                {task.dependsOn && task.dependsOn.length > 0 && (
                  <span className="block mt-0.5 text-[11px] text-muted-foreground/50">
                    depends on: {task.dependsOn.join(", ")}
                  </span>
                )}
              </span>
              <span className="px-4 py-3 w-24 font-mono text-xs text-muted-foreground">
                {task.assignTo ?? "\u2014"}
              </span>
              <span className="px-4 py-3 w-20 font-mono text-xs text-muted-foreground">
                {duration(task.result?.duration)}
              </span>
              <span className="px-4 py-3 w-16 text-xs text-muted-foreground">
                {task.retries ?? 0}/{task.maxRetries ?? 3}
              </span>
              <span className="px-4 py-3 w-20 text-right text-xs text-muted-foreground">
                {timeAgo(task.updatedAt)}
              </span>
              <span className="px-2 py-3 w-8">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
              </span>
            </Link>
          ))}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
              <span className="text-xs text-muted-foreground">
                {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground border border-border transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground border border-border transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      ) : tasks.length > 0 ? (
        <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          {search ? "No tasks matching your search." : "No tasks match the current filters."}
        </div>
      ) : (
        <div data-testid="tasks-empty" className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          No tasks yet.
        </div>
      )}
    </div>
  );
}
