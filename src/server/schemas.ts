import { z } from "@hono/zod-openapi";
import { ApiHttpError } from "./middleware/error.js";

// ── Outcome schemas ───────────────────────────────────────────────────

const ExpectedOutcomeSchema = z.object({
  type: z.enum(["file", "text", "url", "json", "media"]),
  label: z.string().min(1),
  description: z.string().optional(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  required: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

// ── Notification rule schema (shared for scoped rules) ────────────────

const NotificationRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  events: z.array(z.string().min(1)).min(1),
  condition: z.any().optional(),
  channels: z.array(z.string().min(1)).min(1),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  template: z.string().optional(),
  cooldownMs: z.number().int().min(0).optional(),
  includeOutcomes: z.boolean().optional(),
  outcomeFilter: z.array(z.enum(["file", "text", "url", "json", "media"])).optional(),
  maxAttachmentSize: z.number().int().min(0).optional(),
});

const ScopedNotificationRulesSchema = z.object({
  rules: z.array(NotificationRuleSchema),
  inherit: z.boolean().optional(),
});

// ── Task schemas ──────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assignTo: z.string().min(1),
  /** Create task as draft (won't be picked up by orchestrator until moved to pending). Default: false. */
  draft: z.boolean().optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(ExpectedOutcomeSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  group: z.string().optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z
    .object({
      escalateAfter: z.number().int().min(0).optional(),
      fallbackAgent: z.string().optional(),
      escalateModel: z.string().optional(),
    })
    .optional(),
  notifications: ScopedNotificationRulesSchema.optional(),
  /** Whether this task produces irreversible side effects. Blocks automatic retry/fix. */
  sideEffects: z.boolean().optional(),
});

export const UpdateTaskSchema = z.object({
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  status: z.enum(["draft", "pending", "awaiting_approval", "assigned", "in_progress", "review", "done", "failed"]).optional(),
  expectations: z.array(z.any()).optional(),
  retries: z.number().int().min(0).optional(),
  maxRetries: z.number().int().min(0).optional(),
  /** Whether this task produces irreversible side effects. Blocks automatic retry/fix. */
  sideEffects: z.boolean().optional(),
});

// ── Mission schemas ──────────────────────────────────────────────────

export const CreateMissionSchema = z.object({
  data: z.string().min(1),
  prompt: z.string().optional(),
  name: z.string().optional(),
  status: z
    .enum(["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"])
    .optional(),
  /** End date for recurring schedules (ISO timestamp). */
  endDate: z.string().datetime().optional(),
  notifications: ScopedNotificationRulesSchema.optional(),
});

export const UpdateMissionSchema = z.object({
  data: z.string().min(1).optional(),
  status: z
    .enum(["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"])
    .optional(),
  name: z.string().optional(),
  /** End date for recurring schedules (ISO timestamp). */
  endDate: z.string().datetime().nullable().optional(),
});

// ── Atomic mission data schemas ──────────────────────────────────

export const AddMissionTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  assignTo: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(z.any()).optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z.object({
    escalateAfter: z.number().int().min(0).optional(),
    fallbackAgent: z.string().optional(),
  }).optional(),
  notifications: z.any().optional(),
  sideEffects: z.boolean().optional(),
});

export const UpdateMissionTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(z.any()).optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z.object({
    escalateAfter: z.number().int().min(0).optional(),
    fallbackAgent: z.string().optional(),
  }).optional(),
  notifications: z.any().optional(),
  sideEffects: z.boolean().optional(),
});

export const ReorderMissionTasksSchema = z.object({
  titles: z.array(z.string().min(1)).min(1),
});

