import type { ScheduleDispatcher } from "@polpo-ai/core/scheduling";
import type { LocalScheduleRunHandler } from "./local-schedule-driver.js";

/**
 * Connects the generic schedule dispatcher to the durable local worker.
 */
export function createLocalScheduleRunHandler(
  dispatcher: ScheduleDispatcher,
): LocalScheduleRunHandler {
  if (!dispatcher || typeof dispatcher.dispatch !== "function") {
    throw new Error("Local schedule run handler requires a dispatcher");
  }
  return ({ run, schedule, signal }) =>
    dispatcher.dispatch(run, schedule, { signal });
}
