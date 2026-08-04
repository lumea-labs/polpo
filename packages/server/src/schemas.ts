import { z } from "@hono/zod-openapi";
import {
  MAX_MODEL_FALLBACKS,
  MODEL_PROFILE_NAME_PATTERN,
  RUNTIME_INVOCATION_SOURCES,
  RUNTIME_SURFACES,
} from "@polpo-ai/core";
import { TOOL_CATALOG, matchToolPattern } from "@polpo-ai/tools";
import { ApiHttpError } from "./errors.js";

/**
 * Allowed-tool name validator.
 *
 * Accepts:
 *  - any built-in tool name from the catalog (case-insensitive exact match)
 *  - the wildcard `*` (everything)
 *  - a category wildcard like `browser_*` — only valid if it actually
 *    matches at least one catalog entry
 *  - any `mcp__<server>__<tool>` name — those are external (the user-defined
 *    MCP servers ship them at runtime), so we can't validate the suffix.
 */
const ToolNameSchema = z.string().refine((value) => {
  const v = value.toLowerCase();
  if (v === "*") return true;
  if (v.startsWith("mcp__")) return true;
  if (v.includes("*")) return TOOL_CATALOG.some((name) => matchToolPattern(v, name));
  if (TOOL_CATALOG.includes(v)) return true;
  // Custom tools (defineTool) register project-defined snake_case names that
  // aren't in the built-in catalog. Accept any snake_case identifier as a
  // possible custom tool — the runtime resolves/filters unknown names safely.
  return /^[a-z][a-z0-9_]*$/.test(v);
}, {
  message: "Invalid tool name. Use a built-in tool, a category wildcard like `browser_*`, the global `*`, an MCP tool `mcp__<server>__<name>`, or a snake_case custom tool name.",
});

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

const RuntimeSandboxLifecycleSchema = z.object({
  onRelease: z.enum(["pool", "destroy"]).optional().openapi({
    description: "Sandbox release policy. `pool` allows later project-scoped reuse; `destroy` deletes after the outer run.",
  }),
  idleTtlMinutes: z.number().int().min(1).max(10_080).optional().openapi({
    description: "Optional pooled inactivity TTL in minutes. Applies only when `onRelease` resolves to `pool`.",
  }),
}).strict().superRefine((lifecycle, ctx) => {
  if (lifecycle.onRelease === "destroy" && lifecycle.idleTtlMinutes !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["idleTtlMinutes"],
      message: "Sandbox idleTtlMinutes cannot be used with onRelease=destroy",
    });
  }
});

export const RuntimeSandboxSchema = z.object({
  isolation: z.enum(["reuse", "fresh"]).optional().openapi({
    description: "Sandbox isolation policy. `reuse` keeps warm state when available; `fresh` requests one clean sandbox shared by every step in the outer run.",
  }),
  lifecycle: RuntimeSandboxLifecycleSchema.optional(),
}).strict().openapi({
  description: "Provider-neutral runtime sandbox policy.",
});

export const RuntimeRoutingSchema = z.object({
  labels: z
    .array(z.string().trim().min(1).max(64).refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Runtime routing labels must contain no control characters",
    ))
    .max(16)
    .optional()
    .openapi({
      description:
        "Bounded trusted labels used by deterministic runtime routing policy.",
    }),
}).strict().openapi({
  description: "Caller-supplied runtime routing context.",
});

// ── Task schemas ──────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  executionMode: z.enum(["subprocess", "in-process"]).optional(),
  sandbox: RuntimeSandboxSchema.optional(),
  routing: RuntimeRoutingSchema.optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  assignTo: z.string().min(1),
  /** Explicit project loop this task runs (a name in the agent's assignedLoops). */
  loop: z.string().min(1).optional(),
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
  /**
   * Opaque end-user identifier (OpenAI-compat). Persisted on the task and
   * propagated to the spawned run for per-user analytics + billing pass-through.
   * Polpo never verifies — set from your authenticated end-user id.
   */
  user: z.string().optional(),
});

