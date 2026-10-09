"use client";

import { useState } from "react";
import { Copy, Check } from "@phosphor-icons/react/dist/ssr";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./tooltip.js";
import { cn } from "../utils.js";

/**
 * An inline, copyable identifier — the raw id you need to grep a log or call
 * the API, labelled so it reads as an id rather than a stray string.
 *
 * The copy affordance is a bare icon that only appears on hover: at rest the
 * id itself is the content, and a permanently-visible bordered button would
 * outweigh it. `focus-visible` keeps it reachable without a mouse.
 */
export function CopyId({
  id,
  label = "id",
  className,
}: {
  id: string;
  /** Overrides the leading label (e.g. "run id"). */
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — nothing useful to say */
    }
  };

  // The whole thing is the target — the icon is an affordance, not the hit
  // area. A 24px icon would be a needlessly small thing to aim at when the
  // id right next to it means the same "copy me".
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Copied" : `Copy ${label}`}
            className={cn(
              "group/copyid inline-flex min-w-0 items-center gap-1.5 rounded text-left",
              className,
            )}
          >
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/50">
              {label}
            </span>
            <span className="truncate font-mono text-[12px] text-muted-foreground transition-colors group-hover/copyid:text-foreground">
              {id}
            </span>
            <span
              aria-hidden
              className="grid size-5 shrink-0 place-items-center text-muted-foreground opacity-0 transition-opacity group-hover/copyid:opacity-100 group-focus-visible/copyid:opacity-100"
            >
              {copied ? (
                <Check size={12} weight="bold" className="text-brand" />
              ) : (
                <Copy size={12} />
              )}
            </span>
          </button>
        }
      />
      <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}
