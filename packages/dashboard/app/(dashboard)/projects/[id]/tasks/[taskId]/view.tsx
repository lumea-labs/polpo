import type { Task } from "@polpo-ai/core";
import { ManualRefreshButton } from "#/components/dashboard/manual-refresh-button";
import type { BlueprintContext } from "./blueprint";

const statusColor: Record<string, string> = {
  done: "bg-brand",
  in_progress: "bg-foreground animate-pulse",
  pending: "bg-muted-foreground/30",
  failed: "bg-destructive",
  review: "bg-yellow-500",
  assigned: "bg-muted-foreground/50",
  draft: "bg-muted-foreground/20",
  awaiting_approval: "bg-yellow-500",
};

export default function TaskOverviewView({
  task,
  blueprint,
}: {
  task: Task | null;
  blueprint?: BlueprintContext;
}) {
  if (!task) {
    return (
      <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
        Task not found.
      </div>
    );
  }

  return (
    <div>
      {blueprint && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 px-4 py-3 text-xs">
          <p className="font-medium text-foreground">
            Blueprint task
            {blueprint.missionStatus === "recurring" && " — recurring mission"}
            {blueprint.missionStatus === "draft" && " — draft mission"}
          </p>
          <p className="mt-1 text-muted-foreground">
            This is the template definition of a task from mission{" "}
            <span className="font-mono">{blueprint.missionName}</span>. It isn&rsquo;t a real run —
            a fresh task instance is created each time the mission is executed
            {blueprint.missionStatus === "recurring" ? " on its schedule" : ""}. Status,
            retries, expectations and outputs only fill in once an instance starts.
          </p>
        </div>
      )}

      {/* Header */}
      <div className={blueprint ? "mt-4 flex items-start justify-between gap-4" : "flex items-start justify-between gap-4"}>
        <div className="flex items-center gap-3">
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor[task.status ?? "pending"]}`} />
          <h2 className="text-lg font-extrabold tracking-tight">{task.title}</h2>
        </div>
        <ManualRefreshButton className="mt-1 shrink-0" />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{task.description}</p>

      {/* Meta */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4">
        {[
          ["Agent", task.assignTo ?? "\u2014"],
          ["Status", task.status ?? "\u2014"],
          ["Phase", task.phase ?? "\u2014"],
          ["Retries", `${task.retries ?? 0}/${task.maxRetries ?? 3}`],
        ].map(([label, value]) => (
          <div key={label} className="border border-border bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-1 text-sm font-medium">{value}</p>
          </div>
        ))}
      </div>

      {/* Expectations */}
      {task.expectations && task.expectations.length > 0 && (
        <section className="mt-8">
          <h3 className="text-sm font-semibold">Expectations</h3>
          <div className="mt-3 border border-border overflow-hidden">
            {task.expectations.map((exp, i) => (
              <div key={i} className="flex items-center justify-between border-b border-border last:border-0 px-4 py-3">
                <div>
                  <span className="font-mono text-xs">{exp.type}</span>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {"command" in exp ? exp.command : "paths" in exp ? (exp.paths as string[]).join(", ") : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Expected outcomes */}
      {task.expectedOutcomes && task.expectedOutcomes.length > 0 && (
        <section className="mt-8">
          <h3 className="text-sm font-semibold">Expected outcomes</h3>
          <div className="mt-3 border border-border overflow-hidden">
            {task.expectedOutcomes.map((o, i) => (
              <div key={i} className="border-b border-border last:border-0 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{o.type}</span>
                  <span className="text-sm font-medium">{o.label}</span>
                </div>
                {o.description && <p className="mt-1 text-xs text-muted-foreground">{o.description}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Config */}
      <section className="mt-8">
        <h3 className="text-sm font-semibold">Details</h3>
        <div className="mt-3 border border-border bg-card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[320px]">
            <tbody>
              {[
                ["Mission", task.missionId ?? "\u2014"],
                ["Dependencies", task.dependsOn?.join(", ") || "none"],
                ["Side effects", task.sideEffects ? "yes" : "no"],
                ["Session", task.sessionId ?? "\u2014"],
                ["Created", task.createdAt ?? "\u2014"],
                ["Updated", task.updatedAt ?? "\u2014"],
              ].map(([label, value]) => (
                <tr key={label} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground w-32">{label}</td>
                  <td className="px-4 py-2.5 text-xs font-mono">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
