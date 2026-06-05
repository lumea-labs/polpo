import type { Task } from "@polpo-ai/core";
import { ManualRefreshButton } from "#/components/dashboard/manual-refresh-button";
import type { BlueprintContext } from "../blueprint";

export default function TaskAssessmentView({
  task,
  blueprint,
}: {
  task: Task | null;
  blueprint?: BlueprintContext | null;
}) {
  const a = task?.result?.assessment;

  if (!a) {
    return (
      <div className="mt-4 space-y-4">
        <div className="flex justify-end">
          <ManualRefreshButton />
        </div>
        {blueprint && (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-xs">
            <p className="font-medium text-foreground">Blueprint task</p>
            <p className="mt-1 text-muted-foreground">
              This task is a template from mission <span className="font-mono">{blueprint.missionName}</span>.
            </p>
          </div>
        )}
        <div className="border border-border p-8 text-center text-sm text-muted-foreground">
          {blueprint
            ? "No runtime assessment yet. Execute the mission to create a task instance."
            : "No assessment yet. The task may not have been assessed."}
        </div>
      </div>
    );
  }

  const passed = a.passed ?? (a.globalScore != null && a.globalScore >= 3.5);
  const checks = a.checks ?? [];
  const scores = a.scores ?? [];

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <ManualRefreshButton />
      </div>

      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`h-3 w-3 rounded-full ${passed ? "bg-brand" : "bg-destructive"}`} />
          <span className="text-sm font-semibold">{passed ? "Passed" : "Failed"}</span>
        </div>
        {a.globalScore != null && (
          <span className="text-2xl font-extrabold font-mono">{a.globalScore.toFixed(1)}<span className="text-sm text-muted-foreground font-normal">/5</span></span>
        )}
      </div>

      {/* Checks */}
      {checks.length > 0 && (
        <section className="mt-8">
          <h3 className="text-sm font-semibold">Expectation checks</h3>
          <div className="mt-3 border border-border overflow-hidden">
            {checks.map((check: { type?: string; passed?: boolean; message?: string; details?: string }, i: number) => (
              <div key={i} className="flex items-center justify-between border-b border-border last:border-0 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{check.type}</span>
                    <span className="text-xs text-muted-foreground">{check.message}</span>
                  </div>
                  {check.details && <p className="mt-0.5 text-[11px] text-muted-foreground/50">{check.details}</p>}
                </div>
                <span className={`h-2 w-2 rounded-full shrink-0 ${check.passed ? "bg-brand" : "bg-destructive"}`} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Dimension scores */}
      {scores.length > 0 && (
        <section className="mt-8">
          <h3 className="text-sm font-semibold">G-Eval dimensions</h3>
          <div className="mt-3 space-y-3">
            {scores.map((s: { dimension?: string; score?: number; weight?: number; reasoning?: string }, i: number) => (
              <div key={s.dimension ?? i} className="border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize">{(s.dimension ?? "").replace("_", " ")}</span>
                    {s.weight != null && <span className="text-[10px] text-muted-foreground/40">weight: {s.weight}</span>}
                  </div>
                  {s.score != null && <span className="font-mono text-sm font-bold">{s.score}/5</span>}
                </div>
                {s.score != null && (
                  <div className="mt-2 h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                    <div className="h-full bg-foreground/60 transition-all" style={{ width: `${(s.score / 5) * 100}%` }} />
                  </div>
                )}
                {s.reasoning && <p className="mt-3 text-xs text-muted-foreground leading-relaxed">{s.reasoning}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Timestamp */}
      {a.timestamp && (
        <p className="mt-6 text-[11px] text-muted-foreground/40">
          Assessed at {new Date(a.timestamp).toLocaleString()}
        </p>
      )}
    </div>
  );
}