export const UpdateTaskSchema = z.object({
  description: z.string().min(1).optional(),
  assignTo: z.string().min(1).optional(),
  loop: z.string().min(1).optional(),
  sandbox: RuntimeSandboxSchema.optional(),
  routing: RuntimeRoutingSchema.optional(),
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
  /** @deprecated Use the v2 Schedules API. */
  schedule: z.string().optional(),
  /** Absolute deadline for the entire mission (ISO timestamp). */
  deadline: z.string().datetime().optional(),
  /** @deprecated Use the v2 Schedules API. */
  endDate: z.string().datetime().optional(),
  notifications: ScopedNotificationRulesSchema.optional(),
  /**
   * Opaque end-user identifier (OpenAI-compat). Tasks generated by this
   * mission inherit this value at creation unless explicitly overridden.
   */
  user: z.string().optional(),
});

export const UpdateMissionSchema = z.object({
  data: z.string().min(1).optional(),
  status: z
    .enum(["draft", "scheduled", "recurring", "active", "paused", "completed", "failed", "cancelled"])
    .optional(),
  name: z.string().optional(),
  /** @deprecated Use the v2 Schedules API. */
  schedule: z.string().nullable().optional(),
  /** Absolute deadline for the entire mission (ISO timestamp). Null clears. */
  deadline: z.string().datetime().nullable().optional(),
  /** @deprecated Use the v2 Schedules API. */
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

const ModelConfigSchema = z.object({
  primary: z.string().min(1),
  fallbacks: z.array(z.string().min(1)).max(MAX_MODEL_FALLBACKS).optional(),
}).strict();

const ModelProfileReferenceSchema = z.object({
  profile: z.string().regex(MODEL_PROFILE_NAME_PATTERN),
}).strict();

const ModelTargetSchema = z.union([
  z.string().min(1),
  ModelProfileReferenceSchema,
]);

const ProfiledModelConfigSchema = z.object({
  primary: ModelTargetSchema,
  fallbacks: z.array(ModelTargetSchema).max(MAX_MODEL_FALLBACKS).optional(),
}).strict();

const ModelSelectionSchema = z.union([
  z.string().min(1),
  ModelProfileReferenceSchema,
  ProfiledModelConfigSchema,
]);

const ModelProfileRegistrySchema = z.record(
  z.string().regex(MODEL_PROFILE_NAME_PATTERN),
  ModelSelectionSchema,
);

export const AddMissionTeamMemberSchema = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  model: ModelSelectionSchema.optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(ToolNameSchema).optional(),
});

export const UpdateMissionTeamMemberSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().optional(),
  model: ModelSelectionSchema.optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(ToolNameSchema).optional(),
});

export const UpdateMissionNotificationsSchema = z.object({
  notifications: ScopedNotificationRulesSchema.nullable(),
});

// ── Settings schema ───────────────────────────────────────────────────

