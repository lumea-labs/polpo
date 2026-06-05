"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import type { AgentConfig } from "@polpo-ai/core";
import { Markdown } from "../../../../../../../components/dashboard/markdown";
import { CopyButton } from "../../../../../../../components/dashboard/copy-button";
import { Hint } from "../../../../../../../components/dashboard/hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../../../../../components/ui/dialog";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Rough token estimate — ~4 chars/token, good enough for a budget hint. */
const approxTokens = (s: string) => Math.round(s.length / 4);

export default function AgentPromptView({
  agent,
  projectId,
  agentName,
}: {
  agent: AgentConfig | null;
  projectId: string;
  agentName: string;
}) {
  if (!agent) {
    return (
      <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
        Agent not found.
      </div>
    );
  }

  const instructions = agent.systemPrompt ?? "";
  const chars = instructions.length;

  return (
    <div>
      <Hint action={<PreviewButton projectId={projectId} agentName={agentName} />}>
        Extra instructions added on top of the agent&apos;s base prompt — they shape
        tone and rules without replacing Polpo&apos;s defaults. Hit Preview for the
        full composed prompt.
      </Hint>

      {instructions ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 border border-border bg-secondary/40 px-2 py-0.5 font-mono text-[11px] font-medium text-foreground">
              {chars.toLocaleString()}
              <span className="text-muted-foreground">chars</span>
            </span>
            <span className="inline-flex items-center gap-1 border border-border bg-secondary/40 px-2 py-0.5 font-mono text-[11px] font-medium text-foreground">
              ~{approxTokens(instructions).toLocaleString()}
              <span className="text-muted-foreground">tokens</span>
            </span>
          </div>
          <div className="mt-3 border border-border bg-card p-6">
            <Markdown content={instructions} />
          </div>
        </>
      ) : (
        <div className="mt-3 border border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No extra instructions configured.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This agent runs on the default base prompt. Preview it to see what that includes.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Loading state for the prompt preview — a sharp skeleton that mimics the
 * composed prompt materialising (metadata bar + paragraph blocks of
 * varying width), in keeping with the rest of the surface.
 */
function PromptSkeleton() {
  // Width pattern per "paragraph" — last line of each block is shorter,
  // so it reads as real prose rather than a uniform block.
  const blocks = [
    ["w-1/3"],
    ["w-full", "w-full", "w-11/12", "w-2/3"],
    ["w-full", "w-5/6", "w-full", "w-1/2"],
    ["w-3/4", "w-full", "w-4/5"],
  ];
  let line = 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 border-y border-border py-2">
        <span className="h-3 w-40 animate-pulse bg-muted" />
        <span className="h-6 w-16 animate-pulse bg-muted" />
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-hidden bg-card p-4">
        {blocks.map((widths, b) => (
          <div key={b} className="space-y-2">
            {widths.map((w) => {
              const delay = (line++ % 6) * 90;
              return (
                <div
                  key={w + line}
                  className={`h-3 ${w} animate-pulse bg-muted`}
                  style={{ animationDelay: `${delay}ms` }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="border-t border-border pt-2 font-mono text-[11px] text-muted-foreground/60">
        Composing the full prompt…
      </p>
    </div>
  );
}

/**
 * Preview — fetches the FULLY composed system prompt from the data plane
 * (`GET /v1/agents/:name/prompt`), which runs the same `buildAgentSystemPrompt`
 * + skill-loading the runtime uses. Shows the exact text sent to the model.
 */
function PreviewButton({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setOpen(true);
    setLoading(true);
    setError(null);
    setPrompt(null);
    try {
      const res = await fetch(
        `${API_URL}/v1/projects/${projectId}/data/v1/agents/${encodeURIComponent(agentName)}/prompt`,
        { credentials: "include" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(body.error ?? `Failed to compose prompt (${res.status})`);
      } else {
        setPrompt(body.data?.prompt ?? "");
      }
    } catch (err) {
      setError((err as Error).message ?? "Failed to compose prompt");
    }
    setLoading(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void load()}
        className="inline-flex shrink-0 items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
      >
        <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />
        Preview
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Composed system prompt</DialogTitle>
            <DialogDescription>
              The complete prompt the platform sends to the model — base prompt,
              identity, your instructions and loaded skills, exactly as the
              runtime composes it.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <PromptSkeleton />
          ) : error ? (
            <p className="py-6 text-sm text-destructive">{error}</p>
          ) : prompt !== null ? (
            <>
              <div className="flex items-center justify-between gap-4 border-y border-border py-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 border border-border bg-secondary/40 px-2 py-0.5 font-mono text-[11px] font-medium text-foreground">
                    {prompt.length.toLocaleString()}
                    <span className="text-muted-foreground">chars</span>
                  </span>
                  <span className="inline-flex items-center gap-1 border border-border bg-secondary/40 px-2 py-0.5 font-mono text-[11px] font-medium text-foreground">
                    ~{approxTokens(prompt).toLocaleString()}
                    <span className="text-muted-foreground">tokens</span>
                  </span>
                </div>
                <CopyButton value={prompt} label="Copy" className="shrink-0" />
              </div>
              <div className="min-h-0 flex-1 overflow-auto bg-card p-4">
                <Markdown content={prompt} />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
