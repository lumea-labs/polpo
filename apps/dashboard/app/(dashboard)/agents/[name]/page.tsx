import { V2AgentDetailView } from "@polpo-ai/dashboard";

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <V2AgentDetailView name={decodeURIComponent(name)} />;
}
