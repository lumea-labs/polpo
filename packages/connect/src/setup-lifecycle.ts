import type { ConnectionSetupSession, ConnectionSetupStatus, ConnectionSetupOutcome, ConnectionSetupCompletionIntent, ConnectionRecord, ConnectionLink } from "./types.js";
import { matchesOAuthReconnect } from "./oauth-reconnect.js";

export function connectionSetupState(session: ConnectionSetupSession): NonNullable<ConnectionSetupSession["status"]> {
  return session.status ?? (session.consumedAt ? "started" : "pending");
}

export function canConsumeConnectionSetup(session: ConnectionSetupSession, at: string): boolean {
  return connectionSetupState(session) === "pending" && !session.consumedAt
    && Date.parse(session.expiresAt) > Date.parse(at);
}

export function finishConnectionSetup(session: ConnectionSetupSession, outcome: ConnectionSetupOutcome): ConnectionSetupSession | null {
  const status = connectionSetupState(session);
  if (status === "completed") return outcome.status === "completed" && session.resultingConnectionId === outcome.connectionId ? session : null;
  if (status === "error") return outcome.status === "error" ? session : null;
  if (status !== "started" || session.resultingConnectionId) return null;
  return { ...session, status: outcome.status, ...(outcome.status === "completed" ? { resultingConnectionId: outcome.connectionId } : {}) };
}

export function prepareConnectionSetupCompletion(session: ConnectionSetupSession, intent: ConnectionSetupCompletionIntent): ConnectionSetupSession | null {
  if (connectionSetupState(session) !== "started" || session.resultingConnectionId
    || intent.link.projectId !== session.projectId || intent.link.connectionId !== intent.connection.connectionId) return null;
  const previous = session.completionIntent;
  if (previous && (previous.connection.connectionId !== intent.connection.connectionId
    || previous.connection.authorizationFingerprint !== intent.connection.authorizationFingerprint
    || previous.link.id !== intent.link.id || previous.link.connectionId !== intent.link.connectionId
    || previous.link.projectId !== intent.link.projectId)) return null;
  return { ...session, completionIntent: intent };
}

export function reconcileConnectionSetup(session: ConnectionSetupSession, connection: ConnectionRecord | null, link: ConnectionLink | null): ConnectionSetupSession | null {
  const intent = session.completionIntent;
  if (connectionSetupState(session) !== "started" || !intent || !connection || !link
    || !matchesOAuthReconnect(connection, intent.connection) || link.status !== "active"
    || link.id !== intent.link.id || link.connectionId !== intent.connection.connectionId
    || link.projectId !== session.projectId || link.projectId !== intent.link.projectId) return null;
  return finishConnectionSetup(session, { status: "completed", connectionId: connection.id });
}

/** Public bearer-page projection. Never spread private setup context. */
export function projectConnectionSetupStatus(session: ConnectionSetupSession, now: Date): ConnectionSetupStatus {
  const state = connectionSetupState(session);
  const expiresAt = state === "started" ? session.authorizationExpiresAt ?? session.expiresAt : session.expiresAt;
  const status = (state === "pending" || state === "started") && !(Date.parse(expiresAt) > now.getTime()) ? "expired" : state;
  const raw = session.metadata?.application;
  const application = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  return {
    providerId: session.providerId, projectId: session.projectId, status, expiresAt,
    scopes: [...session.scopes], ...(session.consumedAt ? { consumedAt: session.consumedAt } : {}),
    ...(status === "completed" && session.resultingConnectionId ? { resultingConnectionId: session.resultingConnectionId } : {}),
    ...(typeof application?.name === "string" && application.name.trim() ? { application: {
      name: application.name.trim(),
      ...(typeof application.url === "string" && application.url.trim() ? { url: application.url.trim() } : {}),
    } } : {}),
  };
}
