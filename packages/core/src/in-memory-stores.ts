/**
 * In-memory fallback stores (no Node.js deps).
 *
 * Used by MissionExecutor when the runtime doesn't provide the persistent
 * checkpoint/delay store ports on the OrchestratorContext.
 */

import type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
import type { DelayStore, DelayState } from "./delay-store.js";

export class InMemoryCheckpointStore implements CheckpointStore {
  private state: CheckpointState = { definitions: {}, active: {}, resumed: [] };
  async load(): Promise<CheckpointState> {
    return this.state;
  }
  async save(state: CheckpointState): Promise<void> {
    this.state = state;
  }
  async removeGroup(state: CheckpointState, group: string): Promise<CheckpointState> {
    delete state.definitions[group];
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(group + ":")) delete state.active[key];
    }
    state.resumed = state.resumed.filter(k => !k.startsWith(group + ":"));
    return state;
  }
}

export class InMemoryDelayStore implements DelayStore {
  private state: DelayState = { definitions: {}, active: {}, expired: [] };
  async load(): Promise<DelayState> {
    return this.state;
  }
  async save(state: DelayState): Promise<void> {
    this.state = state;
  }
  async removeGroup(state: DelayState, group: string): Promise<DelayState> {
    delete state.definitions[group];
    for (const key of Object.keys(state.active)) {
      if (key.startsWith(group + ":")) delete state.active[key];
    }
    state.expired = state.expired.filter(k => !k.startsWith(group + ":"));
    return state;
  }
}
