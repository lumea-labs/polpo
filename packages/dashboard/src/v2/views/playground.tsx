"use client";

/**
 * Playground v2 — a from-scratch agent debug surface (additive; the legacy
 * `/playground` route is untouched). Chat in the middle (shared `<PolpoChat>`)
 * with a new-chat landing (agent picker + loop modality switcher) shown while
 * empty, and a collapsible, resizable canvas on the right (Trace + Drive),
 * toggled from a small button in the top bar.
 */

import { useMemo, useState } from "react";
import {
  ChatCircle,
  SidebarSimple,
  WarningCircle,
  Plus,
} from "@phosphor-icons/react";
import {
  PlaygroundHostProvider,
  usePlaygroundHost,
  type PlaygroundAgent,
  type PlaygroundHostAdapter,
} from "../playground/host.js";
import { ChatCanvas, type CanvasTabId } from "../playground/chat-canvas.js";

const DEFAULT_LOOP_VALUE = "__polpo_default_loop__";

type AgentWithLoops = PlaygroundAgent;

interface Props {
  projectId: string;
  projectName: string;
  initialAgents: AgentWithLoops[];
  initialAgent?: string;
  initialLoop?: string;
  host: PlaygroundHostAdapter;
}

export function PlaygroundView({
  projectId,
  projectName,
  initialAgents,
  initialAgent,
  initialLoop,
  host,
}: Props) {
  const baseUrl = host.data.dataPlaneBaseUrl(projectId);
  const { ChatLanding, PolpoChat } = host.components;

  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(
    (initialAgent && initialAgents.some((a) => a.name === initialAgent)
      ? initialAgent
      : undefined) ?? initialAgents[0]?.name,
  );
  const selectedAgentConfig = useMemo(
    () => initialAgents.find((agent) => agent.name === selectedAgent),
    [initialAgents, selectedAgent],
  );
  const assignedLoops = useMemo(
    () => Array.from(new Set(selectedAgentConfig?.assignedLoops ?? [])),
    [selectedAgentConfig],
  );
  const loopOptions = useMemo(
    () => Array.from(new Set(assignedLoops)),
    [assignedLoops],
  );
  const agentRefs = useMemo(
    () => initialAgents.map((a) => ({ name: a.name, role: a.role })),
    [initialAgents],
  );
  const initialLoopValue = initialLoop && assignedLoops.includes(initialLoop) ? initialLoop : undefined;
  const [selectedLoop, setSelectedLoop] = useState<string | undefined>(initialLoopValue);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [canvasTab, setCanvasTab] = useState<CanvasTabId>("trace");
  const [chatKey, setChatKey] = useState(0);
  const activeSelectedLoop = selectedLoop && assignedLoops.includes(selectedLoop) ? selectedLoop : undefined;

  function handleSelectAgent(name: string) {
    if (name === selectedAgent) return;
    setSelectedAgent(name);
    setSelectedLoop(undefined);
  }

  // Start a fresh chat: drop the ?session= and remount the chat surface.
  function newChat() {
    const params = new URLSearchParams(Array.from(host.navigation.searchEntries()));
    if (params.has("session")) {
      params.delete("session");
      const qs = params.toString();
      host.navigation.replace(qs ? `?${qs}` : "?", { scroll: false });
    }
    setSessionId(undefined);
    setChatKey((k) => k + 1);
  }

  const hasAgents = initialAgents.length > 0;

  const landing = hasAgents ? (
    <ChatLanding
      greeting="What should we test?"
      subtitle="Pick an agent and mode, then send a message."
      inputPlaceholder="Send a message to start…"
      header={
        <LandingControls
          agents={agentRefs}
          selectedAgent={selectedAgent}
          onSelectAgent={handleSelectAgent}
        />
      }
    />
  ) : undefined;

  const composerControls =
    loopOptions.length > 0 ? (
      <LoopSelect
        loopOptions={loopOptions}
        selectedLoop={activeSelectedLoop}
        onSelectLoop={setSelectedLoop}
      />
    ) : undefined;

  return (
    <PlaygroundHostProvider host={host}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TopBar
        projectName={projectName}
        agent={selectedAgent}
        model={selectedAgentConfig?.model}
        projectId={projectId}
        missingModel={Boolean(selectedAgentConfig && !selectedAgentConfig.model)}
        onNewChat={newChat}
        canvasOpen={canvasOpen}
        onToggleCanvas={() => setCanvasOpen((v) => !v)}
        canToggle={hasAgents}
      />

      <main className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!hasAgents ? (
            <div className="flex flex-1 items-center justify-center px-4 py-8">
              <EmptyState projectId={projectId} />
            </div>
          ) : (
            <PolpoChat
              key={chatKey}
              baseUrl={baseUrl}
              agent={selectedAgent}
              loop={activeSelectedLoop}
              onSession={setSessionId}
              landing={landing}
              composerControls={composerControls}
              gutter="none"
            />
          )}
        </div>

        {canvasOpen && hasAgents && (
          <ChatCanvas
            projectId={projectId}
            sessionId={sessionId}
            tab={canvasTab}
            onTabChange={setCanvasTab}
            onClose={() => setCanvasOpen(false)}
          />
        )}
      </main>
      </div>
    </PlaygroundHostProvider>
  );
}

