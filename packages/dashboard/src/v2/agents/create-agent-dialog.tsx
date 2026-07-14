"use client";

/**
 * Create-agent surface — the single entry point into agent creation.
 *
 * `CreateAgentContent` is the shared body (Describe / Template starting point +
 * an editable/pasteable YAML config). It's wired two ways:
 *   • `CreateAgentDialog` — the "New agent" button; hands off to the side
 *     builder (Generate / Create-from-config → openChat).
 *   • the onboarding — reuses the same body, wiring the actions to its own flow.
 * Picking a template seeds both the describe composer and the config editor.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "../host";
import {
  Sparkle,
  MagnifyingGlass,
  Headset,
  ChartBar,
  Siren,
  FileText,
  ArrowsClockwise,
  Code,
  Handshake,
  Recycle,
  CircleNotch,
  CheckCircle,
  ArrowSquareOut,
} from "@phosphor-icons/react/dist/ssr";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { announceNavigationStart } from "../host";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { CodeEditor } from "../ui/code-editor";
import { useDashboardApi } from "../../host";
import { AGENT_TEMPLATES, type AgentTemplate } from "../host";
import { useCopilot } from "../host";

/** Per-template glyph — a small visual anchor for each starter card. */
export const TEMPLATE_ICON: Record<
  string,
  React.ComponentType<{ size?: number; weight?: "duotone"; className?: string }>
> = {
  blank: Sparkle,
  "deep-researcher": MagnifyingGlass,
  "support-agent": Headset,
  "data-analyst": ChartBar,
  "incident-commander": Siren,
  "contract-tracker": FileText,
  "sprint-retro": ArrowsClockwise,
  "coding-agent": Code,
  "onboarding-buddy": Handshake,
  "content-repurposer": Recycle,
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "agent"
  );
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

/**
 * Realistic per-template config seed — real tool names (see lib/tool-catalog)
 * and a concise, deployable system prompt. `skills: []` on purpose: the builder
 * installs/authors the right skills at generation time. These are the editor's
 * starting point, not throwaways — they're what a good agent actually looks like.
 */
export const TEMPLATE_SEED: Record<
  string,
  { tools: string[]; systemPrompt: string }
> = {
  blank: {
    tools: ["read", "write", "edit", "bash", "glob", "grep"],
    systemPrompt:
      "You are a helpful agent. Describe its role, the rules it must follow, and any domain knowledge here.",
  },
  "deep-researcher": {
    tools: ["search_web", "search_find_similar", "http_fetch", "read", "write"],
    systemPrompt:
      "Scope the question, gather high-quality primary sources, track what each source supports, and write a concise, cited brief with clear caveats.",
  },
  "support-agent": {
    tools: ["read", "write", "email_send", "email_draft", "http_fetch"],
    systemPrompt:
      "Triage requests by type and urgency, draft clear, empathetic replies without inventing account state, and escalate billing, security, legal, or production issues.",
  },
  "data-analyst": {
    tools: ["read", "write", "edit", "bash", "glob", "grep"],
    systemPrompt:
      "Understand the dataset or schema, write and run SQL/analysis to answer questions, sanity-check results, and explain findings in plain language with the key numbers called out.",
  },
  "incident-commander": {
    tools: ["read", "write", "http_fetch", "bash"],
    systemPrompt:
      "Assess severity and impact, keep a running timeline, decide next actions, draft stakeholder status updates, and produce a blameless postmortem.",
  },
  "contract-tracker": {
    tools: ["read", "write", "http_fetch"],
    systemPrompt:
      "Read contracts, extract key terms (parties, value, dates, auto-renewal, termination, liability), flag risky clauses and upcoming renewals, and keep a structured summary per agreement.",
  },
  "sprint-retro": {
    tools: ["read", "write", "http_fetch"],
    systemPrompt:
      "Gather sprint signals, organize them into what went well / what didn't / what to try, prompt the team where context is missing, and produce a short retro with owned action items.",
  },
  "coding-agent": {
    tools: ["read", "write", "edit", "bash", "glob", "grep", "ls"],
    systemPrompt:
      "Take a scoped request, inspect the codebase, make a small plan, implement only the necessary changes while preserving conventions, run the build/tests to verify, and summarize what changed.",
  },
  "onboarding-buddy": {
    tools: ["read", "write", "http_fetch", "search_web"],
    systemPrompt:
      "Answer setup and process questions from internal docs, walk new hires through their first-week checklist, remember where each person is, and escalate to a human when unsure.",
  },
  "content-repurposer": {
    tools: ["read", "write", "http_fetch", "search_web"],
    systemPrompt:
      "Extract the key ideas from a long-form piece and produce channel-tailored variants — an X thread, a LinkedIn post, a newsletter blurb — matching each channel's tone and length.",
  },
};

