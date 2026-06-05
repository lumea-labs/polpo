import { Suspense } from "react";
import { dataApi } from "@/lib/api";
import { SkillsListSkeleton } from "@/components/dashboard/skeletons";
import SkillsView, { type SkillInfo } from "./view";

async function SkillsData({ id }: { id: string }) {
  let skills: SkillInfo[] = [];
  try {
    const res = await dataApi<{ ok: boolean; data: SkillInfo[] }>(
      id,
      "/v1/skills",
    );
    skills = res.data ?? [];
  } catch {}

  return <SkillsView initialSkills={skills} />;
}

export default async function SkillsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<SkillsListSkeleton />}>
      <SkillsData id={id} />
    </Suspense>
  );
}
