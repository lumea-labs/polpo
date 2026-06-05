"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { highlight } from "sugar-high";

/**
 * Card with a small pill label at top-left, copy icon top-right,
 * monospace value beneath. Shared across ConnectDialog, WelcomeBanner,
 * and OnboardingChecklist.
 */
export function CopyCard({ label, value, lang }: { label: string; value: string; lang?: "ts" | "curl" }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <div className="flex flex-col gap-2 border border-border bg-background p-3">
      <div className="flex items-center justify-between">
        <span className="inline-flex h-5 items-center rounded bg-secondary px-2 text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="h-4 w-4 text-brand" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
      {lang ? (
        <pre
          className="font-mono text-sm leading-6 whitespace-pre-wrap break-all overflow-x-auto sh-code"
          dangerouslySetInnerHTML={{ __html: highlight(value) }}
        />
      ) : (
        <pre className="font-mono text-sm leading-6 text-foreground whitespace-pre-wrap break-all overflow-x-auto">{value}</pre>
      )}
    </div>
  );
}
