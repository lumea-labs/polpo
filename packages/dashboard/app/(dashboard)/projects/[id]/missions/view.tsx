"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState, useMemo } from "react";
import Link from "next/link";
import { RefreshCw, X, ListFilter, Search } from "lucide-react";
// Use SDK-bundled types so we're aligned with what `polpo.getMissions()` returns.
// `@polpo-ai/core` and `@polpo-ai/sdk` types should match but the SDK 0.7.9
// build ships a degraded copy (e.g. NotificationRule.condition: unknown vs
// NotificationCondition). Track in OSS issue: SDK should re-export from core.
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
  "draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled",
] as const;

const statusColor: Record<string, string> = {
  completed: "bg-brand",
  active: "bg-foreground animate-pulse",
  scheduled: "bg-blue-500/50",
  recurring: "bg-blue-500",
  failed: "bg-destructive",
  paused: "bg-yellow-500",
  cancelled: "bg-muted-foreground/30",
  draft: "bg-muted-foreground/20",
};

const LIVE_STATUSES = new Set(["active", "paused"]);

function getMissionType(m: Mission): string {
  if (m.status === "recurring" || (m.schedule && /^[\d*\/,-]+\s/.test(m.schedule))) return "recurring";
  if (m.schedule) return "one-shot";
  return "on-demand";
}

const typeBadge: Record<string, { label: string; className: string }> = {
  recurring: { label: "Recurring", className: "bg-blue-500/10 text-blue-400" },
  "one-shot": { label: "One-shot", className: "bg-amber-500/10 text-amber-400" },
  "on-demand": { label: "On-demand", className: "bg-muted-foreground/10 text-muted-foreground" },
};

function timeAgo(date?: string) {
  if (!date) return "\u2014";
  const diff = Date.now() - new Date(date).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function MissionsView({ initialMissions }: { initialMissions: Mission[] }) {
  const { id } = useParams<{ id: string }>();
  const [filterStatus, setFilterStatus] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusOpen, setStatusOpen] = useState(false);

  const polpo = usePolpoClient(id);
  const { data: missions = [], isFetching, refetch } = useQuery({
    queryKey: ["missions", id],
    queryFn: () => polpo.getMissions(),
    initialData: initialMissions,
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.some((mission) => LIVE_STATUSES.has(mission.status)) ? 5000 : false;
    },
  });

  const activeStatuses = useMemo(
    () => [...new Set(missions.map(m => m.status).filter(Boolean))].sort(
      (a, b) => ALL_STATUSES.indexOf(a as typeof ALL_STATUSES[number]) - ALL_STATUSES.indexOf(b as typeof ALL_STATUSES[number])
    ),
    [missions]
  );

  const filtered = useMemo(() => {
    let result = missions;
    if (filterStatus) result = result.filter(m => m.status === filterStatus);
    if (filterType) result = result.filter(m => getMissionType(m) === filterType);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(m =>
        m.name?.toLowerCase().includes(q) || m.prompt?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [missions, filterStatus, filterType, search]);

  const hasFilters = filterStatus !== null || filterType !== null || search !== "";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Missions</h2>
          <p className="mt-1 text-xs text-muted-foreground">{missions.length} total</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      {missions.length > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {/* Type tabs */}
          <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
            {(["all", "recurring", "one-shot", "on-demand"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setFilterType(t === "all" ? null : t)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  (t === "all" && !filterType) || filterType === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "all" ? "All" : t === "one-shot" ? "One-shot" : t === "on-demand" ? "On-demand" : "Recurring"}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search missions..."
              className="h-8 w-48 rounded-md border border-border bg-transparent pl-8 pr-3 text-xs focus:border-foreground/30 focus:outline-none transition-colors"
            />
          </div>

          {/* Status filter */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger
              render={
                <Button variant="outline" size="sm">
                  <ListFilter className="h-3 w-3" />
                  {filterStatus ? (
                    <>
                      Status: <Badge variant="secondary" className="ml-1 font-normal">{filterStatus}</Badge>
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
                        {s}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

          {/* Clear */}
          {hasFilters && (
            <>
              <span className="text-xs text-muted-foreground">
                {filtered.length} of {missions.length}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { setFilterStatus(null); setFilterType(null); setSearch(""); }}
              >
                <X className="h-3 w-3" />
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      {/* Table */}
      {filtered.length > 0 ? (
        <div className="mt-4 border border-border overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-24">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Mission</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-24">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-24">Schedule</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-16">Runs</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground w-20">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((mission) => {
                const type = getMissionType(mission);
                const badge = typeBadge[type];
                return (
                  <tr key={mission.id} className="border-b border-border last:border-0">
                    <td colSpan={6} className="p-0">
                      <Link
                        href={`/projects/${id}/missions/${mission.id}`}
                        className="flex items-center hover:bg-secondary/30 transition-colors"
                      >
                        <span className="px-4 py-3 w-24">
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`h-2 w-2 rounded-full ${statusColor[mission.status ?? "draft"]}`} />
                            <span className="text-xs text-muted-foreground">{mission.status}</span>
                          </span>
                        </span>
                        <span className="px-4 py-3 flex-1">
                          <span className="font-mono text-xs font-medium block">{mission.name}</span>
                          {mission.prompt && (
                            <span className="mt-0.5 text-[11px] text-muted-foreground/60 truncate max-w-xs block">{mission.prompt}</span>
                          )}
                        </span>
                        <span className="px-4 py-3 w-24">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
                            {badge.label}
                          </span>
                        </span>
                        <span className="px-4 py-3 w-24 font-mono text-xs text-muted-foreground">
                          {mission.schedule ?? "\u2014"}
                        </span>
                        <span className="px-4 py-3 w-16 text-xs text-muted-foreground">
                          {mission.executionCount ?? 0}
                        </span>
                        <span className="px-4 py-3 w-20 text-right text-xs text-muted-foreground">
                          {timeAgo(mission.updatedAt)}
                        </span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : missions.length > 0 ? (
        <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          No missions match the current filters.
        </div>
      ) : (
        <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          No missions yet.
        </div>
      )}
    </div>
  );
}
