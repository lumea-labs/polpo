import type { Task } from "@polpo-ai/core";
import { Markdown } from "../../../../../../../components/dashboard/markdown";
import { ManualRefreshButton } from "../../../../../../../components/dashboard/manual-refresh-button";
import type { BlueprintContext } from "../blueprint";

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function TaskOutputView({
  task,
  blueprint,
}: {
  task: Task | null;
  blueprint?: BlueprintContext | null;
}) {
  const result = task?.result;

  if (!result) {
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
            ? "No runtime output yet. Execute the mission to create a task instance."
            : "No output yet. The task may not have run."}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <ManualRefreshButton />
      </div>

      {/* Meta */}
      <div className="flex items-center gap-6 text-xs text-muted-foreground mb-4">
        {result.exitCode != null && (
          <span>Exit code: <span className="font-mono font-medium text-foreground">{result.exitCode}</span></span>
        )}
        {result.duration != null && (
          <span>Duration: <span className="font-mono font-medium text-foreground">{formatDuration(result.duration)}</span></span>
        )}
      </div>

      {/* Stdout — rendered as markdown (agents typically emit md), same component used by skills.
          Stderr below stays raw — it's machine output, not narrative. */}
      {result.stdout && (
        <section>
          <h3 className="text-sm font-semibold">stdout</h3>
          <div className="mt-3 border border-border bg-card p-5 overflow-x-auto">
            <Markdown content={result.stdout} />
          </div>
        </section>
      )}

      {/* Stderr */}
      {result.stderr && (
        <section className="mt-8">
          <h3 className="text-sm font-semibold text-destructive">stderr</h3>
          <div className="mt-3 border border-destructive/20 bg-card p-5 overflow-x-auto">
            <pre className="font-mono text-xs text-destructive/80 whitespace-pre-wrap">
              {result.stderr}
            </pre>
          </div>
        </section>
      )}

      {!result.stdout && !result.stderr && (
        <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          Task completed with no stdout/stderr output.
        </div>
      )}
    </div>
  );
}
