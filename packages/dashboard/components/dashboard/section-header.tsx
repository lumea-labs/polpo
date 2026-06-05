import type { ReactNode } from "react";

/**
 * Shared section header for the agent tab pages (Capabilities, Tools,
 * Skills, …) so every internal section reads the same: a title with an
 * optional count, and a one-line muted description. Keeps the tabs
 * visually coherent.
 */
export function SectionHeader({
  title,
  count,
  description,
}: {
  /** Optional — omit when a tab already labels the section (avoids a
   *  redundant heading). Description-only is rendered then. */
  title?: string;
  count?: number;
  description?: ReactNode;
}) {
  return (
    <div>
      {title && (
        <h3 className="text-sm font-semibold">
          {title}
          {count !== undefined && (
            <span className="ml-1 font-mono text-muted-foreground/60">({count})</span>
          )}
        </h3>
      )}
      {description && (
        <p className={`text-xs text-muted-foreground ${title ? "mt-1" : ""}`}>
          {description}
        </p>
      )}
    </div>
  );
}
