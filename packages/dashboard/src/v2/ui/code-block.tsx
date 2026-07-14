"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "./copy-button.js";

/**
 * Syntax-highlighted, copyable code block powered by Shiki (already a dep).
 * Shiki is lazy-imported on mount so it stays out of the main bundle, and we
 * emit a dual light/dark theme (CSS-variable driven — see the `.shiki` rules in
 * v2.css) so it tracks the v2 theme toggle. Falls back to plain <pre> until the
 * highlighter resolves (or if it fails).
 */
export function CodeBlock({
  code,
  lang = "json",
  className,
  maxHeightClass = "max-h-[60vh]",
  showCopy = true,
  bare = false,
  wrap = false,
}: {
  code: string;
  lang?: string;
  className?: string;
  maxHeightClass?: string;
  /** Built-in top-right copy button. Turn off to place your own, non-overlapping. */
  showCopy?: boolean;
  /** Drop the border/rounding so the block can sit inside another container. */
  bare?: boolean;
  /** Wrap long lines instead of requiring horizontal scrolling. */
  wrap?: boolean;
}) {
  const frame = bare ? "" : "rounded-lg border border-border";
  const overflow = wrap ? "overflow-y-auto overflow-x-hidden" : "overflow-auto";
  const highlightedWrap = wrap
    ? "[&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_code]:whitespace-pre-wrap [&_code]:break-words [&_.line]:whitespace-pre-wrap [&_.line]:break-words"
    : "[&_pre]:whitespace-pre";
  const fallbackWrap = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre";
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { codeToHtml } = await import("shiki");
        const out = await codeToHtml(code, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className={`relative min-w-0 max-w-full ${className ?? ""}`}>
      {showCopy && (
        <CopyButton text={code} className="absolute right-2 top-2 z-10" />
      )}
      {html ? (
        <div
          className={`shiki-block ${maxHeightClass} ${overflow} ${frame} bg-card p-4 text-[12.5px] leading-relaxed [&_pre]:m-0 ${highlightedWrap} [&_pre]:!bg-transparent [&_pre]:font-mono`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={`${maxHeightClass} ${overflow} ${frame} bg-card p-4 font-mono text-[12.5px] leading-relaxed text-foreground ${fallbackWrap}`}
        >
          {code}
        </pre>
      )}
    </div>
  );
}
