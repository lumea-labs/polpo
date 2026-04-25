/**
 * Hierarchical, end-user-facing catalog of every event the Polpo runtime
 * actually emits on the public webhook bus today. Used by webhook
 * subscription UIs and the OpenAPI metadata endpoint to enumerate
 * subscribable events without hardcoding the list at the consumer.
 *
 * Source of truth — this catalog is intentionally narrower than
 * `PolpoEventMap` in `events.ts`: it lists *only* events that are wired
 * end-to-end (emitted somewhere AND forwarded to the cloud event bus).
 * `PolpoEventMap` includes types for events that exist on the in-process
 * emitter but are not yet exposed as webhook subscriptions (mission
 * lifecycle, agent process events, assessments, approvals, escalations,
 * SLAs, schedules, checkpoints, delays, peers, notifications, gateway
 * lifecycle). Add them to this catalog only when they're wired through
 * `cloud:event`.
 *
 * Coverage assertion lives at `events-catalog.test.ts` so the count is
 * pinned and grows intentionally.
 */

export interface EventCatalogEntry {
  /** Suffix after the namespace, e.g. `created` for `task:created`. */
  key: string;
  description: string;
}

export interface EventCatalogGroup {
  /** Namespace prefix (`task`, `completion`, `session`). */
  ns: string;
  /** Human label for UI grouping. */
  label: string;
  description: string;
  events: ReadonlyArray<EventCatalogEntry>;
}

export const EVENT_CATALOG: ReadonlyArray<EventCatalogGroup> = [
  {
    ns: "task",
    label: "Tasks",
    description: "Lifecycle of individual tasks.",
    events: [
      { key: "created", description: "A task was created." },
      { key: "transition", description: "Task status changed (e.g. running → done)." },
      { key: "updated", description: "Task metadata was edited." },
      { key: "removed", description: "Task was deleted." },
      { key: "timeout", description: "Task exceeded its time budget." },
      { key: "retry", description: "Task is being retried." },
      { key: "fix", description: "Self-fix attempt after assessment failure." },
      { key: "question", description: "Agent is asking the user a question." },
      { key: "answered", description: "User answered an agent's question." },
      { key: "recovered", description: "Task recovered from a stuck state." },
    ],
  },
  {
    ns: "completion",
    label: "Completions",
    description: "Chat-completion API events.",
    events: [
      { key: "finished", description: "A /v1/chat/completions call finished." },
    ],
  },
  {
    ns: "session",
    label: "Sessions",
    description: "Chat session lifecycle.",
    events: [
      { key: "started", description: "First message of a new chat session." },
    ],
  },
];
