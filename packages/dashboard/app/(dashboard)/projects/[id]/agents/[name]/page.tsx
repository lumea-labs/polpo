import { Suspense } from "react";
import { dataApi, getAgent } from "../../../../../../lib/api";
import { AgentProfileSkeleton } from "../../../../../../components/dashboard/skeletons";
import { AgentStudio, type VaultEntry } from "../../../../../../components/dashboard/agent-studio";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function AgentData({ id, name }: { id: string; name: string }) {
  // The agent detail IS the Studio (chat canvas). Fetch everything its
  // tabs need (agent + memory + vault) up front, server-side.
  const [agent, memoryContent, vaultEntries] = await Promise.all([
    getAgent(id, name),
    dataApi<{ ok: boolean; data: { content: string } }>(
      id,
      `/v1/memory/agent/${encodeURIComponent(name)}`,
    )
      .then((r) => r.data?.content ?? "")
      .catch(() => ""),
    dataApi<{ ok: boolean; data: VaultEntry[] }>(
      id,
      `/v1/vault/entries/${encodeURIComponent(name)}`,
    )
      .then((r) => r.data ?? [])
      .catch(() => [] as VaultEntry[]),
  ]);

  return (
    <AgentStudio
      projectId={id}
      apiUrl={API_URL}
      agent={agent}
      memoryContent={memoryContent}
      vaultEntries={vaultEntries}
    />
  );
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const { id, name } = await params;
  const decodedName = decodeURIComponent(name);

  return (
    <Suspense fallback={<AgentProfileSkeleton />}>
      <AgentData id={id} name={decodedName} />
    </Suspense>
  );
}
