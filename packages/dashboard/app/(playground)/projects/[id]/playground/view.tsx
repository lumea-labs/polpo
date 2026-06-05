"use client";

/**
 * Playground — chat surface backed by `@lumea-labs/chat` +
 * `@lumea-labs/chat-polpo`. The chat composition itself lives in the
 * shared `<PolpoChat>` (components/dashboard/polpo-chat.tsx) so the
 * Playground and the Agent Builder are guaranteed identical.
 *
 * This view owns only the surrounding chrome: the top bar (agent
 * selector + Files button) and the no-agents empty state.
 */

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import type { AgentConfig } from "@polpo-ai/core";
import { ArrowLeft, FolderOpen, Plus } from "lucide-react";
import { AgentModelSelector } from "#/components/dashboard/agent-model-selector";
import { PolpoChat } from "#/components/dashboard/polpo-chat";

interface Props {
  projectId: string;
  apiUrl: string;
  projectName: string;
  initialAgents: AgentConfig[];
  /** Agent to preselect (from ?agent=). Falls back to the first agent. */
  initialAgent?: string;
}

export default function PlaygroundView({
  projectId,
  apiUrl,
  projectName,
  initialAgents,
  initialAgent,
}: Props) {
  const baseUrl = `${apiUrl}/v1/projects/${projectId}/data`;

  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(
    (initialAgent && initialAgents.some((a) => a.name === initialAgent)
      ? initialAgent
      : undefined) ?? initialAgents[0]?.name,
  );
  const [filesOpen, setFilesOpen] = useState(false);

  return (
    <>
      <TopBar
        projectId={projectId}
        projectName={projectName}
        agents={initialAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={setSelectedAgent}
        onOpenFiles={() => setFilesOpen(true)}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        {initialAgents.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4 py-8">
            <EmptyState projectId={projectId} />
          </div>
        ) : (
          <PolpoChat
            baseUrl={baseUrl}
            agent={selectedAgent}
            filesOpen={filesOpen}
            onFilesOpenChange={setFilesOpen}
          />
        )}
      </main>
    </>
  );
}

function TopBar({
  projectId,
  projectName,
  agents,
  selectedAgent,
  onSelectAgent,
  onOpenFiles,
}: {
  projectId: string;
  projectName: string;
  agents: AgentConfig[];
  selectedAgent: string | undefined;
  onSelectAgent: (name: string) => void;
  onOpenFiles: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-3 min-w-0">
        <Link
          href={`/projects/${projectId}`}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>

        <div className="hidden md:block h-5 w-px bg-border" />

        <div className="hidden md:flex items-center gap-2 min-w-0">
          <Image
            src="/polpo-logo.svg"
            alt="Polpo"
            width={72}
            height={16}
            priority
            className="h-4 w-auto opacity-70"
          />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Playground
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className="truncate text-sm font-medium text-foreground/80 font-mono">
            {projectName}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenFiles}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          aria-label="Open files"
          title="Open files"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Files</span>
        </button>

        {agents.length > 0 && (
          <AgentModelSelector
            agents={agents}
            selected={selectedAgent}
            onSelect={onSelectAgent}
          />
        )}
      </div>
    </header>
  );
}

function EmptyState({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-border p-12 text-center max-w-md">
      <div className="flex h-10 w-10 items-center justify-center border border-border">
        <Plus className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">No agents yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Create an agent from the dashboard, or deploy one from your CLI with{" "}
          <span className="font-mono">polpo deploy</span>.
        </p>
      </div>
      <Link
        href={`/projects/${projectId}/agents`}
        className="mt-2 bg-foreground text-background px-3 py-1.5 text-xs font-medium transition-all hover:bg-brand hover:text-brand-foreground"
      >
        Go to Agents
      </Link>
    </div>
  );
}
