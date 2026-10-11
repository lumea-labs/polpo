import type { ActiveDelay } from "./types.js";

/** Opaque client store key, shared by HTTP hydration and SSE updates. */
export function activeDelayKey(identity: Pick<ActiveDelay, "executionId" | "group" | "delayName">): string {
  return JSON.stringify([identity.executionId ? "execution" : "group", identity.executionId ?? identity.group, identity.delayName]);
}
