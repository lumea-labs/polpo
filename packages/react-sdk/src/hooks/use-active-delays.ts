import { useSyncExternalStore, useState, useEffect, useCallback } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type { ActiveDelay, AddMissionDelayRequest, UpdateMissionDelayRequest, Mission } from "@polpo-ai/sdk";

export interface UseActiveDelaysReturn {
  /** Active delays from SSE events (live, updated by delay:started/delay:expired). */
  activeDelays: ActiveDelay[];
  /** Active delays fetched from the server (initial load). */
  fetchedDelays: ActiveDelay[];
  /** Refetch from server. */
  refetch: () => void;
  loading: boolean;
  addDelay: (missionId: string, req: AddMissionDelayRequest) => Promise<Mission>;
  isAdding: boolean;
  updateDelay: (missionId: string, delayName: string, req: UpdateMissionDelayRequest) => Promise<Mission>;
  isUpdating: boolean;
  removeDelay: (missionId: string, delayName: string) => Promise<Mission>;
  isRemoving: boolean;
}

/**
 * Hook for accessing active delay timers.
 *
 * Combines two sources:
 * 1. SSE events (delay:started / delay:expired) → store.activeDelays (real-time)
 * 2. Initial fetch from GET /missions/delays (catches delays that started before SSE connected)
 *
 * Includes mutations: addDelay, updateDelay, removeDelay — each auto-refetches on success.
 */
export function useActiveDelays(): UseActiveDelaysReturn {
  const { client, store } = usePolpoContext();

  // Real-time from store (fed by SSE events via event-reducer)
  const storeDelays = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().activeDelays,
    () => store.getServerSnapshot().activeDelays,
  );

  const [fetchedDelays, setFetchedDelays] = useState<ActiveDelay[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchCount, setFetchCount] = useState(0);

  const refetch = useCallback(() => setFetchCount(c => c + 1), []);

  useEffect(() => {
    setLoading(true);
    client.listDelays()
      .then((delays) => {
        setFetchedDelays(delays);
        // Seed the store via proper setter (triggers notify → subscribers update)
        const next = new Map(store.getSnapshot().activeDelays);
        for (const d of delays) {
          next.set(`${d.group}:${d.delayName}`, d);
        }
        store.setActiveDelays(next);
      })
      .catch(() => { /* best-effort */ })
      .finally(() => setLoading(false));
  }, [client, store, fetchCount]);

  // Merge: store has real-time data, fetched fills in pre-existing delays
  const activeDelays = Array.from(storeDelays.values());

  const { mutate: addDelay, isPending: isAdding } = useMutation(
    useCallback(
      async (missionId: string, req: AddMissionDelayRequest) => {
        const result = await client.addMissionDelay(missionId, req);
        return result;
      },
      [client],
    ),
    { onSuccess: () => { refetch(); } },
  );

  const { mutate: updateDelay, isPending: isUpdating } = useMutation(
    useCallback(
      async (missionId: string, delayName: string, req: UpdateMissionDelayRequest) => {
        const result = await client.updateMissionDelay(missionId, delayName, req);
        return result;
      },
      [client],
    ),
    { onSuccess: () => { refetch(); } },
  );

  const { mutate: removeDelay, isPending: isRemoving } = useMutation(
    useCallback(
      async (missionId: string, delayName: string) => {
        const result = await client.removeMissionDelay(missionId, delayName);
        return result;
      },
      [client],
    ),
    { onSuccess: () => { refetch(); } },
  );

  return {
    activeDelays,
    fetchedDelays,
    refetch,
    loading,
    addDelay,
    isAdding,
    updateDelay,
    isUpdating,
    removeDelay,
    isRemoving,
  };
}
