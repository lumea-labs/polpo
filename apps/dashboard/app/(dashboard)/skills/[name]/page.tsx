import { V2SkillDetailView } from "@polpo-ai/dashboard";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <V2SkillDetailView name={decodeURIComponent(name)} />;
}
