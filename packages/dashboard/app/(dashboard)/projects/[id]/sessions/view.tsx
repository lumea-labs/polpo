"use client";

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ChevronRight, RefreshCw, Search, ListFilter, X } from "lucide-react";
import { usePolpoClient } from "../../../../../lib/polpo-client";
import { Button } from "../../../../../components/ui/button";
import { Badge } from "../../../../../components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../../components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "../../../../../components/ui/command";

export interface Session {
  id: string;
  title?: string;
  agent?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const PER_PAGE = 15;

export default function SessionsView({
  initialSessions,
}: {
  initialSessions: Session[];
}) {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [filterAgent, setFilterAgent] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);

  const polpo = usePolpoClient(id);
  const { data: sessions = [], isFetching, refetch } = useQuery({
    queryKey: ["all-sessions", id],
    queryFn: async () => {
      const r = await polpo.getSessions();
      return (r.sessions ?? []) as unknown as Session[];
    },
    initialData: initialSessions,
  });

  const activeAgents = useMemo(
    () => [...new Set(sessions.map((s) => s.agent).filter(Boolean))].sort() as string[],
    [sessions]
  );

  const filtered = useMemo(() => {
    let result = sessions;
    if (filterAgent) result = result.filter((s) => s.agent === filterAgent);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        (s.agent ?? "").toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    }
    return result;
  }, [sessions, filterAgent, search]);

  const hasFilters = filterAgent !== null;
  const paged = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(filtered.length / PER_PAGE);

  return (
    <div>
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {sessions.length} chat sessions across all agents.
        </p>
      </div>

      {/* Filters + Search + Refresh */}
      {sessions.length > 0 && (
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
                      {activeAgents.map((a) => (
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

          {/* Active filter + clear */}
          {hasFilters && (
            <>
              <span className="text-xs text-muted-foreground">
                {filtered.length} of {sessions.length}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => { setFilterAgent(null); setSearch(""); setPage(0); }}
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

      {/* List */}
      {filtered.length > 0 ? (
        <div data-testid="sessions-list" className="mt-4 border border-border overflow-hidden">
          {paged.map((session) => (
            <Link
              key={session.id}
              href={`/projects/${id}/sessions/${session.id}`}
              className="flex items-center border-b border-border last:border-0 hover:bg-secondary/30 transition-colors group"
            >
              <div className="flex-1 px-4 py-3 min-w-0">
                <p className="text-sm font-medium truncate">
                  {session.title || "Untitled session"}
                </p>
                <div className="mt-0.5 flex items-center gap-2">
                  {session.agent && (
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                      {session.agent}
                    </span>
                  )}
                  <span className="font-mono text-[10px] text-muted-foreground/50">
                    {session.id}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4 px-4 py-3 text-xs text-muted-foreground font-mono shrink-0">
                <span>{session.messageCount} msgs</span>
                <span className="text-muted-foreground/40">{timeAgo(session.updatedAt)}</span>
              </div>
              <div className="px-3">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
              </div>
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
      ) : (
        <div data-testid="sessions-empty" className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          {search || hasFilters ? "No sessions matching your filters." : "No sessions yet. Start a conversation via the completions API."}
        </div>
      )}
    </div>
  );
}
