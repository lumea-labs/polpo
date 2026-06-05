import type { ReactNode } from "react";
import { Users } from "lucide-react";

/**
 * Shared agent identity header — monogram + name + optional team badge +
 * role, with a right-aligned actions slot. One implementation used by the
 * agent detail page layout AND the builder's right pane, so the two never
 * diverge (DRY). Presentational only (no hooks) → safe in server + client.
 */
export function AgentIdentityHeader({
  name,
  role,
  team,
  actions,
}: {
  name: string;
  role?: string | null;
  team?: string | null;
  actions?: ReactNode;
}) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div className="flex items-start gap-3">
      <div className="grid size-10 shrink-0 place-items-center bg-foreground font-mono text-xs font-bold text-background">
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-base font-extrabold tracking-tight">
            {name}
          </h2>
          {team && (
            <span className="inline-flex shrink-0 items-center gap-1 border border-border bg-secondary px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              <Users className="h-3 w-3" strokeWidth={2} />
              {team}
            </span>
          )}
        </div>
        <p
          className={`mt-0.5 text-sm italic ${role ? "text-muted-foreground" : "text-muted-foreground/40"}`}
        >
          {role || "No role set"}
        </p>
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