export default PlaygroundView;

/* ── Top bar ──────────────────────────────────────────────────────────── */

function TopBar({
  projectName,
  agent,
  model,
  projectId,
  missingModel,
  onNewChat,
  canvasOpen,
  onToggleCanvas,
  canToggle,
}: {
  projectName: string;
  agent: string | undefined;
  model: string | undefined;
  projectId: string;
  missingModel: boolean;
  onNewChat: () => void;
  canvasOpen: boolean;
  onToggleCanvas: () => void;
  canToggle: boolean;
}) {
  const host = usePlaygroundHost();
  const { Link, Image, ProviderIcon } = host.components;
  const [provider, modelName] = model?.includes("/")
    ? [model.split("/")[0], model.split("/").slice(1).join("/")]
    : [undefined, model];

  return (
    <header className="shrink-0 border-b border-border bg-card">
      <div className="flex h-12 items-center gap-2.5 px-4">
        <Link href={host.routes.projects()} aria-label="Polpo" className="flex items-center">
          <Image
            src={host.logoSrc}
            alt="Polpo"
            width={83}
            height={18}
            priority
            className="h-[18px] w-auto invert dark:invert-0"
          />
        </Link>
        <span className="select-none text-muted-foreground/50" aria-hidden>
          /
        </span>
        <span className="text-[13px] font-medium text-foreground">Playground</span>
        <span className="hidden select-none text-muted-foreground/50 sm:inline" aria-hidden>
          /
        </span>
        <span className="hidden max-w-[160px] truncate font-mono text-[12px] text-muted-foreground sm:inline">
          {projectName}
        </span>
        {agent && (
          <>
            <span className="select-none text-muted-foreground/50" aria-hidden>
              /
            </span>
            <span className="max-w-[160px] truncate font-mono text-[12px] font-medium text-foreground">
              {agent}
            </span>
            {modelName && (
              <span
                title={model}
                className="hidden h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 text-[11px] text-muted-foreground md:inline-flex"
              >
                {provider && (
                  <ProviderIcon
                    provider={provider}
                    size={14}
                    type="mono"
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                <span className="min-w-0 truncate font-mono">{modelName}</span>
              </span>
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {canToggle && (
            <button
              type="button"
              onClick={onNewChat}
              title="New chat"
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
            >
              <span className="relative grid h-4 w-4 place-items-center">
                <ChatCircle size={16} />
                <Plus
                  size={8}
                  weight="bold"
                  className="absolute -right-0.5 -top-0.5 rounded-full bg-card text-current"
                />
              </span>
              <span className="hidden sm:inline">New chat</span>
            </button>
          )}
          {canToggle && (
            <button
              type="button"
              onClick={onToggleCanvas}
              aria-pressed={canvasOpen}
              title="Toggle the canvas (Trace + Drive)"
              className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors ${
                canvasOpen
                  ? "bg-brand/10 text-brand"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
              }`}
            >
              <SidebarSimple size={16} weight={canvasOpen ? "fill" : "regular"} />
              <span className="hidden sm:inline">{canvasOpen ? "Close panel" : "Show panel"}</span>
            </button>
          )}
        </div>
      </div>

      {missingModel && agent && (
        <div className="flex min-h-8 items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-1.5 text-destructive">
          <WarningCircle size={14} weight="fill" className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[12px]">
            This agent has no model configured — set one before testing.
          </span>
          <Link
            href={host.routes.agent(projectId, agent)}
            className="shrink-0 text-[12px] font-medium underline underline-offset-2 hover:text-destructive/80"
          >
            Set model
          </Link>
        </div>
      )}
    </header>
  );
}

function LandingControls({
  agents,
  selectedAgent,
  onSelectAgent,
}: {
  agents: { name: string; role?: string }[];
  selectedAgent: string | undefined;
  onSelectAgent: (name: string) => void;
}) {
  const host = usePlaygroundHost();
  const { ChatAgentSelector } = host.components;
  return (
    <div className="mb-7 flex justify-center">
      <ChatAgentSelector
        agents={agents}
        selected={selectedAgent}
        onSelect={onSelectAgent}
        variant="command"
        fallbackLabel="Select an agent"
        renderAvatar={host.showAvatars ? undefined : () => null}
        className="!rounded-md border border-border bg-card !py-2 !text-[13px] !text-foreground shadow-sm hover:!bg-secondary/50"
      />
    </div>
  );
}

/**
 * Loop / mode selector — a compact button showing just the short label; click
 * to open the options. Used identically in the landing and the composer.
 */
function LoopSelect({
  loopOptions,
  selectedLoop,
  onSelectLoop,
}: {
  loopOptions: string[];
  selectedLoop: string | undefined;
  onSelectLoop: (name: string | undefined) => void;
}) {
  const { Select, SelectContent, SelectItem, SelectTrigger } =
    usePlaygroundHost().components;
  if (loopOptions.length === 0) return null;
  const label = selectedLoop ?? "Standard";
  return (
    <Select
      value={selectedLoop ?? DEFAULT_LOOP_VALUE}
      onValueChange={(v) => onSelectLoop(v && v !== DEFAULT_LOOP_VALUE ? v : undefined)}
    >
      <SelectTrigger className="h-7 w-auto gap-1.5 rounded-md border-border px-2 font-mono text-[12px]">
        <span data-slot="select-value" className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-[150px] truncate">{label}</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_LOOP_VALUE}>
          <span className="inline-flex items-center gap-1.5">Standard</span>
        </SelectItem>
        {loopOptions.map((loop) => (
          <SelectItem key={loop} value={loop}>
            {loop}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ── Empty state ──────────────────────────────────────────────────────── */

function EmptyState({ projectId }: { projectId: string }) {
  const host = usePlaygroundHost();
  const { Link } = host.components;
  return (
    <div className="flex max-w-sm flex-col items-center gap-4 rounded-xl border border-dashed border-border bg-card/40 p-10 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-xl border border-border bg-secondary text-muted-foreground">
        <Plus size={20} />
      </span>
      <div>
        <p className="text-sm font-semibold text-foreground">No agents yet</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Create an agent from the dashboard, or deploy one from your CLI with{" "}
          <span className="font-mono text-foreground">polpo deploy</span>.
        </p>
      </div>
      <Link
        href={host.routes.agents(projectId)}
        className="mt-1 inline-flex h-9 items-center rounded-[var(--radius)] bg-brand px-3.5 text-[13px] font-medium text-brand-foreground transition-transform hover:scale-[1.02]"
      >
        Go to Agents
      </Link>
    </div>
  );
}
