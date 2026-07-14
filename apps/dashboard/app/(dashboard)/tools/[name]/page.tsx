import { V2ToolDetailView } from "@polpo-ai/dashboard";

export default async function ToolPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <V2ToolDetailView name={decodeURIComponent(name)} />;
}
