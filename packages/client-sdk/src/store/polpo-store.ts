import { mergeSessionTitle, isSessionTitleSnapshot } from "./session-titles.js";
import { activeDelayKey } from "../client/mission-runtime.js";
import type {
  ActiveDelay,
  Task,
  Mission,
  AgentConfig,
  AgentProcess,
  ChatSession,
  SSEEvent,
} from "../client/types.js";
import type { ConnectionStatus } from "../client/event-source.js";
import type { StoreState } from "./types.js";
import { reduceEvent } from "./event-reducer.js";

export type { StoreState, PolpoStats } from "./types.js";

function createInitialState(): StoreState {
  return {
    tasks: new Map(),
    missions: new Map(),
    missionReports: new Map(),
    agents: [],
    processes: [],
    stats: null,
    connectionStatus: "disconnected",
    recentEvents: [],
    runtimePlans: new Map(),
    missionsStale: false,
    memory: null,
    agentMemory: new Map(),
    assessmentProgress: new Map(),
    assessmentChecks: new Map(),
    activeDelays: new Map(),
    sessions: new Map(),
  };
}

const SERVER_SNAPSHOT = createInitialState();

export class PolpoStore {
  private state: StoreState;
  private listeners = new Set<() => void>();
  private delaySnapshotSequence = 0;
  private appliedDelaySnapshot = 0;
  private eventListeners = new Set<(events: readonly SSEEvent[]) => void>();

  constructor() {
    this.state = createInitialState();
  }

  // ── useSyncExternalStore interface ──────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Observe every applied event, including batches larger than the diagnostic buffer. */
  private subscribeEvents = (listener: (events: readonly SSEEvent[]) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  };

  getSnapshot = (): StoreState => {
    return this.state;
  };

  getServerSnapshot = (): StoreState => {
    return SERVER_SNAPSHOT;
  };

  // ── Bulk setters (from REST initial fetch) ─────────────────

  setTasks(tasks: Task[]): void {
    // Avoid creating a new Map (and breaking selector cache) when the
    // task list hasn't actually changed.  Two concurrent useTasks() hooks
    // (e.g. agent-detail page + chat sidebar) each fire an initial fetch;
    // without this guard the second setTasks creates a new Map reference,
    // which causes a selectTasks cache miss → new array → useSyncExternalStore
    // re-render → useEffect re-fires → infinite loop.
    const prev = this.state.tasks;
    if (prev.size === tasks.length && tasks.every((t) => prev.get(t.id) === t)) {
      return;
    }
    this.state = {
      ...this.state,
      tasks: new Map(tasks.map((t) => [t.id, t])),
    };
    this.notify();
  }

  setMissions(missions: Mission[]): void {
    const prev = this.state.missions;
    if (prev.size === missions.length && missions.every((m) => prev.get(m.id) === m)) {
      if (!this.state.missionsStale) return;
    }
    this.state = {
      ...this.state,
      missions: new Map(missions.map((m) => [m.id, m])),
      missionsStale: false,
    };
    this.notify();
  }

  /** Upsert a single mission into the store without replacing the entire map. */
  upsertMission(mission: Mission): void {
    const prev = this.state.missions.get(mission.id);
    // Skip if the object is referentially identical (no change)
    if (prev === mission) return;
    const missions = new Map(this.state.missions);
    missions.set(mission.id, mission);
    this.state = { ...this.state, missions };
    this.notify();
  }

  setAgents(agents: AgentConfig[]): void {
    const prev = this.state.agents;
    if (prev.length === agents.length && agents.every((a, i) => prev[i] === a)) {
      return;
    }
    this.state = { ...this.state, agents };
    this.notify();
  }

  setProcesses(processes: AgentProcess[]): void {
    const prev = this.state.processes;
    if (
      prev.length === processes.length &&
      processes.every((p, i) => prev[i] === p)
    ) {
      return;
    }
    this.state = { ...this.state, processes };
    this.notify();
  }

  setConnectionStatus(status: ConnectionStatus): void {
    this.state = { ...this.state, connectionStatus: status };
    this.notify();
  }

  setMemory(memory: { exists: boolean; content: string } | null): void {
    this.state = { ...this.state, memory };
    this.notify();
  }

  setAgentMemory(agentName: string, memory: { exists: boolean; content: string }): void {
    const agentMemory = new Map(this.state.agentMemory);
    agentMemory.set(agentName, memory);
    this.state = { ...this.state, agentMemory };
    this.notify();
  }

