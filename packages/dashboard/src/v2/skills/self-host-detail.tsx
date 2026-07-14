"use client";

import { useQuery } from "@tanstack/react-query";
import { useDashboardHost } from "../../host.js";
import { usePolpoClient } from "../host.js";
import { PageBody } from "../ui/page-header.js";
import {
  SkillDetail,
  type FileEntry,
  type LoadedSkill,
  type SkillsListEntry,
} from "../views/skills-detail.js";

export function SelfHostSkillDetailView({ name }: { name: string }) {
  const host = useDashboardHost();
  const polpo = usePolpoClient(host.project.id);
  const { data, isLoading } = useQuery({
    queryKey: ["skill-detail-bootstrap", host.project.id, name],
    queryFn: async () => {
      const [skill, files, skills] = await Promise.all([
        polpo.getSkillContent(name) as unknown as Promise<LoadedSkill>,
        polpo.listFiles(`.polpo/skills/${name}`).catch(() => ({ entries: [] })),
        polpo.getSkills() as unknown as Promise<SkillsListEntry[]>,
      ]);
      return {
        skill,
        files: files.entries as FileEntry[],
        skills,
      };
    },
  });

  if (isLoading) {
    return (
      <PageBody>
        <div className="space-y-5">
          <div className="h-4 w-20 animate-pulse rounded bg-muted" />
          <div className="h-16 w-full animate-pulse rounded-lg bg-muted" />
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <div className="h-96 animate-pulse rounded-lg bg-muted" />
            <div className="h-72 animate-pulse rounded-lg bg-muted" />
          </div>
        </div>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <SkillDetail
        initialSkill={data?.skill ?? null}
        initialFiles={data?.files ?? []}
        initialSkillsList={data?.skills ?? []}
      />
    </PageBody>
  );
}
