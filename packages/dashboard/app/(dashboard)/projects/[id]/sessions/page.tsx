import { Suspense } from "react";
import { dataApi } from "#/lib/api";
import { SessionsListSkeleton } from "#/components/dashboard/skeletons";
import SessionsView, { type Session } from "./view";

async function SessionsData({ id }: { id: string }) {
  let sessions: Session[] = [];
  try {
    const res = await dataApi<{ ok: boolean; data: { sessions: Session[] } }>(
      id,
      "/v1/chat/sessions",
    );
    sessions = res.data?.sessions ?? [];
  } catch {}

  return <SessionsView initialSessions={sessions} />;
}

export default async function SessionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Suspense fallback={<SessionsListSkeleton />}>
      <SessionsData id={id} />
    </Suspense>
  );
}
