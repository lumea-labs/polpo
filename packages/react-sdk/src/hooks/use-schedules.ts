import { useCallback, useEffect, useState, useRef } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useEvents } from "./use-events.js";
import { useMutation } from "./use-mutation.js";
import type {
  ScheduleEntry,
  CreateScheduleRequest,
  UpdateScheduleRequest,
} from "@polpo-ai/sdk";

export interface UseSchedulesReturn {
  schedules: ScheduleEntry[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  createSchedule: (req: CreateScheduleRequest) => Promise<ScheduleEntry>;
  isCreating: boolean;
  updateSchedule: (missionId: string, req: UpdateScheduleRequest) => Promise<ScheduleEntry>;
  isUpdating: boolean;
  deleteSchedule: (missionId: string) => Promise<void>;
  isDeleting: boolean;
}

const SCHEDULE_EVENTS = ["schedule:created", "schedule:triggered", "schedule:completed"];

export function useSchedules(): UseSchedulesReturn {
  const { client } = usePolpoContext();
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSchedules = useCallback(async () => {
    try {
      const data = await client.getSchedules();
      setSchedules(data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  useEffect(() => {
    setIsLoading(true);
    fetchSchedules().finally(() => setIsLoading(false));
  }, [fetchSchedules]);

  // Auto-refetch on schedule SSE events
  const { events } = useEvents(SCHEDULE_EVENTS);
  const prevCountRef = useRef(events.length);
  useEffect(() => {
    if (events.length !== prevCountRef.current) {
      prevCountRef.current = events.length;
      fetchSchedules();
    }
  }, [events.length, fetchSchedules]);

  const { mutate: createSchedule, isPending: isCreating } = useMutation(
    useCallback(
      (req: CreateScheduleRequest) => client.createSchedule(req),
      [client],
    ),
    { onSuccess: () => { fetchSchedules(); } },
  );

  const { mutate: updateSchedule, isPending: isUpdating } = useMutation(
    useCallback(
      (missionId: string, req: UpdateScheduleRequest) => client.updateSchedule(missionId, req),
      [client],
    ),
    { onSuccess: () => { fetchSchedules(); } },
  );

  const { mutate: deleteSchedule_, isPending: isDeleting } = useMutation(
    useCallback(
      async (missionId: string) => { await client.deleteSchedule(missionId); },
      [client],
    ),
    { onSuccess: () => { fetchSchedules(); } },
  );

  return {
    schedules,
    isLoading,
    error,
    refetch: fetchSchedules,
    createSchedule,
    isCreating,
    updateSchedule,
    isUpdating,
    deleteSchedule: deleteSchedule_,
    isDeleting,
  };
}
