import type {
  Schedule,
  ScheduleDriverRegistration,
} from "./types.js";

export type ScheduleDriverLifecycleResult =
  | ScheduleDriverRegistration
  | void;

/**
 * Delivery-provider lifecycle for a persisted schedule.
 *
 * Implementations register delivery only. A provider callback still has to
 * create and claim a durable ScheduleRun before any invocation is dispatched.
 *
 * Lifecycle methods may return an updated registration when the provider
 * resource changes as part of the operation. Drivers that keep the same
 * provider resource can continue returning void.
 */
export interface ScheduleDriver {
  register(schedule: Schedule): Promise<ScheduleDriverRegistration>;
  update(schedule: Schedule): Promise<ScheduleDriverRegistration>;
  pause(schedule: Schedule): Promise<ScheduleDriverLifecycleResult>;
  resume(schedule: Schedule): Promise<ScheduleDriverLifecycleResult>;
  delete(schedule: Schedule): Promise<ScheduleDriverLifecycleResult>;
}
