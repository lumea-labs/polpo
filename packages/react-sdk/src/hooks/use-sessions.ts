import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { selectSessions } from "@polpo-ai/sdk";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { ChatSession, ChatMessage } from "@polpo-ai/sdk";

export interface UseSessionsReturn {
  sessions: ChatSession[];
  isLoading: boolean;
  error: Error | null;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  getMessages: (sessionId: string) => Promise<ChatMessage[]>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Reads sessions from the shared `PolpoStore`. The initial list is fetched
 * lazily (first hook mount populates the store), and any change pushed by
 * other hooks — most importantly `useChat` observing a new sessionId
 * mid-stream — is reflected here automatically. Mirrors `useTasks` /
 * `useMissions`.
 *
 * Fixes #41: before this rewrite, each `useSessions()` instance held its
 * own `useState` array, so creating a session in one component left every
 * other consumer stale until a manual refetch.
 */
export function useSessions(): UseSessionsReturn {
  const { client, store } = usePolpoContext();

  const sessions = useSyncExternalStore(
    store.subscribe,
    () => selectSessions(store.getSnapshot()),
    () => selectSessions(store.getServerSnapshot()),
  );

  const [isLoading, setIsLoading] = useState(store.getSnapshot().sessions.size === 0);
  const [error, setError] = useState<Error | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const data = await client.getSessions();
      store.setSessions(data.sessions);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, store]);

  // Initial fetch — only the first mount populates the store; subsequent
  // hook instances reuse the same data.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    refetch().finally(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [refetch]);

  const pendingTitleIds = JSON.stringify(sessions.filter(session => session.titleGenerationStatus === "pending").map(session => session.id).sort());
  useEffect(() => {
    const stops = (JSON.parse(pendingTitleIds) as string[]).map(id => client.watchSessionTitle(id, session => store.patchSession(id, session)));
    return () => stops.forEach(stop => stop());
  }, [client, store, pendingTitleIds]);

  const getMessages = useCallback(
    async (sessionId: string) => {
      const data = await client.getSessionMessages(sessionId);
      return data.messages;
    },
    [client],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      try {
        const result = await client.renameSession(sessionId, title);
        if (result.session) store.patchSessionTitle(result.session);
        else store.patchSession(sessionId, { title, updatedAt: new Date().toISOString() });
      } catch (error) {
        try { store.patchSession(sessionId, await client.getSessionMetadata(sessionId)); } catch { /* Preserve the original rename error. */ }
        throw error;
      }
    },
    [client, store],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await client.deleteSession(sessionId);
      store.removeSession(sessionId);
      if (activeSessionId === sessionId) {
        setActiveSessionId(null);
      }
    },
    [client, store, activeSessionId],
  );

  return {
    sessions,
    isLoading,
    error,
    activeSessionId,
    setActiveSessionId,
    getMessages,
    renameSession,
    deleteSession,
    refetch,
  };
}
