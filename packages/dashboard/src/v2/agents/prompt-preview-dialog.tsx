"use client";

import { useEffect, useState } from "react";
import { useQuery } from "../host";
import { CircleNotch, Wrench } from "@phosphor-icons/react/dist/ssr";
import { fetchDataPlane } from "../host";
import { CopyButton } from "../ui/copy-button";
import { Markdown } from "../host";
import { Button } from "../ui/button";
import { useCopilot } from "../host";
import { fetchModels } from "./model-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

/** ~4 chars/token — a cheap budget hint, no tokenizer bundle needed. */
const approxTokens = (s: string) => Math.round(s.length / 4);

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

/**
 * How much of the model's context window the composed system prompt already
 * eats — before a single turn of conversation. This is an audit signal, so the
 * colors are semantic (green/amber/red), separate from the brand accent.
 *   < 8%   healthy   — not bloating the context
 *   8–20%  moderate  — starting to crowd it
 *   > 20%  heavy     — bloating the context
 */
type Severity = "healthy" | "moderate" | "heavy";

function severityOf(share: number): Severity {
  if (share < 0.08) return "healthy";
  if (share > 0.2) return "heavy";
  return "moderate";
}

const SEVERITY: Record<
  Severity,
  { verdict: string; advice: string; stroke: string; text: string; band: string }
> = {
  healthy: {
    verdict: "Not bloating your context",
    advice: "Lean — plenty of room left for the conversation.",
    stroke: "stroke-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    band: "border-emerald-500/30 bg-emerald-500/[0.06]",
  },
  moderate: {
    verdict: "Starting to crowd the context",
    advice:
      "Getting heavy — consider moving detail into skills (progressive disclosure).",
    stroke: "stroke-amber-500",
    text: "text-amber-600 dark:text-amber-500",
    band: "border-amber-500/30 bg-amber-500/[0.06]",
  },
  heavy: {
    verdict: "This is bloating your context",
    advice:
      "Trim instructions or move detail into skills so it loads on demand.",
    stroke: "stroke-destructive",
    text: "text-destructive",
    band: "border-destructive/30 bg-destructive/[0.06]",
  },
};

/** SVG ring gauge — the share of the window filled, colored by severity. */
function RingGauge({ pct, stroke }: { pct: number; stroke: string }) {
  const r = 32;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.min(Math.max(pct, 0), 100) / 100) * circumference;
  return (
    <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90" aria-hidden>
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        strokeWidth="8"
        className="stroke-secondary"
      />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        className={stroke}
        strokeDasharray={`${filled} ${circumference}`}
      />
    </svg>
  );
}

/** Small always-visible data chip — label + monospace value. */
function DataChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1">
      <span className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground/60">
        {label}
      </span>
      <span
        className="font-mono text-[11.5px] font-medium text-foreground"
        data-tabular
      >
        {value}
      </span>
    </span>
  );
}

type Block = { key: string; label: string; content: string };

/**
 * The prompt is composed server-side on the per-tenant instance (config +
 * skills + assembly), so the wait is a real round-trip. Narrate the stages so
 * it reads as work, not a hang — advance and hold on the last step.
 */
const COMPOSING_STEPS = [
  "Loading agent config…",
  "Expanding variables…",
  "Loading skills…",
  "Assembling system prompt…",
];

function ComposingStatus() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(
      () => setI((n) => Math.min(n + 1, COMPOSING_STEPS.length - 1)),
      850,
    );
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-[13px] text-muted-foreground">
      <CircleNotch size={16} className="animate-spin" />
      <span>{COMPOSING_STEPS[i]}</span>
    </div>
  );
}

/**
 * The composed system prompt the platform sends to the model, audited against
 * the selected model's context window: a ring-gauge verdict on whether the
 * system prompt is bloating the context, a per-block token breakdown, and the
 * full prompt.
 */