export const AddMissionCheckpointSchema = z.object({
  name: z.string().min(1),
  afterTasks: z.array(z.string().min(1)).min(1),
  blocksTasks: z.array(z.string().min(1)).min(1),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const UpdateMissionCheckpointSchema = z.object({
  name: z.string().min(1).optional(),
  afterTasks: z.array(z.string().min(1)).min(1).optional(),
  blocksTasks: z.array(z.string().min(1)).min(1).optional(),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const AddMissionDelaySchema = z.object({
  name: z.string().min(1),
  afterTasks: z.array(z.string().min(1)).min(1),
  blocksTasks: z.array(z.string().min(1)).min(1),
  duration: z.string().min(1),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const UpdateMissionDelaySchema = z.object({
  name: z.string().min(1).optional(),
  afterTasks: z.array(z.string().min(1)).min(1).optional(),
  blocksTasks: z.array(z.string().min(1)).min(1).optional(),
  duration: z.string().min(1).optional(),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const AddMissionQualityGateSchema = z.object({
  name: z.string().min(1),
  afterTasks: z.array(z.string().min(1)).min(1),
  blocksTasks: z.array(z.string().min(1)).min(1),
  minScore: z.number().min(1).max(5).optional(),
  requireAllPassed: z.boolean().optional(),
  condition: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const UpdateMissionQualityGateSchema = z.object({
  name: z.string().min(1).optional(),
  afterTasks: z.array(z.string().min(1)).min(1).optional(),
  blocksTasks: z.array(z.string().min(1)).min(1).optional(),
  minScore: z.number().min(1).max(5).optional(),
  requireAllPassed: z.boolean().optional(),
  condition: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const AddMissionTeamMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const UpdateMissionTeamMemberSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
});

export const UpdateMissionNotificationsSchema = z.object({
  notifications: ScopedNotificationRulesSchema.nullable(),
});

// ── Settings schema ───────────────────────────────────────────────────

const ModelConfigSchema = z.object({
  primary: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
});

export const UpdateSettingsSchema = z.object({
  orchestratorModel: z.union([z.string(), ModelConfigSchema]).optional(),
  imageModel: z.string().nullable().optional(),
  reasoning: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

// ── Agent schemas ─────────────────────────────────────────────────────

const AgentResponsibilitySchema = z.object({
  area: z.string(),
  description: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
});

const AgentIdentitySchema = z.object({
  displayName: z.string().optional(),
  title: z.string().optional(),
  company: z.string().optional(),
  email: z.string().optional(),
  bio: z.string().optional(),
  timezone: z.string().optional(),
  avatar: z.string().optional(),
  responsibilities: z.array(z.union([z.string(), AgentResponsibilitySchema])).optional(),
  tone: z.string().optional(),
  personality: z.string().optional(),
  socials: z.record(z.string(), z.string()).optional(),
});

const LoopConditionSchema = z.object({
  expression: z.string().min(1),
});

const LoopOutputSchema = z.object({
  schema: z.unknown().optional(),
});

const LoopToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    mode: z.enum(["auto", "none", "required"]),
    tool: z.string().min(1).optional(),
  }),
]);

const LoopConfigSchema = z.object({
  name: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  tools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  toolChoice: LoopToolChoiceSchema.optional(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTurns: z.number().int().positive().optional(),
  stopWhen: LoopConditionSchema.optional(),
  output: LoopOutputSchema.optional(),
});

type ValidationContext = {
  addIssue(issue: { code: typeof z.ZodIssueCode.custom; message: string; path?: (string | number)[] }): void;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateNonEmptyString(value: unknown, ctx: ValidationContext, path: (string | number)[], label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a non-empty string`, path });
  }
}

function validateOptionalWhen(node: Record<string, unknown>, ctx: ValidationContext, path: (string | number)[]): void {
  if (node.when !== undefined) validateNonEmptyString(node.when, ctx, [...path, "when"], "when");
}

function validateLoopStep(step: unknown, ctx: ValidationContext, path: (string | number)[] = []): void {
  if (!isPlainObject(step)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "step must be an object", path });
    return;
  }

  const kinds = ["loop", "tool", "parallel", "switch", "human"].filter((kind) => kind in step);
  if (kinds.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "step requires exactly one of loop, tool, parallel, switch, or human",
      path,
    });
    return;
  }

  validateOptionalWhen(step, ctx, path);

  if ("loop" in step) {
    validateNonEmptyString(step.loop, ctx, [...path, "loop"], "loop");
    return;
  }

  if ("tool" in step) {
    validateNonEmptyString(step.tool, ctx, [...path, "tool"], "tool");
    if (step.saveAs !== undefined) validateNonEmptyString(step.saveAs, ctx, [...path, "saveAs"], "saveAs");
    return;
  }

  if ("parallel" in step) {
    if (!Array.isArray(step.parallel) || step.parallel.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "parallel must contain at least one step", path: [...path, "parallel"] });
    } else {
      step.parallel.forEach((child, index) => validateLoopStep(child, ctx, [...path, "parallel", index]));
    }
    if (
      step.join !== undefined
      && step.join !== "all"
      && step.join !== "any"
      && !(typeof step.join === "number" && Number.isInteger(step.join) && step.join > 0)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "join must be all, any, or a positive integer", path: [...path, "join"] });
    }
    return;
  }

  if ("switch" in step) {
    if (!isPlainObject(step.switch)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "switch must be an object", path: [...path, "switch"] });
      return;
    }
    const cases = step.switch.cases;
    if (!Array.isArray(cases) || cases.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "switch.cases must contain at least one case", path: [...path, "switch", "cases"] });
    } else {
      cases.forEach((branch, index) => {
        if (!isPlainObject(branch)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "switch case must be an object", path: [...path, "switch", "cases", index] });
          return;
        }
        validateNonEmptyString(branch.when, ctx, [...path, "switch", "cases", index, "when"], "when");
        if (!Array.isArray(branch.steps) || branch.steps.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "case steps must contain at least one step", path: [...path, "switch", "cases", index, "steps"] });
        } else {
          branch.steps.forEach((child, childIndex) => validateLoopStep(child, ctx, [...path, "switch", "cases", index, "steps", childIndex]));
        }
      });
    }
    if (step.switch.default !== undefined) {
      if (!isPlainObject(step.switch.default) || !Array.isArray(step.switch.default.steps) || step.switch.default.steps.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "switch.default.steps must contain at least one step", path: [...path, "switch", "default", "steps"] });
      } else {
        step.switch.default.steps.forEach((child, index) => validateLoopStep(child, ctx, [...path, "switch", "default", "steps", index]));
      }
    }
    return;
  }

  validateNonEmptyString(step.human, ctx, [...path, "human"], "human");
  if (step.notify !== undefined && (!Array.isArray(step.notify) || step.notify.some((item) => typeof item !== "string" || item.trim() === ""))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "notify must be an array of non-empty strings", path: [...path, "notify"] });
  }
}

const LoopStepSchema = z.unknown().superRefine((step, ctx) => validateLoopStep(step, ctx));

const PipelineSchema = z.object({
  mode: z.enum(["sequential", "parallel"]).optional(),
  context: z.literal("shared").optional(),
  steps: z.array(LoopStepSchema).min(1),
});

function collectLoopRefs(step: unknown, refs: string[]): void {
  if (!step || typeof step !== "object") return;
  const node = step as Record<string, unknown>;
  if (typeof node.loop === "string") {
    refs.push(node.loop);
    return;
  }
  if (Array.isArray(node.parallel)) {
    for (const child of node.parallel) collectLoopRefs(child, refs);
    return;
  }
  if (node.switch && typeof node.switch === "object") {
    const switchStep = node.switch as {
      cases?: Array<{ steps?: unknown[] }>;
      default?: { steps?: unknown[] };
    };
    for (const branch of switchStep.cases ?? []) {
      for (const child of branch.steps ?? []) collectLoopRefs(child, refs);
    }
    for (const child of switchStep.default?.steps ?? []) collectLoopRefs(child, refs);
  }
}

const AgentLoopFieldsSchema = z.object({
  runtime: z.string().optional(),
  assignedLoops: z.array(z.string().min(1)).optional(),
  defaultLoop: z.string().min(1).optional(),
}).superRefine((config, ctx) => {
  if (config.defaultLoop && config.assignedLoops && !config.assignedLoops.includes(config.defaultLoop)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `defaultLoop "${config.defaultLoop}" is not in assignedLoops`,
      path: ["defaultLoop"],
    });
  }
});

export const AddAgentSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  // Identity & hierarchy (vault credentials managed via encrypted store)
  identity: AgentIdentitySchema.optional(),
  reportsTo: z.string().optional(),
  // Extended tool categories (browser, email, vault, image, video, audio, excel, pdf, docx, search — HTTP is always-on core)
  browserProfile: z.string().optional(),
}).and(AgentLoopFieldsSchema);

export const UpdateAgentSchema = z.object({
  role: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  allowedPaths: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  identity: AgentIdentitySchema.optional(),
  reportsTo: z.string().optional(),
  reasoning: z.string().optional(),
  browserProfile: z.string().optional(),
  emailAllowedDomains: z.array(z.string()).optional(),
  team: z.string().optional(),
}).and(AgentLoopFieldsSchema);

export const RenameTeamSchema = z.object({
  oldName: z.string().min(1),
  name: z.string().min(1),
});

export const AddTeamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// ── Notification channel config schema ─────────────────────────────────

const ChannelGatewaySchema = z.object({
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  enableInbound: z.boolean().optional(),
  sessionIdleMinutes: z.number().int().min(1).optional(),
}).strict();

export const NotificationChannelConfigSchema = z.object({
  type: z.enum(["slack", "email", "telegram", "whatsapp", "webhook"]),
  // Slack
  webhookUrl: z.string().url().optional(),
  // Email
  to: z.array(z.string().email()).optional(),
  provider: z.string().optional(),
  from: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  // Shared
  apiKey: z.string().optional(),
  // Telegram
  botToken: z.string().optional(),
  chatId: z.string().optional(),
  // WhatsApp
  profileDir: z.string().optional(),
  // Webhook
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  // Gateway
  gateway: ChannelGatewaySchema.optional(),
});

// ── Direct notification schema ─────────────────────────────────────────

export const SendNotificationSchema = z.object({
  channel: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  delayMs: z.number().int().min(0).optional(),
});

// ── Approval schemas ──────────────────────────────────────────────────

export const ApproveRequestSchema = z.object({
  resolvedBy: z.string().optional(),
  note: z.string().optional(),
});

export const RejectRequestSchema = z.object({
  feedback: z.string().min(1),
  resolvedBy: z.string().optional(),
});

// ── Memory schema ─────────────────────────────────────────────────────

export const UpdateMemorySchema = z.object({
  content: z.string(),
});

// ── Helper ────────────────────────────────────────────────────────────

/** Parse and validate request body against a Zod schema. Throws ApiHttpError on failure. */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ApiHttpError(issues, "VALIDATION_ERROR", 400);
  }
  return result.data;
}
