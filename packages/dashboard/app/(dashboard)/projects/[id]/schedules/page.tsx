import { Suspense } from "react";
import { dataApi } from "@/lib/api";
import type { Mission, ScheduleEntry } from "@polpo-ai/core";
import { SchedulesListSkeleton } from "@/components/dashboard/skeletons";
import SchedulesView from "./view";

async function SchedulesData({ id }: { id: string }) {
  // Fetch schedules + missions in parallel so the join in the view is
  // hydrated on first paint. Both endpoints are cheap (no per-row joins
  // in the data plane), so the parallel cost is the slowest of the two.
  let schedules: ScheduleEntry[] = [];
  let missions: Mission[] = [];

  try {
    const [schedRes, missionRes] = await Promise.all([
      dataApi<{ ok: boolean; data: ScheduleEntry[] }>(id, "/v1/schedules").catch(
        () => ({ ok: false, data: [] as ScheduleEntry[] }),
      ),
      dataApi<{ ok: boolean; data: Mission[] }>(id, "/v1/missions").catch(
        () => ({ ok: false, data: [] as Mission[] }),
      ),
    ]);
    schedules = schedRes.data ?? [];
    missions = missionRes.data ?? [];
  } catch {
    // Fail open — render empty state rather than 500.
  }

  return <SchedulesView initialSchedules={schedules} initialMissions={missions} />;
}

export default async function SchedulesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<SchedulesListSkeleton />}>
      <SchedulesData id={id} />
    </Suspense>
  );
}
