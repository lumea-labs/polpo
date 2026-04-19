import type { SSEEvent } from "./types.js";

/**
 * All Polpo SSE event types — must stay in sync with server-side ALL_EVENTS
 * in src/server/sse-bridge.ts. The EventSource API requires explicit
 * addEventListener() calls for each named event type; `onmessage` only
 * receives unnamed events.
 */
const ALL_SSE_EVENTS = [
  // Task lifecycle
  "task:created", "task:transition", "task:updated", "task:removed",
  // Agent lifecycle
  "agent:spawned", "agent:finished", "agent:activity",
  // Assessment pipeline
  "assessment:started", "assessment:progress", "assessment:check:started",
  "assessment:check:complete", "assessment:complete", "assessment:corrected",
  // Orchestrator lifecycle
  "orchestrator:started", "orchestrator:tick", "orchestrator:deadlock", "orchestrator:shutdown",
  // Retry & Fix
  "task:retry", "task:retry:blocked", "task:fix", "task:maxRetries",
  // Question detection
  "task:question", "task:answered",
  // Deadlock resolution
  "deadlock:detected", "deadlock:resolving", "deadlock:resolved", "deadlock:unresolvable",
  // Resilience
  "task:timeout", "agent:stale",
  // Recovery
  "task:recovered",
  // Missions
  "mission:saved", "mission:executed", "mission:completed", "mission:resumed", "mission:deleted",
  // Chat sessions
  "session:created", "message:added",
  // Approval gates
  "approval:requested", "approval:resolved", "approval:rejected", "approval:timeout",
  // Escalation
  "escalation:triggered", "escalation:resolved", "escalation:human",
  // SLA & Deadlines
  "sla:warning", "sla:violated", "sla:met",
  // Checkpoints (mission-level)
  "checkpoint:reached", "checkpoint:resumed",
  // Delays (mission-level)
  "delay:started", "delay:expired",
  // Quality gates
  "quality:gate:passed", "quality:gate:failed", "quality:threshold:failed",
  // Scheduling
  "schedule:triggered", "schedule:created", "schedule:completed",
  // Task watchers
  "watcher:created", "watcher:fired", "watcher:removed",
  // Notification actions
  "action:triggered",
  // Filesystem
  "file:changed",
  // General
  "log",
] as const;

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface EventSourceConfig {
  url: string;
  onEvent: (event: SSEEvent) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
}

export class EventSourceManager {
  private es: EventSource | null = null;
  private lastEventId: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentDelay: number;
  private status: ConnectionStatus = "disconnected";
  private disposed = false;

  private readonly config: EventSourceConfig;
  private readonly maxDelay: number;
  private readonly initialDelay: number;

  constructor(config: EventSourceConfig) {
    this.config = config;
    this.initialDelay = config.reconnectDelay ?? 1000;
    this.maxDelay = config.maxReconnectDelay ?? 30000;
    this.currentDelay = this.initialDelay;
  }

  connect(): void {
    if (this.disposed) return;
    this.cleanup();
    this.setStatus("connecting");

    let url = this.config.url;
    if (this.lastEventId) {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}lastEventId=${encodeURIComponent(this.lastEventId)}`;
    }

    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => {
      this.currentDelay = this.initialDelay;
      this.setStatus("connected");
    };

    es.onmessage = (e) => {
      this.handleMessage(e);
    };

    // Subscribe to ALL named events emitted by the Polpo SSE bridge.
    // The EventSource API only delivers named events (those with an `event:`
    // field in the SSE stream) to explicit addEventListener() calls — the
    // generic `onmessage` handler does NOT receive them. This list must stay
    // in sync with the server-side ALL_EVENTS in src/server/sse-bridge.ts.
    for (const eventName of ALL_SSE_EVENTS) {
      es.addEventListener(eventName, (e) => this.handleMessage(e as MessageEvent));
    }

    es.onerror = () => {
      this.scheduleReconnect();
    };
  }

  disconnect(): void {
    this.disposed = true;
    this.cleanup();
    this.setStatus("disconnected");
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private handleMessage(e: MessageEvent): void {
    if (e.lastEventId) {
      this.lastEventId = e.lastEventId;
    }

    let data: unknown;
    try {
      data = JSON.parse(e.data as string);
    } catch {
      data = e.data;
    }

    const event: SSEEvent = {
      id: e.lastEventId ?? "",
      event: e.type === "message" ? "message" : e.type,
      data,
      timestamp: new Date().toISOString(),
    };

    this.config.onEvent(event);
  }

  private scheduleReconnect(): void {
    this.cleanup();
    if (this.disposed) return;

    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.currentDelay = Math.min(this.currentDelay * 2, this.maxDelay);
      this.connect();
    }, this.currentDelay);
  }

  private cleanup(): void {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.config.onStatusChange(status);
    }
  }
}
