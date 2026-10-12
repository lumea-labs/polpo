import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConnectError, type StoredConnectionSecret } from "@polpo-ai/connect";
import { isVersionedConnectionSecretStore, type ConnectionSecretStore, type VersionedConnectionSecret } from "./secrets.js";

// Private encrypted material only. Never Connection metadata or a public DTO.
const KEY = "polpo:oauth-refresh:v1";
const unavailable = () => new ConnectError("refresh_unavailable",
  "Connection refresh is in progress or its outcome is uncertain; retry later or reconnect the account", { status: 503 });

export function hasPendingRefresh(secret: StoredConnectionSecret): boolean {
  const state = secret.metadata?.[KEY];
  if (state === undefined) return false;
  if (!state || typeof state !== "object" || Array.isArray(state)) return true;
  const record = state as Record<string, unknown>;
  return record.status !== "completed" || typeof record.id !== "string" || !record.id
    || typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt))
    || typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt));
}

export function assertRefreshAvailable(secret: StoredConnectionSecret): void {
  if (hasPendingRefresh(secret)) throw unavailable();
}

/** Persist intent BEFORE consuming a potentially single-use refresh token.
 * A coordinator lease is an optimization: CAS is the durable exclusion fence.
 * An uncertain provider outcome remains pending until reconnection; guessing a
 * retry could invalidate the only refresh-token lineage we still possess.
 * Unversioned single-process stores retain their existing coordinator contract.
 */
export async function refreshConnectionSecret(input: {
  store: ConnectionSecretStore;
  ref: string;
  previous: StoredConnectionSecret;
  snapshot?: VersionedConnectionSecret | null;
  now: () => Date;
  /** Authorization and local metadata only; must never send a token to a provider. */
  beforeRefresh?: () => Promise<void>;
  refresh: () => Promise<StoredConnectionSecret>;
}): Promise<StoredConnectionSecret> {
  assertRefreshAvailable(input.previous);
  const store = input.store;
  if (!isVersionedConnectionSecretStore(store)) {
    await input.beforeRefresh?.();
    const refreshed = await input.refresh();
    await store.setSecret(input.ref, refreshed);
    return refreshed;
  }
  if (!input.snapshot) throw unavailable();
  const id = randomUUID();
  const startedAt = input.now().toISOString();
  const pending: StoredConnectionSecret = { ...input.previous, metadata: { ...input.previous.metadata,
    [KEY]: { id, status: "pending", startedAt } } };
  let claimed: boolean | undefined;
  try { claimed = await store.compareAndSet(input.ref, input.snapshot.version, pending); }
  catch { /* An acknowledgement can be lost after the durable write. */ }
  if (claimed === false) throw unavailable();
  const claim = await store.getVersioned(input.ref);
  if (!claim || !sameSecret(claim.secret, pending)) throw unavailable();

  try { await input.beforeRefresh?.(); }
  catch (error) {
    // No provider dispatch has occurred. Restore only the exact intent we own;
    // never overwrite a reconnect, revocation or another credential generation.
    // If storage cannot confirm restoration, retain the conservative fence.
    await store.compareAndSet(input.ref, claim.version, input.previous).catch(() => false);
    throw error;
  }

  // Do not clear a pending intent on provider error or process death: we cannot
  // know whether a single-use token was consumed before the response was lost.
  const result = await input.refresh();
  const completed: StoredConnectionSecret = { ...result, metadata: { ...result.metadata,
    [KEY]: { id, status: "completed", startedAt, completedAt: input.now().toISOString() } } };
  try {
    if (await store.compareAndSet(input.ref, claim.version, completed)) return completed;
  } catch { /* Recover only our exact committed result, never another writer. */ }
  const persisted = await store.getVersioned(input.ref);
  if (persisted && sameSecret(persisted.secret, completed)) return persisted.secret;
  throw unavailable();
}

function sameSecret(left: StoredConnectionSecret, right: StoredConnectionSecret): boolean {
  // JSON stores omit undefined fields and may reorder object properties.
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}