/**
 * Seed config for the editor — the REAL agent config shape (JSON), matching
 * how the data plane stores it (name · role · model · allowedTools · skills ·
 * systemPrompt). Blank starts corposo-but-minimal; a template fills real tools
 * and a real system prompt so it's deployable as-is.
 */
export function configJson(template: AgentTemplate | null): string {
  const isTemplate = Boolean(template && template.id !== "blank");
  const seed = TEMPLATE_SEED[template?.id ?? "blank"] ?? TEMPLATE_SEED.blank;
  const cfg = {
    name: isTemplate ? slugify(template!.name) : "untitled-agent",
    role: isTemplate
      ? template!.description
      : "One-line description of what this agent does.",
    model: DEFAULT_MODEL,
    allowedTools: seed.tools,
    skills: [] as string[],
    systemPrompt: seed.systemPrompt,
  };
  return JSON.stringify(cfg, null, 2);
}

/**
 * Shared agent-creation body. `onGenerate(prompt)` fires from the Describe
 * composer; `onCreateFromConfig(config)` from the config editor. Change
 * `resetSignal` to reset the form (e.g. when a dialog re-opens).
 */
export function CreateAgentContent({
  projectId,
  resetSignal,
  onGenerate,
  onCreateFromConfig,
  onClose,
}: {
  /** When set, Generate / Create build the agent for real via the one-shot
   *  builder endpoint and load the result into the editor. When omitted
   *  (onboarding), the legacy callbacks fire instead. */
  projectId?: string;
  resetSignal?: unknown;
  onGenerate?: (prompt: string) => void;
  onCreateFromConfig?: (config: string) => void;
  /** Close the surrounding dialog — used by "Open agent". */
  onClose?: () => void;
}) {
  const api = useDashboardApi();
  const router = useRouter();
  const [tab, setTab] = useState<"describe" | "template">("describe");
  const [text, setText] = useState("");
  const [config, setConfig] = useState(() => configJson(null));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [builtAgentName, setBuiltAgentName] = useState<string | null>(null);

  useEffect(() => {
    setTab("describe");
    setText("");
    setConfig(configJson(null));
    setSelectedId(null);
    setBuilding(false);
    setBuildError(null);
    setBuiltAgentName(null);
  }, [resetSignal]);

  const selectedTemplate = useMemo(
    () => AGENT_TEMPLATES.find((t) => t.id === selectedId) ?? null,
    [selectedId],
  );

  const pickTemplate = (template: AgentTemplate) => {
    setSelectedId(template.id);
    setText(template.prompt);
    setConfig(configJson(template)); // seeds the always-open config below
  };

  const trimmed = text.trim();
  const configTrimmed = config.trim();
  const agentName =
    builtAgentName ??
    (selectedTemplate && selectedTemplate.id !== "blank"
      ? slugify(selectedTemplate.name)
      : "untitled-agent");

  // One-shot build on the shared builder runtime: creates the agent (plus any
  // skills/tools/loops it needs) for real, then loads its real config back into
  // the editor. Editing after a build and re-running applies the changes.
  const runBuild = async (description: string) => {
    if (!description.trim() || building || !projectId) return;
    setBuilding(true);
    setBuildError(null);
    try {
      const res = await api.mutateControlPlane<{
        ok: boolean;
        agentName: string;
        config: unknown;
      }>("/v1/builder/build-agent", {
        method: "POST",
        body: { projectId, description },
      });
      if (res.config) setConfig(JSON.stringify(res.config, null, 2));
      setBuiltAgentName(res.agentName);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : "Build failed. Try again.");
    } finally {
      setBuilding(false);
    }
  };

  const handleGenerate = () => {
    // Hand off to the side builder when a callback is wired (New agent → opens
    // the builder and sends the message, like edit); otherwise build inline.
    if (onGenerate) {
      if (trimmed) onGenerate(trimmed);
      return;
    }
    if (projectId) void runBuild(trimmed);
  };

  const handleConfigAction = () => {
    if (onCreateFromConfig) {
      if (configTrimmed) onCreateFromConfig(config);
      return;
    }
    if (!projectId) return;
    void runBuild(
      builtAgentName
        ? `Update the agent "${builtAgentName}" in this project to exactly match this configuration:\n\n\`\`\`json\n${config}\n\`\`\``
        : `Create an agent with exactly this configuration:\n\n\`\`\`json\n${config}\n\`\`\`\nUse these values as-is; only fill in obviously-missing required fields.`,
    );
  };

  const openAgent = () => {
    if (!projectId || !builtAgentName) return;
    onClose?.();
    const href = `/projects/${projectId}/agents/${encodeURIComponent(builtAgentName)}`;
    announceNavigationStart(builtAgentName, href);
    router.push(href);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Starting point — segmented control (v2 idiom), not page-level tabs */}
      <div>
        <div className="mb-2 text-[12px] font-medium text-muted-foreground">
          Starting point
        </div>
        <div className="inline-flex rounded-md border border-border p-0.5 text-[13px]">
          {(["describe", "template"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded-[5px] px-3 py-1 font-medium capitalize transition-colors ${
                tab === t
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "describe" ? (
          <div className="relative mt-3">
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  trimmed &&
                  !building
                ) {
                  e.preventDefault();
                  handleGenerate();
                }
              }}
              placeholder="Summarizes new GitHub PRs and posts a digest to Slack."
              className="min-h-[132px] resize-none pb-12 text-[13px]"
            />
            <div className="absolute bottom-2.5 right-2.5">
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!trimmed || building}
                onClick={handleGenerate}
              >
                {building ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" /> Building…
                  </>
                ) : (
                  "Generate"
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            <div className="max-h-[300px] overflow-y-auto p-1">
              <div className="grid gap-2.5 sm:grid-cols-2">
                {AGENT_TEMPLATES.map((template) => {
                  const selected = template.id === selectedId;
                  const Icon = TEMPLATE_ICON[template.id] ?? Sparkle;
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => pickTemplate(template)}
                      aria-pressed={selected}
                      className={`group flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                        selected
                          ? "border-brand bg-brand/5 ring-1 ring-brand/20"
                          : "border-border bg-card hover:border-brand/40 hover:bg-secondary/30"
                      }`}
                    >
                      <span
                        className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition-colors ${
                          selected
                            ? "border-brand/30 bg-brand/10 text-brand"
                            : "border-border bg-secondary/50 text-muted-foreground group-hover:text-brand"
                        }`}
                      >
                        <Icon size={17} weight="duotone" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-foreground">
                          {template.name}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-[12px] leading-5 text-muted-foreground">
                          {template.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Picking a template seeds the config below — tweak it, or switch to
              Describe to refine.
            </p>
          </div>
        )}
      </div>

      {/* Agent config — always open + editable. Write, paste, or generate. */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-medium text-muted-foreground">
            Agent config
          </span>
          <span className="text-[12px] text-muted-foreground">{agentName}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-border">
          <CodeEditor
            language="json"
            value={config}
            onChange={setConfig}
            height={220}
            placeholder="Write or paste a full agent config…"
          />
        </div>
        <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
          Write or paste a config, or generate one from a description above.{" "}
          <a
            href="https://docs.polpo.sh/docs/agents/definition"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Config reference
          </a>
        </p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          Prefer your editor? Install the Polpo skill pack and build and refine
          agents straight from your coding agent —{" "}
          <a
            href="https://docs.polpo.sh/docs/ecosystem/coding-agents"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            connect a coding agent
          </a>
          .
        </p>
      </div>

      {buildError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] leading-5 text-destructive">
          {buildError}
        </div>
      )}
      {builtAgentName && !building && (
        <div className="flex items-center gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-[12px] leading-5 text-foreground">
          <CheckCircle size={15} weight="fill" className="shrink-0 text-brand" />
          <span className="flex-1">
            Agent <span className="font-medium">{builtAgentName}</span> is live —
            edit the config to refine it.
          </span>
        </div>
      )}

      {configTrimmed && (
        <div className="flex items-center justify-end gap-3">
          {builtAgentName && projectId && (
            <button
              type="button"
              onClick={openAgent}
              className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Open agent
              <ArrowSquareOut size={13} />
            </button>
          )}
          <Button
            size="sm"
            className="gap-1.5"
            disabled={building}
            onClick={handleConfigAction}
          >
            {building ? (
              <>
                <CircleNotch size={14} className="animate-spin" /> Building…
              </>
            ) : builtAgentName ? (
              "Save changes"
            ) : (
              "Create agent"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

export function CreateAgentDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { openChat } = useCopilot();
  // Like edit: close the dialog, open the side builder, and send the composed
  // message (the describe text, a template's prompt, or the config).
  const handoff = (prompt: string) => {
    onOpenChange(false);
    openChat({ kind: "new", prompt });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 flex max-h-[88dvh] w-[calc(100vw-2rem)] flex-col overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight text-foreground">
            Create agent
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Start from a template or describe what you need.
          </DialogDescription>
        </DialogHeader>

        <CreateAgentContent
          projectId={projectId}
          resetSignal={open}
          onClose={() => onOpenChange(false)}
          onGenerate={handoff}
          onCreateFromConfig={(config) =>
            handoff(
              `Create an agent with this configuration:\n\n\`\`\`json\n${config}\n\`\`\`\n\nUse these values as the base, and add any skills or loops that fit.`,
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
}
