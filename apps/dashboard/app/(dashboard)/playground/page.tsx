import { PageBody, PlaygroundView } from "@polpo-ai/dashboard";

export default async function PlaygroundPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  return <PageBody><PlaygroundView initialAgent={agent} /></PageBody>;
}
