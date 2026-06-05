"use client";

/**
 * Agent Studio — the agent detail surface, rendered as a chat canvas:
 * left = the full agent editor (Models / Prompt / Tools / Skills /
 * Memory / Vault, client-switched tabs), right = the Meta Agent builder
 * chat that opens/closes (collapses by width → stays mounted, no reset).
 *
 * This IS the agent detail page (`/projects/[id]/agents/[name]`). Builder
 * closed = plain detail; "Edit" reveals the chat alongside.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bot,
  Cpu,
  BookMarked,
  Wrench,
  FileText,
  Brain,
  Lock,
  Users,
  MessageSquare,
  MessagesSquare,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import type { AgentConfig } from "@polpo-ai/core";
import { BuilderChat } from "../../components/dashboard/builder-chat";
import { AgentIdentityHeader } from "../../components/dashboard/agent-identity-header";
import { Breadcrumb } from "../../components/dashboard/breadcrumb";
import { useCopilot } from "../../components/dashboard/project-copilot";
import AgentModelsView from "../../app/(dashboard)/projects/[id]/agents/[name]/models-view";
import AgentSkillsView from "../../app/(dashboard)/projects/[id]/agents/[name]/skills/view";
import AgentToolsView from "../../app/(dashboard)/projects/[id]/agents/[name]/tools/view";
import AgentPromptView from "../../app/(dashboard)/projects/[id]/agents/[name]/prompt/view";
import AgentMemoryView from "../../app/(dashboard)/projects/[id]/agents/[name]/memory/view";
import AgentVaultView from "../../app/(dashboard)/projects/[id]/agents/[name]/vault/view";

export interface VaultEntry {
  service: string;
  type: string;
  label: string | null;
}

type StudioTab = "models" | "prompt" | "tools" | "skills" | "memory" | "vault";

const TABS: { key: StudioTab; label: string; icon: LucideIcon }[] = [
  { key: "models", label: "Models", icon: Cpu },
  { key: "prompt", label: "Instructions", icon: FileText },
  { key: "tools", label: "Tools", icon: Wrench },
  { key: "skills", label: "Skills", icon: BookMarked },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "vault", label: "Vault", icon: Lock },
];

export function AgentStudio({
  projectId,
  apiUrl,
  agent,
  memoryContent,
  vaultEntries,
}: {
  projectId: string;
  apiUrl: string;
  agent: AgentConfig | null;
  memoryContent: string;
  vaultEntries: VaultEntry[];
}) {
  const router = useRouter();
  const copilot = useCopilot();
  // Soft-disabled: the in-Studio docked builder stays in the tree but never
  // opens — "Edit" now opens the global lateral Copilot (Ask Polpo) instead.
  const chatOpen = false;

  if (!agent) {
    return (
      <div className="border border-border p-10 text-center">
        <Bot className="mx-auto h-5 w-5 text-muted-foreground/40" strokeWidth={1.5} />
        <p className="mt-2 text-sm text-muted-foreground">Agent not found.</p>
        <Link
          href={`/projects/${projectId}/agents`}
          className="mt-3 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Back to agents
        </Link>
      </div>
    );
  }

  return (
    // Fills the viewport (no page scroll); only inner panes scroll.
    <div className="flex h-[calc(100vh-7rem)] min-h-[520px] flex-col overflow-hidden">
      {/* Top bar — breadcrumb + actions. Fixed (does not scroll). */}
      <div className="flex shrink-0 items-center gap-2 pb-3">
        <Breadcrumb
          items={[
            { label: "Agents", href: `/projects/${projectId}/agents`, icon: Users },
            { label: agent.name },
          ]}
        />

        <div className="ml-auto flex items-center gap-2">
          {/* Test = chat with the live agent in the playground (new tab). */}
          <Link
            href={`/projects/${projectId}/playground?agent=${encodeURIComponent(agent.name)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Test
            <ExternalLink className="h-3 w-3 text-muted-foreground/60" />
          </Link>
          {/* Edit = open the global lateral Copilot (Polpo AI), scoped to
              this agent via the route context. Hidden once it's open. */}
          {!copilot?.open && (
            <button
              type="button"
              onClick={() => copilot?.setOpen(true)}
              className="inline-flex items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Split — content LEFT, builder chat RIGHT. The chat collapses by
          WIDTH (stays mounted → no reset). A full-height vertical
          separator divides the panes when the builder is open. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          <FullAgentEditor
            agent={agent}
            projectId={projectId}
            memoryContent={memoryContent}
            vaultEntries={vaultEntries}
          />
        </div>
        <div
          className={`shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
            chatOpen ? "w-[36%] border-l border-border" : "w-0"
          }`}
        >
          <div className="flex h-full w-full min-w-[320px] flex-col overflow-hidden">
            <BuilderChat
              projectId={projectId}
              apiUrl={apiUrl}
              agentName={agent.name}
              onMutation={() => router.refresh()}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function FullAgentEditor({
  agent,
  projectId,
  memoryContent,
  vaultEntries,
}: {
  agent: AgentConfig;
  projectId: string;
  memoryContent: string;
  vaultEntries: VaultEntry[];
}) {
  // Tab is URL-driven (?tab=) so the Meta Agent's `navigate` tool can point
  // straight at a component, and the tab is deep-linkable.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab") as StudioTab | null;
  const validUrlTab = urlTab && TABS.some((t) => t.key === urlTab) ? urlTab : null;
  const [tab, setTab] = useState<StudioTab>(validUrlTab ?? "models");

  // React to external URL changes (e.g. the copilot navigating here).
  useEffect(() => {
    if (validUrlTab && validUrlTab !== tab) setTab(validUrlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUrlTab]);

  function selectTab(key: StudioTab) {
    setTab(key);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", key);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Sticky: identity + tab nav (don't scroll) */}
      <div className="shrink-0 pt-1 pr-4">
        <AgentIdentityHeader name={agent.name} role={agent.role} />
        <div className="mt-4 flex flex-wrap gap-1 border-b border-border">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => selectTab(t.key)}
                className={`relative flex items-center gap-1.5 px-3 py-2 text-sm transition-colors ${
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                {t.label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Only the tab content scrolls */}
      <div className="min-h-0 flex-1 overflow-auto py-4 pr-4">
        {tab === "models" && (
          <AgentModelsView agent={agent} projectId={projectId} agentName={agent.name} />
        )}
        {tab === "skills" && <AgentSkillsView agent={agent} projectId={projectId} />}
        {tab === "tools" && <AgentToolsView agent={agent} projectId={projectId} />}
        {tab === "prompt" && (
          <AgentPromptView agent={agent} projectId={projectId} agentName={agent.name} />
        )}
        {tab === "memory" && <AgentMemoryView id={projectId} content={memoryContent} />}
        {tab === "vault" && <AgentVaultView entries={vaultEntries} />}
      </div>
    </div>
  );
}