export const UpdateSettingsSchema = z.object({
  orchestratorModel: ModelSelectionSchema.optional(),
  modelProfiles: ModelProfileRegistrySchema.optional(),
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

/**
 * MCP server config attached to an agent. Three transport variants —
 * mirrors the type union in `@polpo-ai/sdk` (`McpServerConfig`). Validated
 * here so payloads from the dashboard / CLI / direct API all converge on
 * the same shape before the agent runtime resolves the actual tools at
 * completion time. Header values support `${vault:service:key}`
 * templating, resolved server-side (the regex isn't enforced at this
 * layer — strings are accepted as-is).
 */
const McpServerConfigSchema = z.union([
  z.object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("sse"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const McpServersRecordSchema = z.record(z.string().min(1), McpServerConfigSchema);

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
  model: ModelSelectionSchema.optional(),
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

  const kinds = ["loop", "tool", "parallel", "switch", "while", "human"].filter((kind) => kind in step);
  if (kinds.length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "step requires exactly one of loop, tool, parallel, switch, while, or human",
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

  if ("while" in step) {
    if (!isPlainObject(step.while)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "while must be an object", path: [...path, "while"] });
      return;
    }
    if (step.while.condition !== undefined) validateNonEmptyString(step.while.condition, ctx, [...path, "while", "condition"], "condition");
    if (step.while.until !== undefined) validateNonEmptyString(step.while.until, ctx, [...path, "while", "until"], "until");
    if (step.while.condition === undefined && step.while.until === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "while requires condition or until", path: [...path, "while"] });
    }
    if (
      step.while.maxIterations !== undefined
      && !(typeof step.while.maxIterations === "number" && Number.isInteger(step.while.maxIterations) && step.while.maxIterations > 0)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "maxIterations must be a positive integer", path: [...path, "while", "maxIterations"] });
    }
    if (!Array.isArray(step.while.steps) || step.while.steps.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "while.steps must contain at least one step", path: [...path, "while", "steps"] });
    } else {
      step.while.steps.forEach((child, index) => validateLoopStep(child, ctx, [...path, "while", "steps", index]));
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
    return;
  }
  if (node.while && typeof node.while === "object") {
    const whileStep = node.while as { steps?: unknown[] };
    for (const child of whileStep.steps ?? []) collectLoopRefs(child, refs);
  }
}

const ExecutionRouterLoopNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value),
    "Execution router loop names must be trimmed and contain no control characters",
  );

const ExecutionRouterPolicyLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Execution router labels must contain no control characters",
  );

const ExecutionRouterRuleWhenSchema = z.object({
  surfaces: z.array(z.enum(RUNTIME_SURFACES)).max(RUNTIME_SURFACES.length).optional(),
  sources: z
    .array(z.enum(RUNTIME_INVOCATION_SOURCES))
    .max(RUNTIME_INVOCATION_SOURCES.length)
    .optional(),
  allLabels: z.array(ExecutionRouterPolicyLabelSchema).max(16).optional(),
  anyLabels: z.array(ExecutionRouterPolicyLabelSchema).max(16).optional(),
  noneLabels: z.array(ExecutionRouterPolicyLabelSchema).max(16).optional(),
}).strict().superRefine((value, ctx) => {
  if (
    !value.surfaces?.length
    && !value.sources?.length
    && !value.allLabels?.length
    && !value.anyLabels?.length
    && !value.noneLabels?.length
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Execution router rule must define at least one condition",
    });
  }
});

const ExecutionRouterRuleIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Execution router rule ids must contain no control characters",
  );

const ExecutionRouterRuleSchema = z.discriminatedUnion("mode", [
  z.object({
    id: ExecutionRouterRuleIdSchema,
    mode: z.literal("direct"),
    when: ExecutionRouterRuleWhenSchema,
  }).strict(),
  z.object({
    id: ExecutionRouterRuleIdSchema,
    mode: z.literal("loop"),
    loop: ExecutionRouterLoopNameSchema,
    when: ExecutionRouterRuleWhenSchema,
  }).strict(),
]);

const AgentExecutionRouterSchema = z.object({
  mode: z.enum(["off", "auto"]).optional(),
  allowedLoops: z
    .array(ExecutionRouterLoopNameSchema)
    .max(32)
    .optional(),
  minConfidence: z.number().finite().min(0).max(1).optional(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  maxInputChars: z.number().int().positive().max(16_384).optional(),
  rules: z.array(ExecutionRouterRuleSchema).max(32).optional(),
  loopHints: z.record(
    ExecutionRouterLoopNameSchema,
    z.string().trim().min(1).max(512),
  ).optional(),
  guidance: z.string().trim().min(1).max(2_000).optional(),
}).passthrough().superRefine((value, ctx) => {
  const supported = new Set([
    "mode",
    "allowedLoops",
    "minConfidence",
    "timeoutMs",
    "maxInputChars",
    "rules",
    "loopHints",
    "guidance",
  ]);
  if (Object.keys(value).some((key) => !supported.has(key))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Execution router contains unsupported fields",
    });
  }
  if (value.mode === "auto" && (!value.allowedLoops || value.allowedLoops.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowedLoops"],
      message: "Auto execution routing requires at least one allowed loop",
    });
  }
  const allowedLoops = new Set(value.allowedLoops ?? []);
  const seenRuleIds = new Set<string>();
  for (const [index, rule] of (value.rules ?? []).entries()) {
    if (seenRuleIds.has(rule.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules", index, "id"],
        message: `Duplicate execution router rule id "${rule.id}"`,
      });
    }
    seenRuleIds.add(rule.id);
    if (rule.mode === "loop" && !allowedLoops.has(rule.loop)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules", index, "loop"],
        message: "Execution router rule loop must be included in allowedLoops",
      });
    }
  }
  for (const loop of Object.keys(value.loopHints ?? {})) {
    if (!allowedLoops.has(loop)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["loopHints", loop],
        message: "Execution router loopHints keys must be included in allowedLoops",
      });
    }
  }
});

