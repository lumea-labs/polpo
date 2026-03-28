import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type {
  SkillWithAssignment,
  CreateSkillRequest,
  InstallSkillsResult,
  InstallSkillsOptions,
} from "@polpo-ai/sdk";

export interface UseSkillsReturn {
  skills: SkillWithAssignment[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  createSkill: (req: CreateSkillRequest) => Promise<{ name: string; path: string }>;
  isCreating: boolean;
  installSkills: (source: string, opts?: InstallSkillsOptions) => Promise<InstallSkillsResult>;
  isInstalling: boolean;
  deleteSkill: (name: string) => Promise<void>;
  isDeleting: boolean;
  assignSkill: (skillName: string, agentName: string) => Promise<void>;
  isAssigning: boolean;
  unassignSkill: (skillName: string, agentName: string) => Promise<void>;
  isUnassigning: boolean;
}

/**
 * Fetch available project-level skills with agent assignment info.
 * Skills are not reactive (no SSE updates) — they're discovered on demand.
 */
export function useSkills(): UseSkillsReturn {
  const { client } = usePolpoContext();
  const [skills, setSkills] = useState<SkillWithAssignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch_ = useCallback(async () => {
    try {
      const data = await client.getSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    fetch_().finally(() => setIsLoading(false));
  }, [fetch_]);

  const { mutate: createSkill, isPending: isCreating } = useMutation(
    useCallback(
      (req: CreateSkillRequest) => client.createSkill(req),
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  const { mutate: installSkills, isPending: isInstalling } = useMutation(
    useCallback(
      (source: string, opts?: InstallSkillsOptions) => client.installSkills(source, opts),
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  const { mutate: deleteSkill_, isPending: isDeleting } = useMutation(
    useCallback(
      async (name: string) => { await client.deleteSkill(name); },
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  const { mutate: assignSkill_, isPending: isAssigning } = useMutation(
    useCallback(
      async (skillName: string, agentName: string) => {
        await client.assignSkill(skillName, agentName);
      },
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  const { mutate: unassignSkill_, isPending: isUnassigning } = useMutation(
    useCallback(
      async (skillName: string, agentName: string) => {
        await client.unassignSkill(skillName, agentName);
      },
      [client],
    ),
    { onSuccess: () => { fetch_(); } },
  );

  return {
    skills,
    isLoading,
    error,
    refetch: fetch_,
    createSkill,
    isCreating,
    installSkills,
    isInstalling,
    deleteSkill: deleteSkill_,
    isDeleting,
    assignSkill: assignSkill_,
    isAssigning,
    unassignSkill: unassignSkill_,
    isUnassigning,
  };
}
