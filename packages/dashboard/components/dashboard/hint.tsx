import type { ReactNode } from "react";
import { Info } from "lucide-react";

/**
 * Info banner for tab descriptions — a bordered, padded callout with an
 * info icon and a left accent rule. Replaces the faint muted one-liners
 * that were easy to miss, so the context for each tab actually reads.
 *
 * Neo-brutalist: sharp corners, solid left accent, no gradient. An optional
 * `action` (e.g. a Copy / Preview button) sits on the right, aligned to top.
 */
export function Hint({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border border-border border-l-2 border-l-muted-foreground/40 bg-secondary/30 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <Info className="mt-px h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <p className="text-[13px] leading-relaxed text-foreground">{children}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
