import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { AgentConfig } from "@polpo-ai/core";

const headerClass = "py-2.5 text-left text-xs font-medium text-muted-foreground";

export function AgentsTable({ agents, projectId }: { agents: AgentConfig[]; projectId: string }) {
  return (
    <div data-testid="agents-table" className="mt-4 rounded-lg border border-border overflow-hidden overflow-x-auto min-w-[600px]">
      {/* Header — same flex widths as rows */}
      <div className="flex items-center border-b border-border bg-secondary/50">
        <span className={`px-4 flex-1 min-w-[120px] ${headerClass}`}>Agent</span>
        <span className={`px-4 flex-1 ${headerClass}`}>Role</span>
        <span className={`px-4 flex-1 ${headerClass}`}>Model</span>
        <span className={`px-4 w-20 ${headerClass}`}>Tools</span>
        <span className={`px-4 w-24 ${headerClass}`}>Reasoning</span>
        <span className="w-8" />
      </div>
      {/* Rows */}
      {agents.map((agent) => (
        <Link
          key={agent.name}
          href={`/projects/${projectId}/agents/${agent.name}`}
          data-testid={`agent-row-${agent.name}`}
          className="flex items-center border-b border-border last:border-0 hover:bg-secondary/30 transition-colors group"
        >
          <span className="px-4 py-3 flex-1 min-w-[120px]">
            <span className="font-mono text-xs font-medium">{agent.name}</span>
            {agent.identity?.title && (
              <span className="block mt-0.5 text-[11px] text-muted-foreground/50">{agent.identity.title}</span>
            )}
          </span>
          <span className="px-4 py-3 flex-1 text-sm text-muted-foreground">{agent.role ?? "—"}</span>
          <span className="px-4 py-3 flex-1 font-mono text-xs text-muted-foreground">{agent.model ?? "—"}</span>
          <span className="px-4 py-3 w-20 text-xs text-muted-foreground">
            {agent.allowedTools ? agent.allowedTools.length : 0} tools
          </span>
          <span className="px-4 py-3 w-24 text-xs text-muted-foreground">
            {agent.reasoning ?? "off"}
          </span>
          <span className="px-2 py-3 w-8">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
          </span>
        </Link>
      ))}
    </div>
  );
}
