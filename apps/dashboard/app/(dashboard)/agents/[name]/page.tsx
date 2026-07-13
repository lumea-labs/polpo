import { AgentDetailView, PageBody } from "@polpo-ai/dashboard";

export default async function AgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <PageBody><AgentDetailView name={decodeURIComponent(name)} /></PageBody>;
}
