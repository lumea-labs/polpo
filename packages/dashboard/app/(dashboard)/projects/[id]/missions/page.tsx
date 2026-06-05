import { Suspense } from "react";
import { dataApi } from "#/lib/api";
import type { Mission } from "@polpo-ai/core";
import { MissionsListSkeleton } from "#/components/dashboard/skeletons";
import MissionsView from "./view";

async function MissionsData({ id }: { id: string }) {
  let missions: Mission[] = [];
  try {
    const res = await dataApi<{ ok: boolean; data: Mission[] }>(
      id,
      "/v1/missions",
    );
    missions = res.data ?? [];
  } catch {}

  return <MissionsView initialMissions={missions} />;
}

export default async function MissionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<MissionsListSkeleton />}>
      <MissionsData id={id} />
    </Suspense>
  );
}
