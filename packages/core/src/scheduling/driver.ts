import type {
  Schedule,
  ScheduleDriverRegistration,
} from "./types.js";

/**
 * Delivery-provider lifecycle for a persisted schedule.
 *
 * Implementations register delivery only. A provider callback still has to
 * create and claim a durable ScheduleRun before any invocation is dispatched.
 */
export interface ScheduleDriver {
  register(schedule: Schedule): Promise<ScheduleDriverRegistration>;
  update(schedule: Schedule): Promise<ScheduleDriverRegistration>;
  pause(schedule: Schedule): Promise<void>;
  resume(schedule: Schedule): Promise<void>;
  delete(schedule: Schedule): Promise<void>;
}