  setActiveDelays(delays: Map<string, ActiveDelay>): void {
    this.appliedDelaySnapshot = ++this.delaySnapshotSequence;
    this.state = { ...this.state, activeDelays: delays };
    this.notify();
  }

  /** Start an HTTP delay snapshot. Newer committed snapshots win across all
   * consumers of this store, while events received in flight retain precedence. */
  beginActiveDelaysFetch(): { commit(delays: ActiveDelay[]): boolean; dispose(): void } {
    const sequence = ++this.delaySnapshotSequence;
    const changed = new Set<string>();
    let disposed = false;
    const unsubscribe = this.subscribeEvents(events => {
      for (const event of events) {
        if (event.event === "delay:started" || event.event === "delay:expired") {
          changed.add(activeDelayKey(event.data as ActiveDelay));
        }
      }
    });
    const dispose = () => { disposed = true; unsubscribe(); };
    return {
      dispose,
      commit: delays => {
        if (disposed || sequence < this.appliedDelaySnapshot) { dispose(); return false; }
        const next = new Map(delays.map(delay => [activeDelayKey(delay), delay]));
        for (const key of changed) {
          const live = this.state.activeDelays.get(key);
          if (live) next.set(key, live);
          else next.delete(key);
        }
        dispose();
        this.appliedDelaySnapshot = sequence;
        this.state = { ...this.state, activeDelays: next };
        this.notify();
        return true;
      },
    };
  }

  // ── Sessions (issue #41) ────────────────────────────────────
  // Sessions live in the store so any consumer of `useSessions()` reflects
  // changes coming from elsewhere — most importantly, a new session created
  // mid-stream by `useChat`'s first message. Mirrors the tasks/missions
  // pattern exactly.

  setSessions(sessions: ChatSession[]): void {
    const prev = this.state.sessions;
    if (prev.size === sessions.length && sessions.every((s) => prev.get(s.id) === s)) {
      return;
    }
    this.state = {
      ...this.state,
      sessions: new Map(sessions.map((s) => [s.id, mergeSessionTitle(mergeSessionTitle(prev.get(s.id), s), this.state.sessionTitleUpdates?.get(s.id) ?? {})])),
    };
    this.notify();
  }

  /** Insert or replace a single session. Used by `useChat` when it observes
   *  a new `sessionId` arriving in the stream, and by SSE `session:started`. */
  upsertSession(session: ChatSession): void {
    const prev = this.state.sessions.get(session.id);
    if (prev === session) return;
    const sessions = new Map(this.state.sessions);
    sessions.set(session.id, mergeSessionTitle(mergeSessionTitle(prev, session), this.state.sessionTitleUpdates?.get(session.id) ?? {}));
    this.state = { ...this.state, sessions };
    this.notify();
  }

  /** Patch a session in place (e.g. on rename / messageCount bump). */
  patchSession(sessionId: string, patch: Partial<ChatSession>): void {
    const prev = this.state.sessions.get(sessionId);
    if (!prev) return;
    const merged = mergeSessionTitle(prev, { ...patch, id: prev.id });
    const sessions = new Map(this.state.sessions);
    sessions.set(sessionId, merged);
    this.state = { ...this.state, sessions };
    this.notify();
  }

  patchSessionTitle(snapshot: import("../client/types.js").SessionTitleSnapshot): void {
    if (!isSessionTitleSnapshot(snapshot)) return;
    this.applyEvent({ event: "session:updated", data: { session: snapshot }, id: `title-${snapshot.id}-${snapshot.titleRevision}`, timestamp: snapshot.titleUpdatedAt });
  }

  removeSession(sessionId: string): void {
    if (!this.state.sessions.has(sessionId)) return;
    const sessions = new Map(this.state.sessions);
    sessions.delete(sessionId);
    const sessionTitleUpdates = new Map(this.state.sessionTitleUpdates); sessionTitleUpdates.delete(sessionId);
    this.state = { ...this.state, sessions, sessionTitleUpdates };
    this.notify();
  }

  // ── SSE event application ──────────────────────────────────

  applyEvent(event: SSEEvent): void {
    const next = reduceEvent(this.state, event);
    if (next !== this.state) {
      this.state = next;
      for (const listener of this.eventListeners) listener([event]);
      this.notify();
    }
  }

  applyEventBatch(events: SSEEvent[]): void {
    let current = this.state;
    for (const event of events) {
      current = reduceEvent(current, event);
    }
    if (current !== this.state) {
      this.state = current;
      for (const listener of this.eventListeners) listener(events);
      this.notify();
    }
  }

  // ── Notification ───────────────────────────────────────────

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