export function PromptPreviewDialog({
  projectId,
  agentName,
  model,
  open,
  onOpenChange,
}: {
  projectId: string;
  agentName: string;
  /** The agent's current text model id, e.g. "anthropic/claude-sonnet-4.5". */
  model?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { openChat } = useCopilot();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["agent-prompt", projectId, agentName, "chat"],
    queryFn: () =>
      fetchDataPlane<{
        ok: boolean;
        data: { prompt: string; blocks?: Block[]; mode?: string };
      }>(projectId, `/v1/agents/${encodeURIComponent(agentName)}/prompt?mode=chat`),
    enabled: open,
    staleTime: 30_000,
  });

  // Shared, app-wide catalog cache (same key the model picker uses) — gives us
  // the selected model's context window without a second network shape.
  const { data: modelCatalog = [] } = useQuery({
    queryKey: ["gateway-models"],
    queryFn: fetchModels,
    staleTime: 10 * 60_000,
    enabled: open && !!model,
  });

  const prompt = data?.data?.prompt ?? "";
  const blocks = data?.data?.blocks ?? [];
  const totalTokens = approxTokens(prompt);

  const windowTokens = model
    ? modelCatalog.find((m) => m.id === model)?.context
    : undefined;
  const showBudget = !!windowTokens && windowTokens > 0 && totalTokens > 0;
  const share = windowTokens && windowTokens > 0 ? totalTokens / windowTokens : 0;
  const pct = Math.round(share * 100);
  // A tiny prompt rounds to 0% — show "<1%" so it doesn't read as "nothing".
  const pctLabel = pct < 1 && totalTokens > 0 ? "<1%" : `${pct}%`;
  const severity = severityOf(share);
  const sev = SEVERITY[severity];
  const modelShort = model ? model.split("/").slice(1).join("/") || model : "";

  function fixWithAi() {
    // Seeded agent-edit threads start clean each open (dock keys by seq when a
    // prompt is present); clearing any stale draft avoids resuming an old one.
    try {
      window.localStorage.removeItem(`polpo:agent-edit:${projectId}:${agentName}`);
    } catch {}
    openChat({
      kind: "agent",
      name: agentName,
      prompt: `My system prompt is ~${totalTokens} tokens (${pct}% of ${model}'s ${windowTokens}-token context window). Help me trim it without changing behavior — suggest what to cut or move into skills.`,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 w-[calc(100vw-2rem)] sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle className="text-[14px] font-semibold">
            Chat runtime prompt
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            The exact chat/playground prompt composed by the runtime: mode,
            memory, skills, workspace, and variables expanded.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <ComposingStatus />
        ) : isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-[13px] text-destructive">
            {error instanceof Error ? error.message : "Failed to load the prompt"}
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-4">
            {/* Context audit — the system prompt's share of the model's window */}
            {showBudget && windowTokens ? (
              <div
                className={`flex flex-col items-start gap-4 rounded-lg border p-4 sm:flex-row sm:items-center ${sev.band}`}
              >
                <div className="relative h-20 w-20 shrink-0">
                  <RingGauge pct={pct} stroke={sev.stroke} />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span
                      className={`text-[16px] font-semibold tabular-nums ${sev.text}`}
                    >
                      {pctLabel}
                    </span>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-[14px] font-semibold ${sev.text}`}>
                    {sev.verdict}
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {sev.advice}
                  </p>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <DataChip label="Model" value={modelShort} />
                    <DataChip
                      label="Window"
                      value={`${fmtCompact(windowTokens)} tok`}
                    />
                    <DataChip
                      label="System prompt"
                      value={`≈${fmtCompact(totalTokens)}`}
                    />
                    <DataChip label="Used" value={pctLabel} />
                    <DataChip
                      label="Free"
                      value={`~${fmtCompact(windowTokens - totalTokens)}`}
                    />
                  </div>
                </div>
                {(severity === "moderate" || severity === "heavy") && (
                  <Button
                    type="button"
                    size="sm"
                    onClick={fixWithAi}
                    className="shrink-0"
                  >
                    <Wrench size={14} />
                    Fix with AI
                  </Button>
                )}
              </div>
            ) : null}

            <div className="flex min-h-0 flex-col gap-3 md:flex-row md:gap-4">
              {/* Left — per-block breakdown */}
              <div className="shrink-0 md:w-56">
                <div className="mb-2 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
                  Context breakdown
                </div>
                {blocks.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground/60">
                    No block breakdown available.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {blocks.map((b) => {
                      const t = approxTokens(b.content);
                      const share = totalTokens
                        ? Math.round((t / totalTokens) * 100)
                        : 0;
                      return (
                        <div
                          key={b.key}
                          className="rounded-md border border-border bg-card px-2.5 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[12px] font-medium text-foreground">
                              {b.label}
                            </span>
                            <span
                              className="shrink-0 font-mono text-[11px] text-muted-foreground"
                              data-tabular
                            >
                              {fmtCompact(t)}
                            </span>
                          </div>
                          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
                            <div
                              className="h-full rounded-full bg-brand"
                              style={{ width: `${Math.max(share, 2)}%` }}
                            />
                          </div>
                          <div
                            className="mt-1 font-mono text-[10px] text-muted-foreground/55"
                            data-tabular
                          >
                            {share}% · {b.content.length.toLocaleString()} chars
                          </div>
                        </div>
                      );
                    })}
                    <div className="mt-1 flex items-center justify-between px-0.5 text-[11px] text-muted-foreground">
                      <span>Total context</span>
                      <span className="font-mono text-foreground" data-tabular>
                        ≈&nbsp;{fmtCompact(totalTokens)} tok
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Right — composed prompt */}
              <div className="relative min-w-0 flex-1">
                <CopyButton
                  text={prompt}
                  className="absolute right-2 top-2 z-10"
                />
                <div className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-background p-4 pr-10 text-[13px] leading-relaxed text-foreground">
                  {prompt ? (
                    <Markdown content={prompt} />
                  ) : (
                    <span className="text-muted-foreground">
                      This agent has no composed prompt.
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
