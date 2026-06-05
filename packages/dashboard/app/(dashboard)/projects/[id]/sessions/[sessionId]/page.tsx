import { Suspense } from "react";
import { dataApi } from "@/lib/api";
import { SessionDetailSkeleton } from "@/components/dashboard/skeletons";
import SessionDetailView, {
  type Attachment,
  type Message,
  type Session,
} from "./view";

async function SessionData({ id, sessionId }: { id: string; sessionId: string }) {
  let session: Session | null = null;
  let messages: Message[] = [];
  let attachments: Attachment[] = [];

  const [detailRes, attachmentsRes] = await Promise.allSettled([
    dataApi<{ ok: boolean; data: { session: Session; messages: Message[] } }>(
      id,
      `/v1/chat/sessions/${sessionId}/messages`,
    ),
    dataApi<{ ok: boolean; data: Attachment[] }>(
      id,
      `/v1/attachments?sessionId=${sessionId}`,
    ),
  ]);
  if (detailRes.status === "fulfilled") {
    session = detailRes.value.data?.session ?? null;
    messages = detailRes.value.data?.messages ?? [];
  }
  if (attachmentsRes.status === "fulfilled") {
    attachments = attachmentsRes.value.data ?? [];
  }

  return (
    <SessionDetailView
      projectId={id}
      session={session}
      messages={messages}
      attachments={attachments}
    />
  );
}

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;

  return (
    <Suspense fallback={<SessionDetailSkeleton />}>
      <SessionData id={id} sessionId={sessionId} />
    </Suspense>
  );
}
