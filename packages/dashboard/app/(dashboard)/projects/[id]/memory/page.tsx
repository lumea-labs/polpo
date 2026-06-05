import { Suspense } from "react";
import { dataApi } from "#/lib/api";
import { ProjectMemorySkeleton } from "#/components/dashboard/skeletons";
import MemoryView from "./view";

async function MemoryData({ id }: { id: string }) {
  let memoryContent = "";
  try {
    const res = await dataApi<{ ok: boolean; data: { content: string } }>(
      id,
      "/v1/memory",
    );
    memoryContent = res.data?.content ?? "";
  } catch {}

  return <MemoryView memoryContent={memoryContent} />;
}

export default async function MemoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Project memory</h2>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed max-w-xl">
        Memory is built and maintained automatically as agents work. Project memory is
        shared across all agents — every agent in this project inherits this context
        at the start of each session.
      </p>

      <Suspense fallback={<ProjectMemorySkeleton />}>
        <MemoryData id={id} />
      </Suspense>
    </div>
  );
}
