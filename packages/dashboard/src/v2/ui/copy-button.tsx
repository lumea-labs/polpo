"use client";

import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react/dist/ssr";

/** Small quick-copy button — drop it into the top-right of any code block. */
export function CopyButton({
  text,
  className,
  size = "sm",
  label,
}: {
  text: string;
  className?: string;
  size?: "sm" | "md";
  /** When set, renders a labelled button (icon + text) instead of icon-only. */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const icon = size === "md" ? 15 : 13;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const Glyph = copied ? (
    <Check size={icon} weight="bold" className="text-brand" />
  ) : (
    <Copy size={icon} />
  );

  if (label) {
    return (
      <button
        type="button"
        onClick={copy}
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card/80 px-2.5 text-[12px] font-medium text-muted-foreground backdrop-blur transition-colors hover:text-foreground ${
          className ?? ""
        }`}
      >
        {Glyph}
        {label}
      </button>
    );
  }

  const box = size === "md" ? "h-8 w-8" : "h-7 w-7";
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={copy}
      className={`grid ${box} shrink-0 place-items-center rounded-md border border-border bg-card/80 text-muted-foreground backdrop-blur transition-colors hover:text-foreground ${
        className ?? ""
      }`}
    >
      {Glyph}
    </button>
  );
}
