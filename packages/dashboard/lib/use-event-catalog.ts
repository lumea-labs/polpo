"use client";

import { useQuery } from "@tanstack/react-query";
import type { EventCatalogGroup } from "@polpo-ai/core";

/**
 * Fetches the event catalog from `/v1/events/catalog` (public, unauth).
 * The catalog is the source of truth for the webhook UI's event picker —
 * it lives in `@polpo-ai/core` and is served by the cloud control plane.
 *
 * Cached for 1h (matches the server's `Cache-Control: max-age=3600`):
 * the catalog only changes when a new Polpo runtime version ships.
 */
export type { EventCatalogGroup };

export function useEventCatalog() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return useQuery<EventCatalogGroup[]>({
    queryKey: ["events-catalog"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/v1/events/catalog`);
      if (!res.ok) throw new Error("Failed to load event catalog");
      const json = await res.json();
      return json.data?.groups ?? [];
    },
    staleTime: 60 * 60_000, // 1h — drift is acceptable
  });
}
