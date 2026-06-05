"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Icon-only copy-to-clipboard affordance. Swaps to a check for 2s after
 * copying. Used for quick-copy of instructions, memory, etc.
 */
export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={copied ? "Copied" : label}
      className={`inline-flex items-center gap-1.5 border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground ${className}`}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" strokeWidth={1.5} />
      ) : (
        <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
      )}
      {copied ? "Copied" : label}
    </button>
  );
}
