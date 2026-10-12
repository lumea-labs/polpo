import {
  ConnectError,
  connectionSetupState,
  projectConnectionSetupStatus,
  type ConnectionSetupSessionStore,
  type ConnectionSetupStatus,
} from "@polpo-ai/connect";

function setupToken(id: string): string {
  if (typeof id !== "string" || !id.trim()) throw new ConnectError("invalid_request", "setupSessionId is required");
  return id.trim();
}

/** Storage-neutral orchestration; hosts remain responsible for endpoint authorization. */
export async function observeConnectionSetupSession(
  store: ConnectionSetupSessionStore, id: string, now: () => Date = () => new Date(),
): Promise<ConnectionSetupStatus | null> {
  let session = await store.getConnectionSetupSession(setupToken(id));
  if (session && connectionSetupState(session) === "started" && session.completionIntent && store.reconcileConnectionSetupSession) {
    session = await store.reconcileConnectionSetupSession(session.reference ?? session.id) ?? session;
  }
  return session ? projectConnectionSetupStatus(session, now()) : null;
}

export async function cancelConnectionSetupSession(
  store: ConnectionSetupSessionStore, id: string, now: () => Date = () => new Date(),
): Promise<ConnectionSetupStatus | null> {
  if (!store.cancelConnectionSetupSession) throw new ConnectError("setup_invalid", "Connection setup cancellation is not configured on this host");
  const token = setupToken(id);
  const session = await store.getConnectionSetupSession(token);
  if (!session) return null;
  const current = projectConnectionSetupStatus(session, now());
  if (current.status === "cancelled") return current;
  if (current.status === "pending") {
    const cancelled = await store.cancelConnectionSetupSession(token, now().toISOString());
    if (cancelled) return projectConnectionSetupStatus(cancelled, now());
    // Two cancellations are idempotent. A concurrent start cannot be undone.
    const winner = await store.getConnectionSetupSession(token);
    if (winner && connectionSetupState(winner) === "cancelled") return projectConnectionSetupStatus(winner, now());
  }
  throw new ConnectError("setup_consumed", "Connection setup can no longer be cancelled", { status: 410 });
}
