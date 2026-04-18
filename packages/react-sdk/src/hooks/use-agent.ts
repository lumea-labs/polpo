import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type { AgentConfig } from "@polpo-ai/sdk";

export interface UseAgentReturn {
  agent: AgentConfig | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch a single agent by name from the `/agents/:name` endpoint.
 *
 * Pass `undefined` or `null` when the name is not yet known (e.g. a session
 * without an associated agent, or data still loading) and the hook will
 * no-op — no HTTP request, no spurious 404s. Previously consumers had
 * to invent sentinel strings like `"__none__"` to avoid the call; that
 * pattern is no longer necessary.
 */
export function useAgent(name: string | undefined | null): UseAgentReturn {
  const { client } = usePolpoContext();
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [isLoading, setIsLoading] = useState(!!name);
  const [error, setError] = useState<Error | null>(null);

  const fetchAgent = useCallback(async () => {
    if (!name) return;
    try {
      setError(null);
      const data = await client.getAgent(name);
      setAgent(data);
    } catch (err) {
      setError(err as Error);
      setAgent(null);
    }
  }, [client, name]);

  useEffect(() => {
    if (!name) {
      setAgent(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    fetchAgent().finally(() => setIsLoading(false));
  }, [fetchAgent, name]);

  return { agent, isLoading, error, refetch: fetchAgent };
}
