import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type { VaultEntryMeta } from "@polpo-ai/sdk";

export interface SaveVaultEntryRequest {
  agent: string;
  service: string;
  type: "smtp" | "imap" | "oauth" | "api_key" | "login" | "custom";
  credentials: Record<string, string>;
  label?: string;
}

export interface UseVaultEntriesReturn {
  entries: VaultEntryMeta[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  saveEntry: (req: SaveVaultEntryRequest) => Promise<{ agent: string; service: string; type: string; keys: string[] }>;
  isSaving: boolean;
  patchEntry: (agent: string, service: string, patch: { type?: string; label?: string; credentials?: Record<string, string> }) => Promise<{ agent: string; service: string; type: string; keys: string[] }>;
  isPatching: boolean;
  removeEntry: (agent: string, service: string) => Promise<{ removed: boolean }>;
  isRemoving: boolean;
}

/**
 * Fetch vault entry metadata for an agent (service names, types, credential key names).
 * Never exposes secret values — only field names with "***" masking.
 *
 * Includes mutations: saveEntry, patchEntry, removeEntry — each auto-refetches on success.
 */
export function useVaultEntries(agentName: string): UseVaultEntriesReturn {
  const { client } = usePolpoContext();
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    if (!agentName) {
      setEntries([]);
      return;
    }
    try {
      const data = await client.listVaultEntries(agentName);
      setEntries(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, agentName]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  const { mutate: saveEntry, isPending: isSaving } = useMutation(
    useCallback(
      async (req: SaveVaultEntryRequest) => {
        const result = await client.saveVaultEntry(req);
        return result;
      },
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  const { mutate: patchEntry, isPending: isPatching } = useMutation(
    useCallback(
      async (agent: string, service: string, patch: { type?: string; label?: string; credentials?: Record<string, string> }) => {
        const result = await client.patchVaultEntry(agent, service, patch);
        return result;
      },
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  const { mutate: removeEntry, isPending: isRemoving } = useMutation(
    useCallback(
      async (agent: string, service: string) => {
        const result = await client.removeVaultEntry(agent, service);
        return result;
      },
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  return {
    entries,
    isLoading,
    error,
    refetch: fetch_,
    saveEntry,
    isSaving,
    patchEntry,
    isPatching,
    removeEntry,
    isRemoving,
  };
}
