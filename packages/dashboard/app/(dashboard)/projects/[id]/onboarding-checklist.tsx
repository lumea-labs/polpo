"use client";

import { useEffect, useState } from "react";
import { Check, Copy, MessageSquare, BookMarked, Brain, ListChecks, Rocket } from "lucide-react";
import { CopyCard } from "../../../../components/dashboard/copy-card";
import { SdkSnippetPanel } from "../../../../components/dashboard/sdk-snippet-panel";
import { TabToggle } from "../../../../components/dashboard/tab-toggle";

export interface ChecklistStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  icon: React.ReactNode;
  detail?: React.ReactNode;
}

interface Props {
  steps: ChecklistStep[];
  projectId: string;
}

// Per-project localStorage key — skip is scoped to this project so a
// fresh project still shows the checklist for first-time setup.
const skipKey = (projectId: string) => `polpo:next-steps-skipped:${projectId}`;

function PromptBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Ask your coding agent</p>
      <div className="flex flex-col gap-2 border border-border bg-background p-3">
        <span className="inline-flex h-5 w-fit items-center rounded bg-secondary px-2 text-[11px] font-medium text-muted-foreground">
          prompt
        </span>
        <p className="text-sm text-foreground leading-relaxed">{value}</p>
      </div>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-brand" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy prompt"}
      </button>
    </div>
  );
}

function SkillStepDetail({ endpoint, agent }: { endpoint: string; agent: string }) {
  const [tab, setTab] = useState<"github" | "create">("github");

  const prompts = {
    github: `Use Polpo skills and install the "frontend-design" skill from anthropics/skills on GitHub for my agent "${agent}". Assign it in agents.json and deploy.`,
    create: `Use Polpo skills and create a custom skill for my agent "${agent}" about REST API best practices: proper HTTP status codes, pagination patterns, error response format, and versioning conventions. Save it in .polpo/skills/, assign it, and deploy.`,
  };

  return (
    <div className="space-y-4">
      <TabToggle
        value={tab}
        onChange={setTab}
        options={[
          { value: "github", label: "From GitHub" },
          { value: "create", label: "Custom skill" },
        ]}
      />

      <PromptBlock value={prompts[tab]} />

      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Or via API</p>

        {tab === "github" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Install from any GitHub repository. Compatible with the{" "}
              <a href="https://skills.sh" target="_blank" rel="noopener noreferrer" className="text-foreground hover:underline underline-offset-4">skills.sh</a>{" "}
              format.
            </p>
            <CopyCard
              label="curl"
              lang="curl"
              value={`curl -X POST ${endpoint}/v1/skills/add \\\n  -H "Authorization: Bearer $POLPO_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"source": "anthropics/skills", "skillNames": ["frontend-design"]}'`}
            />
            <a
              href="https://skills.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline underline-offset-4"
            >
              Browse skills on skills.sh →
            </a>
          </div>
        )}

        {tab === "create" && (
          <div className="space-y-3">
            <CopyCard
              label=".polpo/skills/my-skill/SKILL.md"
              value={`---\nname: my-skill\ndescription: Domain knowledge for my project\n---\n\n# My Skill\n\nAdd your domain knowledge, conventions, and instructions here.`}
            />
            <CopyCard label="agents.json" value={`"skills": ["my-skill"]`} />
          </div>
        )}
      </div>
    </div>
  );
}

export function deriveChecklistSteps({
  hasSession,
  hasSkill,
  hasMemory,
  hasTask,
  hasDeployed,
  projectSlug,
  projectId,
  apiUrl,
  agentName,
  agentNames,
  agentConfigs,
}: {
  hasSession: boolean;
  hasSkill: boolean;
  hasMemory: boolean;
  hasTask: boolean;
  hasDeployed: boolean;
  projectSlug?: string;
  projectId?: string;
  apiUrl?: string;
  agentName?: string;
  agentNames?: string[] | null;
  agentConfigs?: import("@polpo-ai/core").AgentConfig[];
}): ChecklistStep[] {
  const endpoint = projectSlug
    ? `https://${projectSlug}.polpo.cloud`
    : "https://{slug}.polpo.cloud";
  const agent = agentName ?? "assistant";

  return [
    {
      id: "chat",
      title: "Chat with your agent",
      description: "Send your first message",
      completed: hasSession,
      icon: <MessageSquare className="h-4 w-4" />,
      detail: (
        <SdkSnippetPanel
          baseUrl={endpoint}
          agents={agentNames ?? null}
          agentConfigs={agentConfigs}
          defaultAgent={agent}
          projectId={projectId}
          apiUrl={apiUrl}
        />
      ),
    },
    {
      id: "skill",
      title: "Add skill to your agent",
      description: "Teach your agent domain knowledge",
      completed: hasSkill,
      icon: <BookMarked className="h-4 w-4" />,
      detail: <SkillStepDetail endpoint={endpoint} agent={agent} />,
    },
    {
      id: "memory",
      title: "Set agent memory",
      description: "Persistent context across sessions",
      completed: hasMemory,
      icon: <Brain className="h-4 w-4" />,
      detail: (
        <div className="space-y-4">
          <PromptBlock value={`Save a memory for my agent "${agent}": remember that I prefer concise code examples and that my stack is Next.js + TypeScript. Then ask the agent what it remembers about me.`} />
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Or via API</p>
            <CopyCard
              label="curl"
              lang="curl"
              value={`curl -X PUT ${endpoint}/v1/memory/agent/${encodeURIComponent(agent)} \\\n  -H "Authorization: Bearer $POLPO_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"content": "I prefer concise code examples. My stack is Next.js + TypeScript."}'`}
            />
          </div>
        </div>
      ),
    },
    {
      id: "task",
      title: "Create a task",
      description: "Assign autonomous work to an agent",
      completed: hasTask,
      icon: <ListChecks className="h-4 w-4" />,
      detail: (
        <div className="space-y-4">
          <PromptBlock value={`Use Polpo skills and create a task for my agent "${agent}" to write a hello.txt file with a greeting message. The agent should complete this autonomously.`} />
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Or via API</p>
            <CopyCard
              label="curl"
              lang="curl"
              value={`curl -X POST ${endpoint}/v1/tasks \\\n  -H "Authorization: Bearer $POLPO_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "title": "Create hello.txt",\n    "description": "Write a hello.txt file with a greeting message",\n    "assignTo": "${agent}"\n  }'`}
            />
          </div>
        </div>
      ),
    },
    {
      id: "deploy",
      title: "Deploy from your codebase",
      description: "Push local config to cloud",
      completed: hasDeployed,
      icon: <Rocket className="h-4 w-4" />,
      detail: (
        <div className="space-y-4">
          <PromptBlock value={`Use Polpo skills and deploy my project to the cloud. Run polpo deploy from the terminal.`} />
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Or via CLI</p>
            <CopyCard label="terminal" value="polpo deploy" />
            <p className="text-[11px] text-muted-foreground/60">
              Syncs agents, teams, skills, memory, missions, and playbooks.
            </p>
          </div>
        </div>
      ),
    },
  ];
}

