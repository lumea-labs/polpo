import type { ChatSession, SessionTitleSnapshot } from "../client/types.js";

const fields = ["title", "titleSource", "titleRevision", "titleUpdatedAt", "titleGenerationStatus"] as const;

/** Transcript/activity fields can advance independently of the title revision. */
export function mergeSessionTitle(previous: ChatSession | undefined, incoming: Partial<ChatSession>): ChatSession {
  const result = { ...previous, ...incoming } as ChatSession;
  if (previous?.titleRevision !== undefined && (incoming.titleRevision === undefined || incoming.titleRevision < previous.titleRevision)) {
    for (const field of fields) (result as unknown as Record<string, unknown>)[field] = previous[field];
  }
  return result;
}

export function isSessionTitleSnapshot(value: unknown): value is SessionTitleSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as SessionTitleSnapshot;
  return typeof v.id === "string" && Boolean(v.id) && Number.isSafeInteger(v.titleRevision) && v.titleRevision >= 0
    && ["provisional", "generated", "manual", "legacy"].includes(v.titleSource)
    && ["pending", "completed", "failed", "skipped"].includes(v.titleGenerationStatus)
    && typeof v.titleUpdatedAt === "string" && (v.title === undefined || typeof v.title === "string");
}
