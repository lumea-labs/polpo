import Link from "next/link";
import { Markdown } from "#/components/dashboard/markdown";
import { CopyButton } from "#/components/dashboard/copy-button";
import { Hint } from "#/components/dashboard/hint";

export default function AgentMemoryView({ id, content }: { id: string; content: string }) {
  return (
    <div>
      <div className="mb-4">
        <Hint action={content ? <CopyButton value={content} label="Copy" className="shrink-0" /> : undefined}>
          Private memory this agent accumulates across sessions. It also inherits the
          shared project memory.
        </Hint>
      </div>

      {content ? (
        <div data-testid="agent-memory-content" className="border border-border bg-card p-6">
          <Markdown content={content} />
        </div>
      ) : (
        <div className="border border-border p-8 text-center text-sm text-muted-foreground">
          No memory yet. Memory is created automatically when the agent works.
        </div>
      )}

      <div className="mt-4">
        <Link
          href={`/projects/${id}/memory`}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          View shared project memory &rarr;
        </Link>
      </div>
    </div>
  );
}