/** Detect deploy: any agent with updatedAt different from createdAt means a PUT happened (deploy pushes updates) */
export function hasDeployedCheck(agents: Array<{ createdAt?: string; updatedAt?: string }>): boolean {
  for (const agent of agents) {
    if (agent.updatedAt && agent.createdAt && agent.updatedAt !== agent.createdAt) return true;
  }
  return false;
}


export default function OnboardingChecklist({ steps, projectId }: Props) {
  const firstIncomplete = steps.find((s) => !s.completed);
  const [selectedId, setSelectedId] = useState<string>(firstIncomplete?.id ?? steps[0]?.id ?? "");
  const [dismissed, setDismissed] = useState(false);

  // Honour the persistent skip on mount. Render null while the
  // effect resolves to avoid a flash before the localStorage check.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && localStorage.getItem(skipKey(projectId))) {
      setDismissed(true);
    }
    setHydrated(true);
  }, [projectId]);

  function handleSkipForever() {
    if (typeof window !== "undefined") {
      localStorage.setItem(skipKey(projectId), "1");
    }
    setDismissed(true);
  }

  const completedCount = steps.filter((s) => s.completed).length;
  const selected = steps.find((s) => s.id === selectedId);

  if (!hydrated || dismissed) return null;

  return (
    <div className="border border-border bg-card">
      {/* Banner header — inside the card, same feel as Get Started */}
      <div className="flex items-center justify-between p-6 pb-4">
        <div>
          <h2 className="text-2xl tracking-tight text-foreground">Next Steps</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Complete these steps to get the most out of Polpo.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-muted-foreground">
            {completedCount}/{steps.length}
          </span>
          <div className="w-20 h-1 bg-secondary overflow-hidden">
            <div
              className="h-full bg-brand transition-all duration-500"
              style={{ width: `${(completedCount / steps.length) * 100}%` }}
            />
          </div>
          <button
            type="button"
            onClick={handleSkipForever}
            data-testid="next-steps-skip-forever"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip
          </button>
        </div>
      </div>

      {/* Two-column: steps left, detail right */}
      <div className="flex">
        {/* Left: step list */}
        <div className="w-[280px] shrink-0">
          {steps.map((step) => {
            const isSelected = step.id === selectedId;
            return (
              <button
                key={step.id}
                onClick={() => setSelectedId(step.id)}
                className={`w-full flex items-center gap-3 px-6 py-4 text-left border-b border-border last:border-0 transition-colors ${
                  isSelected
                    ? "bg-secondary/50"
                    : "hover:bg-secondary/20"
                } ${step.completed ? "opacity-50" : ""}`}
              >
                <div className="flex-shrink-0">
                  {step.completed ? (
                    <div className="flex h-5 w-5 items-center justify-center bg-brand/15">
                      <Check className="h-3 w-3 text-brand" />
                    </div>
                  ) : (
                    <div className={`h-2 w-2 rounded-full ${
                      isSelected ? "bg-foreground" : "bg-muted-foreground/30"
                    }`} />
                  )}
                </div>
                <div className="min-w-0">
                  <p className={`text-sm ${
                    step.completed
                      ? "text-muted-foreground line-through"
                      : isSelected
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                  }`}>
                    {step.title}
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                    {step.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>

        {/* Right: detail panel — always shares bg with selected step for continuity */}
        <div className={`flex-1 p-6 transition-colors ${
          selected ? "bg-secondary/50" : ""
        }`}>
          {selected?.detail ?? (
            <p className="text-sm text-muted-foreground">
              Select a step to see instructions.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
