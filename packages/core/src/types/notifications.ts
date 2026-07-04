/**
 * Notifications domain — channels, rules, conditions, action triggers,
 * scoped rules, and escalation policies.
 */

import type { TaskExpectation, OutcomeType } from "./task.js";

// === Notification System ===

export type NotificationChannelType = "slack" | "email" | "telegram" | "webhook";

export interface NotificationChannelConfig {
  type: NotificationChannelType;
  /** Slack: webhook URL. */
  webhookUrl?: string;
  /** Email: recipient addresses. */
  to?: string[];
  /** Email: provider ("smtp" | "resend" | "sendgrid"). */
  provider?: string;
  /** API key (direct value or "${ENV_VAR}" reference). */
  apiKey?: string;
  /** Telegram: bot token. */
  botToken?: string;
  /** Telegram: chat ID. */
  chatId?: string;
  /** Webhook: target URL. */
  url?: string;
  /** Webhook: custom headers. */
  headers?: Record<string, string>;
  /** SMTP host. */
  host?: string;
  /** SMTP port. */
  port?: number;
  /** SMTP from address. */
  from?: string;
}

export type NotificationSeverity = "info" | "warning" | "critical";

/**
 * JSON-based condition for notification rule filtering.
 *
 * Supports:
 *   - Single comparison: { "field": "status", "op": "==", "value": "failed" }
 *   - Logical AND:       { "and": [ ...conditions ] }
 *   - Logical OR:        { "or": [ ...conditions ] }
 *   - Logical NOT:       { "not": condition }
 *   - Inclusion:         { "field": "tags", "op": "includes", "value": "urgent" }
 *   - Existence:         { "field": "error", "op": "exists" }
 *
 * Fields are dot-paths resolved on the event data (e.g. "task.status", "score").
 */
export type ConditionOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "includes" | "not_includes" | "exists" | "not_exists";

export interface ConditionExpr {
  field: string;
  op: ConditionOp;
  value?: string | number | boolean | null;
}

export interface ConditionAnd {
  and: NotificationCondition[];
}

export interface ConditionOr {
  or: NotificationCondition[];
}

export interface ConditionNot {
  not: NotificationCondition;
}

export type NotificationCondition = ConditionExpr | ConditionAnd | ConditionOr | ConditionNot;

export interface NotificationRule {
  /** Unique rule ID. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Event patterns to match (glob-style: "task:*", "mission:completed"). */
  events: string[];
  /** Optional JSON condition on the event payload. No eval — pure data. */
  condition?: NotificationCondition;
  /** Channels to notify (references to channel IDs in config). */
  channels: string[];
  /** Severity level. Default: "info". */
  severity?: NotificationSeverity;
  /** Mustache-style template for the notification body. */
  template?: string;
  /** Minimum interval between notifications for the same rule (ms). */
  cooldownMs?: number;
  /** Attach task outcomes to the notification (files sent as attachments). Default: false. */
  includeOutcomes?: boolean;
  /** Only include outcomes of these types. When omitted, all types are included. */
  outcomeFilter?: OutcomeType[];
  /** Max file size per attachment in bytes. Files larger than this are skipped. Default: 10MB. */
  maxAttachmentSize?: number;
  /** Action triggers — executed when the rule fires, in addition to sending notifications. */
  actions?: NotificationAction[];
}

// === Notification Action Triggers ===

/** Action types that can be triggered by notification rules. */
export type NotificationActionType = "create_task" | "execute_mission" | "run_script" | "send_notification";

/** Base action interface. */
interface NotificationActionBase {
  type: NotificationActionType;
}

/** Create a task when the rule fires. */
export interface CreateTaskAction extends NotificationActionBase {
  type: "create_task";
  title: string;
  description: string;
  assignTo: string;
  expectations?: TaskExpectation[];
}

/** Execute an existing mission when the rule fires. */
export interface ExecuteMissionAction extends NotificationActionBase {
  type: "execute_mission";
  missionId: string;
}

/** Run a shell script when the rule fires. */
export interface RunScriptAction extends NotificationActionBase {
  type: "run_script";
  command: string;
  /** Max execution time in ms. Default: 30000. */
  timeoutMs?: number;
}

/** Send an additional notification to different channels. */
export interface SendNotificationAction extends NotificationActionBase {
  type: "send_notification";
  channel: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
}

export type NotificationAction = CreateTaskAction | ExecuteMissionAction | RunScriptAction | SendNotificationAction;

export interface NotificationsConfig {
  channels: Record<string, NotificationChannelConfig>;
  rules: NotificationRule[];
}

/**
 * Scoped notification rules — can be attached to a Task or Mission to override
 * or extend the global notification rules.
 *
 * Precedence: task > mission > global.
 * - Default: more-specific scope **replaces** global rules for matching events.
 * - With `inherit: true`: scoped rules are **added** on top of the parent scope.
 */
export interface ScopedNotificationRules {
  /** Notification rules for this scope. */
  rules: NotificationRule[];
  /** If true, these rules are added on top of the parent scope (plan or global).
   *  If false (default), they replace parent rules for matching events. */
  inherit?: boolean;
}

// === Escalation ===

export type EscalationHandlerType = "agent" | "orchestrator" | "human";

export interface EscalationLevel {
  /** Level number (0 = first). */
  level: number;
  /** Who handles at this level. */
  handler: EscalationHandlerType;
  /** Target agent name (for "agent"), notification channel (for "human"). */
  target?: string;
  /** Timeout before escalating to next level (ms). */
  timeoutMs?: number;
  /** Notification channels to alert at this level. */
  notifyChannels?: string[];
}

export interface EscalationPolicy {
  /** Policy name. */
  name: string;
  /** Ordered escalation levels. */
  levels: EscalationLevel[];
}
