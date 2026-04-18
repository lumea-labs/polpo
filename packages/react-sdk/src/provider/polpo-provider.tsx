import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useStableValue } from "../hooks/use-stable-value.js";
import { PolpoClient } from "@polpo-ai/sdk";
import { EventSourceManager } from "@polpo-ai/sdk";
import type { SSEEvent } from "@polpo-ai/sdk";
import { PolpoStore } from "@polpo-ai/sdk";
import { PolpoContext } from "./polpo-context.js";

export interface PolpoProviderProps {
  baseUrl: string;
  /** @deprecated No longer used. Kept for backwards compatibility. */
  projectId?: string;
  apiKey?: string;
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
  children: ReactNode;
  autoConnect?: boolean;
  eventFilter?: string[];
}

export function PolpoProvider({
  baseUrl,
  apiKey,
  fetch,
  apiPrefix,
  children,
  autoConnect = true,
  eventFilter,
}: PolpoProviderProps) {
  // Config key includes fetch identity + apiPrefix so that swapping either
  // rebuilds the client (same reasoning as baseUrl/apiKey today).
  const configKey = `${baseUrl}|${apiKey ?? ""}|${apiPrefix ?? ""}|${fetch ? "custom-fetch" : "default-fetch"}`;
  const storeRef = useRef<PolpoStore>(null as unknown as PolpoStore);
  const clientRef = useRef<PolpoClient>(null as unknown as PolpoClient);
  const lastConfigKey = useRef("");

  if (lastConfigKey.current !== configKey) {
    lastConfigKey.current = configKey;
    clientRef.current = new PolpoClient({ baseUrl, apiKey, fetch, apiPrefix });
    storeRef.current = new PolpoStore();
  }

  const client = clientRef.current!;
  const store = storeRef.current!;
  const stableEventFilter = useStableValue(eventFilter);

  // SSE connection lifecycle
  useEffect(() => {
    if (!autoConnect) return;

    let pendingEvents: SSEEvent[] = [];
    let batchScheduled = false;

    const flushBatch = () => {
      if (pendingEvents.length > 0) {
        store.applyEventBatch(pendingEvents);
        pendingEvents = [];
      }
      batchScheduled = false;
    };

    const es = new EventSourceManager({
      url: client.getEventsUrl(stableEventFilter),
      onEvent: (event) => {
        pendingEvents.push(event);
        if (!batchScheduled) {
          batchScheduled = true;
          queueMicrotask(flushBatch);
        }
      },
      onStatusChange: (status) => {
        store.setConnectionStatus(status);
        if (status === "connected") {
          // Re-fetch all resources to fill any SSE gaps
          Promise.all([
            client.getTasks().then((t) => store.setTasks(t)),
            client.getMissions().then((m) => store.setMissions(m)),
            client.getAgents().then((a) => store.setAgents(a)),
            client.getProcesses().then((p) => store.setProcesses(p)),
          ]).catch(() => {
            /* individual errors handled by hooks */
          });
        }
      },
    });

    es.connect();
    return () => es.disconnect();
  }, [configKey, autoConnect, stableEventFilter]);

  const value = useMemo(() => ({ client, store }), [client, store]);

  return (
    <PolpoContext.Provider value={value}>
      {children}
    </PolpoContext.Provider>
  );
}
