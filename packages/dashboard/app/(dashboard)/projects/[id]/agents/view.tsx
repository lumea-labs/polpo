"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
// SDK-bundled types — consistent with what `polpo.X()` returns.
import type { AgentConfig } from "@polpo-ai/sdk";
import { RefreshCw, ChevronRight, Users, User, Search, Plus, Loader2 } from "lucide-react";
import { usePolpoClient } from "#/lib/polpo-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";

export interface Team {
  name: string;
  description?: string;
  createdAt?: string;
}

export default function AgentsView({
  initialAgents,
  initialTeams,
}: {
  initialAgents: AgentConfig[];
  initialTeams: Team[];
}) {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<"agents" | "teams">("agents");
  const [search, setSearch] = useState("");

  const polpo = usePolpoClient(id);
  const { data: agents = [], isFetching: fa, refetch: ra } = useQuery({
    queryKey: ["agents", id],
    queryFn: () => polpo.getAgents(),
    initialData: initialAgents,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["teams", id],
    queryFn: () => polpo.getTeams() as unknown as Promise<Team[]>,
    initialData: initialTeams,
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {agents.length} agents across {teams.length} teams.
          </p>
        </div>
        <NewAgentButton projectId={id} />
      </div>

      {/* Search + Tabs + Refresh */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-48 border border-border bg-transparent pl-9 pr-3 py-1.5 text-xs placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
          <button
            onClick={() => setTab("agents")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === "agents" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <User className="h-3.5 w-3.5" />
            Agents ({agents.length})
          </button>
          <button
            onClick={() => setTab("teams")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === "teams" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            Teams ({teams.length})
          </button>
        </div>

        <button
          onClick={() => ra()}
          disabled={fa}
          className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${fa ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {tab === "agents" ? (() => {
        const q = search.toLowerCase();
        const filteredAgents = q
          ? agents.filter((a) => a.name.toLowerCase().includes(q) || (a.role ?? "").toLowerCase().includes(q) || (a as any).teamName?.toLowerCase().includes(q))
          : agents;
        return filteredAgents.length > 0 ? (
          <div className="mt-4 border border-border overflow-hidden overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Agent</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Team</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Model</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Tools</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {filteredAgents.map(agent => (
                  <Link
                    key={agent.name}
                    href={`/projects/${id}/agents/${encodeURIComponent(agent.name)}`}
                    className="table-row border-b border-border last:border-0 hover:bg-secondary/30 transition-colors group"
                  >
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs font-semibold">{agent.name}</span>
                      {agent.role && (
                        <span className="block mt-0.5 text-[11px] text-muted-foreground/60 truncate max-w-[200px]">{agent.role}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(agent as any).teamName ? (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                          {(agent as any).teamName}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground/30">&mdash;</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{agent.model ?? "\u2014"}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {agent.allowedTools?.length ?? 0}
                    </td>
                    <td className="px-2 py-3">
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
                    </td>
                  </Link>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
            {search ? "No agents matching your search." : "No agents deployed. Use polpo deploy to deploy agents."}
          </div>
        );
      })() : (
        teams.length > 0 ? (
          <div className="mt-4 border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/50">
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Team</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Description</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-20">Agents</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-28">Created</th>
                </tr>
              </thead>
              <tbody>
                {teams.map(team => {
                  const teamAgents = agents.filter(a => (a as any).teamName === team.name);
                  return (
                    <tr key={team.name} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-mono text-xs font-semibold">{team.name}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{team.description ?? "\u2014"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{teamAgents.length}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {team.createdAt
                          ? new Date(team.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                          : "\u2014"
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
            No teams configured.
          </div>
        )
      )}
    </div>
  );
}

/**
 * New agent — asks for a name, creates the agent via the SDK (dogfood),
 * then drops the user straight into the Agent Builder to configure it.
 */
function NewAgentButton({ projectId }: { projectId: string }) {
  const polpo = usePolpoClient(projectId);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await polpo.addAgent({ name: trimmed });
      // Hand off to the agent detail (Studio) to configure the fresh agent.
      router.push(
        `/projects/${projectId}/agents/${encodeURIComponent(trimmed)}`,
      );
    } catch (err) {
      setError((err as Error).message ?? "Failed to create agent");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex shrink-0 items-center gap-1.5 border border-foreground bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90">
        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        New agent
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Give it a name — you&apos;ll configure the rest in the builder.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
            placeholder="agent-name"
            className="border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-foreground/40"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <button
            type="button"
            onClick={() => void create()}
            disabled={saving || !name.trim()}
            className="inline-flex items-center justify-center gap-1.5 border border-foreground bg-foreground px-3 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create &amp; edit
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