const AgentModelRoutingSchema = z.object({
  mode: z.enum(["off", "auto"]),
}).passthrough().superRefine((value, ctx) => {
  if (Object.keys(value).some((key) => key !== "mode")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent model routing contains unsupported fields",
    });
  }
});

const AgentLoopFieldsSchema = z.object({
  runtime: z.string().optional(),
  assignedLoops: z.array(z.string().min(1)).optional(),
  executionRouter: AgentExecutionRouterSchema.optional(),
});

export const AddAgentSchema = z.object({
  executionMode: z.enum(["subprocess", "in-process"]).optional(),
  sandbox: RuntimeSandboxSchema.optional(),
  name: z.string().min(1),
  role: z.string().optional(),
  model: ModelSelectionSchema.optional(),
  allowedModelProfiles: z.array(z.string().regex(MODEL_PROFILE_NAME_PATTERN)).optional(),
  modelRouting: AgentModelRoutingSchema.optional(),
  // Per-modality media models (provider/model strings; format checked
  // by parseModelString at tool-call time). Undefined → DEFAULT_*_MODEL.
  image_model:      z.string().optional(),
  video_model:      z.string().optional(),
  vision_model:     z.string().optional(),
  transcribe_model: z.string().optional(),
  tts_model:        z.string().optional(),
  search_provider:  z.string().optional(),
  allowedTools: z.array(ToolNameSchema).optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).optional(),
  maxTurns: z.number().int().positive().optional(),
  // Identity & hierarchy (vault credentials managed via encrypted store)
  identity: AgentIdentitySchema.optional(),
  reportsTo: z.string().optional(),
  // Extended tool categories (browser, email, vault, image, video, audio, excel, pdf, docx, search — HTTP is always-on core)
  browserProfile: z.string().optional(),
  /** External MCP servers — keyed by user-chosen name. Tools from each
   *  server are namespaced `mcp__<key>__<tool>` at runtime. */
  mcpServers: McpServersRecordSchema.optional(),
}).and(AgentLoopFieldsSchema);

export const UpdateAgentSchema = z.object({
  executionMode: z.enum(["subprocess", "in-process"]).optional(),
  sandbox: RuntimeSandboxSchema.optional(),
  role: z.string().optional(),
  model: ModelSelectionSchema.optional(),
  allowedModelProfiles: z.array(z.string().regex(MODEL_PROFILE_NAME_PATTERN)).optional(),
  modelRouting: AgentModelRoutingSchema.optional(),
  // Per-modality media models (optional, mirror AddAgentSchema).
  image_model:      z.string().optional(),
  video_model:      z.string().optional(),
  vision_model:     z.string().optional(),
  transcribe_model: z.string().optional(),
  tts_model:        z.string().optional(),
  search_provider:  z.string().optional(),
  allowedTools: z.array(ToolNameSchema).optional(),
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
  /** Replace the agent's MCP server map. Pass an empty object to clear. */
  mcpServers: McpServersRecordSchema.optional(),
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


export const NotificationChannelConfigSchema = z.object({
  type: z.enum(["slack", "email", "telegram", "webhook"]),
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
  // Webhook
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
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
