import { Suspense } from "react";
import { dataApi } from "#/lib/api";
import { SkillDetailSkeleton } from "#/components/dashboard/skeletons";
import SkillDetailView, { type LoadedSkill, type FileEntry } from "./view";

/** Slim shape for the list-entry merge. Keep in sync with `SkillsListEntry`
 *  in view.tsx; only the fields the detail view needs. */
type SkillsListEntry = {
  name: string;
  assignedTo?: string[];
  tags?: string[];
  category?: string;
};

async function SkillData({ id, name }: { id: string; name: string }) {
  let skill: LoadedSkill | null = null;
  let files: FileEntry[] = [];
  let skillsList: SkillsListEntry[] = [];

  try {
    // Three fetches in parallel — all three land in one round trip to
    // the data plane. The skills list carries `assignedTo` / `tags` /
    // `category` (via the SkillStore fast-path) that the /:name/content
    // endpoint currently omits; we merge client-side.
    const [skillRes, filesRes, skillsListRes] = await Promise.all([
      dataApi<{ ok: boolean; data: LoadedSkill }>(
        id,
        `/v1/skills/${encodeURIComponent(name)}/content`,
      ).catch(() => ({ ok: false, data: null as LoadedSkill | null })),
      dataApi<{ ok: boolean; data: { entries: FileEntry[] } }>(
        id,
        `/v1/files/list?path=${encodeURIComponent(`.polpo/skills/${name}`)}`,
      ).catch(() => ({ ok: false, data: { entries: [] as FileEntry[] } })),
      dataApi<{ ok: boolean; data: SkillsListEntry[] }>(
        id,
        `/v1/skills`,
      ).catch(() => ({ ok: false, data: [] as SkillsListEntry[] })),
    ]);
    skill = skillRes.data ?? null;
    files = filesRes.data?.entries ?? [];
    skillsList = skillsListRes.data ?? [];
  } catch {}

  return (
    <SkillDetailView
      initialSkill={skill}
      initialFiles={files}
      initialSkillsList={skillsList}
    />
  );
}

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const { id, name } = await params;

  return (
    <Suspense fallback={<SkillDetailSkeleton />}>
      <SkillData id={id} name={name} />
    </Suspense>
  );
}
