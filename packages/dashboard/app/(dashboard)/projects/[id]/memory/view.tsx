import { Markdown } from "../../../../../components/dashboard/markdown";

export default function MemoryView({ memoryContent }: { memoryContent: string }) {
  if (memoryContent) {
    return (
      <div data-testid="project-memory-content" className="mt-6 border border-border bg-card p-6">
        <Markdown content={memoryContent} />
      </div>
    );
  }

  return (
    <div className="mt-6 border border-border p-8 text-center text-sm text-muted-foreground">
      No project memory yet. Memory is created automatically when agents work.
    </div>
  );
}
