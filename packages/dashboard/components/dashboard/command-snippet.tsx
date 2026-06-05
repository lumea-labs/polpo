"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A single terminal-style command line with copy-to-clipboard. Sharp,
 * mono, neo-brutalist — adapted from lumea-agents' skill.sh install
 * snippet. Informational: it copies the command, it does not run it.
 */
export function CommandSnippet({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void copyToClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="flex items-center gap-2 overflow-hidden border border-border bg-background px-3 py-2">
      <span aria-hidden className="select-none font-mono text-xs text-muted-foreground/60">
        $
      </span>
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground scrollbar-none">
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        title="Copy"
        className={`inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 border px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] transition-colors ${
          copied
            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-border bg-secondary text-muted-foreground hover:border-foreground/40 hover:text-foreground"
        }`}
      >
        {copied ? (
          <>
            <Check className="h-2.5 w-2.5" aria-hidden />
            copied
          </>
        ) : (
          <>
            <Copy className="h-2.5 w-2.5" aria-hidden />
            copy
          </>
        )}
      </button>
    </div>
  );
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through */
    }
  }
  if (typeof document === "undefined") return;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* swallow */
  }
  document.body.removeChild(ta);
}
