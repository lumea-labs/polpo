import { useEffect, useState, type ReactNode } from "react";
import { useStableValue } from "../hooks/use-stable-value.js";
import { PolpoClient } from "@polpo-ai/sdk";
import { EventSourceManager } from "@polpo-ai/sdk";
import type { PolpoClientConfig, ProjectEnvironment, SSEEvent } from "@polpo-ai/sdk";
import { PolpoStore } from "@polpo-ai/sdk";
import { PolpoContext } from "./polpo-context.js";

export interface PolpoProviderProps {
  baseUrl: string;
  /** @deprecated No longer used. Kept for backwards compatibility. */
  projectId?: string;
  apiKey?: string;
  /** Explicit target. Omit to use the environment bound to the credential/endpoint. */
  environment?: ProjectEnvironment;
  /**
   * Override the fetch implementation used by the underlying `PolpoClient`.
   * Useful for cookie-auth scenarios (`credentials: "include"`), request
   * logging/tracing, injecting custom headers, retry middleware, or mocking
   * in tests.
   *
   * If omitted, the default uses `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Override the API path prefix. Defaults to `/v1` for `*.polpo.sh` /
   * `*.polpo.cloud`, `/api/v1` otherwise. Set explicitly when the request
   * target is a proxy (e.g. a session-auth dashboard proxy that already
   * includes the full `/v1/...` path downstream).
   */
  apiPrefix?: string;
  /**
   * Default end-user identifier (OpenAI-compat `user`). When set, every
   * SDK call (`chatCompletions`, `createTask`, `createMission`) will carry
   * it as default — pass per-call `user` to override.
   *
   * Wire this from your auth provider (Supabase, Clerk, NextAuth) so the
   * Polpo client always knows which end-user is acting:
   *
   * ```tsx
   * const { user } = useSupabaseUser();
   * <PolpoProvider baseUrl={...} apiKey={...} user={user?.id}>
   * ```
   *
   * Updates propagate without rebuilding the client — only the default value
   * changes, so React Query caches and SSE connections stay alive.
   */
  user?: string;
  children: ReactNode;
  autoConnect?: boolean;
  eventFilter?: string[];
}

export function PolpoProvider({
  baseUrl,
  apiKey,
  environment,
  fetch,
  apiPrefix,
  user,
  children,
  autoConnect = true,
  eventFilter,
}: PolpoProviderProps) {
  const config = { baseUrl, apiKey, environment, fetch, apiPrefix, user };
  const [scope, setScope] = useState(() => createScope(config, 0));
  // Adjust during render so React retries before rendering children with a
  // mismatched client. A keyed boundary also resets hook-local sessions,
  // drafts and pending mutations, which are not held in PolpoStore.
  // User changes deliberately retain the current scope for compatibility.
  if (scope.config.baseUrl !== baseUrl || scope.config.apiKey !== apiKey
    || scope.config.environment !== environment || scope.config.fetch !== fetch
    || scope.config.apiPrefix !== apiPrefix) {
    setScope(createScope(config, scope.generation + 1));
  }

  const { client, store } = scope.value;
  const stableEventFilter = useStableValue(eventFilter);

  // Sync the default user without rebuilding the client. Cheap; no-op when
  // unchanged. Lets a chat session survive a token-refresh round-trip.
  useEffect(() => {
    client.setUser(user);
  }, [client, user]);

  // SSE connection lifecycle
  useEffect(() => {
    if (!autoConnect) return;

    let active = true;
    let pendingEvents: SSEEvent[] = [];
    let batchScheduled = false;

    const flushBatch = () => {
      if (!active) return;
      if (pendingEvents.length > 0) {
        store.applyEventBatch(pendingEvents);
        pendingEvents = [];
      }
      batchScheduled = false;
    };

    const es = new EventSourceManager({
      url: client.getEventsUrl(stableEventFilter),
      onEvent: (event) => {
        if (!active) return;
        pendingEvents.push(event);
        if (!batchScheduled) {
          batchScheduled = true;
          queueMicrotask(flushBatch);
        }
      },
      onStatusChange: (status) => {
        if (!active) return;
        store.setConnectionStatus(status);
        if (status === "connected") {
          // Re-fetch all resources to fill any SSE gaps
          Promise.all([
            client.getTasks().then((t) => { if (active) store.setTasks(t); }),
            client.getMissions().then((m) => { if (active) store.setMissions(m); }),
            client.getAgents().then((a) => { if (active) store.setAgents(a); }),
            client.getProcesses().then((p) => { if (active) store.setProcesses(p); }),
          ]).catch(() => {
            /* individual errors handled by hooks */
          });
        }
      },
    });

    es.connect();
    return () => {
      active = false;
      pendingEvents = [];
      es.disconnect();
    };
  }, [client, store, autoConnect, stableEventFilter]);

  return (
    <PolpoContext.Provider key={scope.generation} value={scope.value}>
      {children}
    </PolpoContext.Provider>
  );
}

function createScope(config: PolpoClientConfig, generation: number) {
  return {
    config,
    generation,
    value: { client: new PolpoClient(config), store: new PolpoStore() },
  };
}
