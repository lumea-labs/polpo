import { V2SessionDetailView } from "@polpo-ai/dashboard";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <V2SessionDetailView runId={decodeURIComponent(id)} />;
}
