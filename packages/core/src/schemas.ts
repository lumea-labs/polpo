/**
 * Zod schemas for runtime validation of Polpo types.
 * Central source of truth — used by config parser, orchestrator, and API routes.
 */

import { z } from "zod";
import type { TaskExpectation, MissionCheckpoint, MissionQualityGate } from "./types.js";
import { LOOP_LIFECYCLE_HOOKS } from "./loop/types.js";
import { MAX_MODEL_FALLBACKS } from "./model-policy.js";
import { MODEL_PROFILE_NAME_PATTERN } from "./model-profiles.js";

// ── Expectation Schemas (discriminated union on `type`) ──────────────

const testExpectation = z.object({
  type: z.literal("test"),
  command: z.string().min(1, "test expectation requires a non-empty command"),
});

const scriptExpectation = z.object({
  type: z.literal("script"),
  command: z.string().min(1, "script expectation requires a non-empty command"),
});

const fileExistsExpectation = z.object({
  type: z.literal("file_exists"),
  paths: z.array(z.string().min(1)).min(1, "file_exists expectation requires at least one path"),
});

const evalDimension = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().min(0).max(1),
  rubric: z.record(z.string(), z.string()).optional(),
});

const llmReviewExpectation = z.object({
  type: z.literal("llm_review"),
  criteria: z.string().min(1).optional(),
  dimensions: z.array(evalDimension).min(1).optional(),
  threshold: z.number().min(1).max(5).optional(),
}).refine(
  (e) => (e.criteria && e.criteria.trim().length > 0) || (e.dimensions && e.dimensions.length > 0),
  { message: "llm_review expectation requires criteria or dimensions" },
);

export const taskExpectationSchema = z.discriminatedUnion("type", [
  testExpectation,
  scriptExpectation,
  fileExistsExpectation,
  // llmReviewExpectation uses refine so can't be in discriminatedUnion — handled separately
]);

/**
 * Parse & validate a single expectation. Returns the validated value or null if invalid.
 */
export function parseExpectation(raw: unknown): TaskExpectation | null {
  // Try discriminated union first (test, script, file_exists)
  const result = taskExpectationSchema.safeParse(raw);
  if (result.success) return result.data as TaskExpectation;

  // Try llm_review separately (uses refine)
  const llmResult = llmReviewExpectation.safeParse(raw);
  if (llmResult.success) return llmResult.data as TaskExpectation;

  return null;
}

/**
 * Sanitize an array of expectations: keep only valid ones, silently drop malformed entries.
 * Returns the filtered array + list of warnings for dropped entries.
 */
export function sanitizeExpectations(raw: unknown[]): { valid: TaskExpectation[]; warnings: string[] } {
  const valid: TaskExpectation[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const parsed = parseExpectation(item);
    if (parsed) {
      valid.push(parsed);
    } else {
      const type = (item as Record<string, unknown>)?.type ?? "unknown";
      warnings.push(`expectation[${i}] (type: ${type}) dropped — missing required fields`);
    }
  }

  return { valid, warnings };
}

// ── Mission Checkpoint Schema ───────────────────────────────────────

export const missionCheckpointSchema = z.object({
  name: z.string().min(1, "checkpoint requires a name"),
  afterTasks: z.array(z.string().min(1)).min(1, "checkpoint requires at least one task in afterTasks"),
  blocksTasks: z.array(z.string().min(1)).min(1, "checkpoint requires at least one task in blocksTasks"),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

export const modelConfigSchema = z.object({
  primary: z.string().min(1),
  fallbacks: z.array(z.string().min(1)).max(MAX_MODEL_FALLBACKS).optional(),
}).strict();

export const modelProfileReferenceSchema = z.object({
  profile: z.string().regex(MODEL_PROFILE_NAME_PATTERN),
}).strict();

export const modelTargetSchema = z.union([
  z.string().min(1),
  modelProfileReferenceSchema,
]);

export const profiledModelConfigSchema = z.object({
  primary: modelTargetSchema,
  fallbacks: z.array(modelTargetSchema).max(MAX_MODEL_FALLBACKS).optional(),
}).strict();

export const modelSelectionSchema = z.union([
  z.string().min(1),
  modelProfileReferenceSchema,
  profiledModelConfigSchema,
]);

export const modelProfileRegistrySchema = z.record(
  z.string().regex(MODEL_PROFILE_NAME_PATTERN),
  modelSelectionSchema,
);

// ── Mission Delay Schema ────────────────────────────────────────────

export const missionDelaySchema = z.object({
  name: z.string().min(1, "delay requires a name"),
  afterTasks: z.array(z.string().min(1)).min(1, "delay requires at least one task in afterTasks"),
  blocksTasks: z.array(z.string().min(1)).min(1, "delay requires at least one task in blocksTasks"),
  duration: z.string().min(1, "delay requires a duration (ISO 8601, e.g. PT2H, PT30M, P1D)"),
  message: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

// ── Mission Quality Gate Schema ─────────────────────────────────────

export const missionQualityGateSchema = z.object({
  name: z.string().min(1, "quality gate requires a name"),
  afterTasks: z.array(z.string().min(1)).min(1, "quality gate requires at least one task in afterTasks"),
  blocksTasks: z.array(z.string().min(1)).min(1, "quality gate requires at least one task in blocksTasks"),
  minScore: z.number().min(1).max(5).optional(),
  requireAllPassed: z.boolean().optional(),
  condition: z.string().optional(),
  notifyChannels: z.array(z.string().min(1)).optional(),
});

// ── Mission Task Schema ─────────────────────────────────────────────

const missionTaskSchema = z.object({
  title: z.string().min(1, "task requires a title"),
  description: z.string().min(1, "task requires a description"),
  assignTo: z.string().min(1).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
  expectations: z.array(z.any()).optional(),
  expectedOutcomes: z.array(z.any()).optional(),
  metrics: z.array(z.any()).optional(),
  maxRetries: z.number().int().min(0).optional(),
  maxDuration: z.number().positive().optional(),
  retryPolicy: z.object({
    escalateAfter: z.number().int().min(0).optional(),
    fallbackAgent: z.string().optional(),
  }).optional(),
  notifications: z.any().optional(),
  sideEffects: z.boolean().optional(),
});

// ── Mission Document Schema ─────────────────────────────────────────

export const missionDocumentSchema = z.object({
  tasks: z.array(missionTaskSchema).min(1, "mission requires at least one task"),
  team: z.array(z.any()).optional(),
  qualityGates: z.array(missionQualityGateSchema).optional(),
  checkpoints: z.array(missionCheckpointSchema).optional(),
  delays: z.array(missionDelaySchema).optional(),
  notifications: z.any().optional(),
}).superRefine((doc, ctx) => {
  // Enforce unique task titles within a mission document
  const seen = new Set<string>();
  for (let i = 0; i < doc.tasks.length; i++) {
    const title = doc.tasks[i].title;
    if (seen.has(title)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate task title "${title}" — each task must have a unique title`,
        path: ["tasks", i, "title"],
      });
    }
    seen.add(title);
  }

  // Build task lookup: title → dependsOn set
  const taskDeps = new Map<string, Set<string>>();
  for (const t of doc.tasks) {
    taskDeps.set(t.title, new Set(t.dependsOn ?? []));
  }

  // Validate flow-control elements: blocksTasks must have dependsOn including afterTasks
  const validateFlowControl = (
    kind: "checkpoints" | "delays" | "qualityGates",
    items: Array<{ name: string; afterTasks: string[]; blocksTasks: string[] }>,
  ) => {
    for (let i = 0; i < items.length; i++) {
      const fc = items[i];
      // Check afterTasks reference valid task titles
      for (const t of fc.afterTasks) {
        if (!taskDeps.has(t)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind}[${i}] "${fc.name}": afterTasks references unknown task "${t}"`,
            path: [kind, i, "afterTasks"],
          });
        }
      }
      // Check blocksTasks reference valid titles AND have dependsOn on afterTasks
      for (const bt of fc.blocksTasks) {
        if (!taskDeps.has(bt)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind}[${i}] "${fc.name}": blocksTasks references unknown task "${bt}"`,
            path: [kind, i, "blocksTasks"],
          });
          continue;
        }
        const deps = taskDeps.get(bt)!;
        const missingDeps = fc.afterTasks.filter(at => !deps.has(at));
        if (missingDeps.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${kind}[${i}] "${fc.name}": task "${bt}" is in blocksTasks but missing dependsOn: [${missingDeps.map(d => `"${d}"`).join(", ")}]. Without dependsOn, the task will start in parallel ignoring the ${kind.slice(0, -1)}`,
            path: ["tasks", doc.tasks.findIndex(t => t.title === bt), "dependsOn"],
          });
        }
      }
    }
  };

  if (doc.checkpoints) validateFlowControl("checkpoints", doc.checkpoints);
  if (doc.delays) validateFlowControl("delays", doc.delays);
  if (doc.qualityGates) validateFlowControl("qualityGates", doc.qualityGates);
});

export type MissionDocumentParsed = z.infer<typeof missionDocumentSchema>;

// ── Loop Contract Schemas ───────────────────────────────────────────

export const conditionSchema = z.object({
  expression: z.string().min(1, "condition requires an expression"),
});

export const loopToolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z.object({
    mode: z.enum(["auto", "none", "required"]),
    tool: z.string().min(1).optional(),
  }),
]);

export const loopConfigSchema = z.object({
  name: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  toolChoice: loopToolChoiceSchema.optional(),
  model: modelSelectionSchema.optional(),
  reasoning: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTurns: z.number().int().positive().optional(),
  stopWhen: conditionSchema.optional(),
  output: z.object({
    schema: z.unknown().optional(),
  }).optional(),
}).superRefine((loop, ctx) => {
  if (loop.allowedTools !== undefined && loop.tools !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Use allowedTools or legacy tools, not both",
      path: ["allowedTools"],
    });
  }
});

export const loopNextSchema: z.ZodType<unknown> = z.union([
  z.string().min(1),
  z.array(z.object({
    when: z.string().min(1).optional(),
    to: z.string().min(1),
  })).min(1),
]);

export const loopStepConfigSchema = z.discriminatedUnion("type", [
  loopConfigSchema.extend({
    type: z.literal("agent"),
    when: z.string().min(1).optional(),
    next: loopNextSchema.optional(),
  }),
  z.object({
    type: z.literal("human"),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
    output: z.object({
      schema: z.unknown().optional(),
    }).optional(),
    notify: z.array(z.string().min(1)).optional(),
    next: loopNextSchema.optional(),
  }),
  z.object({
    type: z.literal("parallel"),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
    branches: z.array(z.string().min(1)).min(1),
    join: z.union([z.literal("all"), z.literal("any"), z.number().int().positive()]).optional(),
    next: loopNextSchema.optional(),
  }),
  z.object({
    type: z.literal("tool"),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
    tool: z.string().min(1),
    input: z.unknown().optional(),
    saveAs: z.string().min(1).optional(),
    next: loopNextSchema.optional(),
  }),
]);

const loopLifecycleHookNames = new Set<string>(LOOP_LIFECYCLE_HOOKS);

export const loopHookActionSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown().optional(),
  saveAs: z.string().min(1).optional(),
  when: z.string().min(1).optional(),
  onError: z.enum(["fail", "continue"]).optional(),
});

export const projectLoopHooksSchema = z.record(
  z.string().min(1),
  z.array(loopHookActionSchema).min(1),
).superRefine((hooks, ctx) => {
  for (const hook of Object.keys(hooks)) {
    if (!loopLifecycleHookNames.has(hook)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown loop hook "${hook}"`,
        path: [hook],
      });
    }
  }
});

export const projectLoopPolicySchema = z.object({
  id: z.string().min(1).optional(),
  description: z.string().optional(),
  hook: z.enum(LOOP_LIFECYCLE_HOOKS).optional(),
  effect: z.enum(["allow", "deny", "approval"]),
  when: z.string().min(1),
  message: z.string().optional(),
});

const stringOrStringArraySchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const projectLoopPermissionSchema = z.object({
  id: z.string().min(1).optional(),
  description: z.string().optional(),
  resource: z.enum(["loop", "step", "model", "tool", "human"]),
  action: z.string().min(1).optional(),
  effect: z.enum(["allow", "deny", "approval"]),
  match: z.object({
    loop: stringOrStringArraySchema.optional(),
    step: stringOrStringArraySchema.optional(),
    tool: stringOrStringArraySchema.optional(),
    human: stringOrStringArraySchema.optional(),
    hook: z.union([z.enum(LOOP_LIFECYCLE_HOOKS), z.array(z.enum(LOOP_LIFECYCLE_HOOKS)).min(1)]).optional(),
  }).optional(),
  when: z.string().min(1).optional(),
  message: z.string().optional(),
});

export const projectLoopConfigSchema = z.object({
  version: z.literal("1").optional(),
  kind: z.literal("graph").optional(),
  name: z.string().min(1),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  context: z.literal("shared").optional(),
  hooks: projectLoopHooksSchema.optional(),
  permissions: z.array(projectLoopPermissionSchema).optional(),
  policies: z.array(projectLoopPolicySchema).optional(),
  start: z.string().min(1),
  steps: z.record(z.string().min(1), z.union([
    loopConfigSchema.extend({
      type: z.literal("agent").optional(),
      when: z.string().min(1).optional(),
      next: loopNextSchema.optional(),
    }),
    z.object({
      type: z.literal("human"),
      label: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      when: z.string().min(1).optional(),
      output: z.object({ schema: z.unknown().optional() }).optional(),
      notify: z.array(z.string().min(1)).optional(),
      next: loopNextSchema.optional(),
    }),
    z.object({
      type: z.literal("parallel"),
      label: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      when: z.string().min(1).optional(),
      branches: z.array(z.string().min(1)).min(1),
      join: z.union([z.literal("all"), z.literal("any"), z.number().int().positive()]).optional(),
      next: loopNextSchema.optional(),
    }),
    z.object({
      type: z.literal("while"),
      label: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      when: z.string().min(1).optional(),
      condition: z.string().min(1).optional(),
      until: z.string().min(1).optional(),
      body: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      maxIterations: z.number().int().positive().optional(),
      next: loopNextSchema.optional(),
    }).refine((step) => !!step.condition || !!step.until, {
      message: "while step requires condition or until",
    }),
    z.object({
      type: z.literal("tool"),
      label: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      when: z.string().min(1).optional(),
      tool: z.string().min(1),
      input: z.unknown().optional(),
      saveAs: z.string().min(1).optional(),
      next: loopNextSchema.optional(),
    }),
  ])),
}).superRefine((loop, ctx) => {
  const knownSteps = new Set(Object.keys(loop.steps));
  if (!knownSteps.has(loop.start)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `start references unknown step "${loop.start}"`, path: ["start"] });
  }
  const checkTarget = (target: string, path: (string | number)[]) => {
    if (target !== "end" && !knownSteps.has(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `transition references unknown step "${target}"`, path });
    }
  };
  for (const [name, step] of Object.entries(loop.steps)) {
    if (step.type === "parallel") {
      step.branches.forEach((branch, i) => checkTarget(branch, ["steps", name, "branches", i]));
    }
    if (step.type === "while") {
      const body = Array.isArray(step.body) ? step.body : [step.body];
      body.forEach((entry, i) => checkTarget(entry, ["steps", name, "body", i]));
    }
    const toolChoice = (step as { toolChoice?: unknown }).toolChoice;
    if (toolChoice && typeof toolChoice === "object" && "tool" in toolChoice) {
      const forcedTool = (toolChoice as { tool?: unknown }).tool;
      const tools = (step as { tools?: unknown }).tools;
      if (typeof forcedTool === "string" && Array.isArray(tools) && !tools.includes(forcedTool)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `toolChoice references tool "${forcedTool}" not listed in step tools`,
          path: ["steps", name, "toolChoice"],
        });
      }
    }
    const next = (step as { next?: unknown }).next;
    if (typeof next === "string") checkTarget(next, ["steps", name, "next"]);
    if (Array.isArray(next)) {
      next.forEach((transition, i) => checkTarget(transition.to, ["steps", name, "next", i, "to"]));
    }
  }
});

export const loopStepSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.object({
    loop: z.string().min(1),
    when: z.string().min(1).optional(),
  }),
  z.object({
    tool: z.string().min(1),
    input: z.unknown().optional(),
    saveAs: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
  }),
  z.object({
    parallel: z.array(loopStepSchema).min(1),
    join: z.union([z.literal("all"), z.literal("any"), z.number().int().positive()]).optional(),
    when: z.string().min(1).optional(),
  }),
  z.object({
    while: z.object({
      condition: z.string().min(1).optional(),
      until: z.string().min(1).optional(),
      maxIterations: z.number().int().positive().optional(),
      steps: z.array(loopStepSchema).min(1),
    }).refine((value) => !!value.condition || !!value.until, {
      message: "while requires condition or until",
    }),
    when: z.string().min(1).optional(),
  }),
  z.object({
    switch: z.object({
      cases: z.array(z.object({
        when: z.string().min(1),
        steps: z.array(loopStepSchema).min(1),
      })).min(1),
      default: z.object({
        steps: z.array(loopStepSchema).min(1),
      }).optional(),
    }),
    when: z.string().min(1).optional(),
  }),
  z.object({
    human: z.string().min(1),
    output: z.object({
      schema: z.unknown().optional(),
    }).optional(),
    notify: z.array(z.string().min(1)).optional(),
    when: z.string().min(1).optional(),
  }),
]));

export const pipelineSchema = z.object({
  mode: z.enum(["sequential", "parallel"]).optional(),
  context: z.literal("shared").optional(),
  steps: z.array(loopStepSchema).min(1),
});

function collectLoopStepRefs(step: unknown, refs: string[]): void {
  if (!step || typeof step !== "object") return;
  const node = step as Record<string, unknown>;
  if (typeof node.loop === "string") {
    refs.push(node.loop);
    return;
  }
  if (Array.isArray(node.parallel)) {
    for (const child of node.parallel) collectLoopStepRefs(child, refs);
    return;
  }
  if (node.switch && typeof node.switch === "object") {
    const switchStep = node.switch as {
      cases?: Array<{ steps?: unknown[] }>;
      default?: { steps?: unknown[] };
    };
    for (const branch of switchStep.cases ?? []) {
      for (const child of branch.steps ?? []) collectLoopStepRefs(child, refs);
    }
    for (const child of switchStep.default?.steps ?? []) collectLoopStepRefs(child, refs);
    return;
  }
  if (node.while && typeof node.while === "object") {
    const whileStep = node.while as { steps?: unknown[] };
    for (const child of whileStep.steps ?? []) collectLoopStepRefs(child, refs);
  }
}

export const agentLoopConfigSchema = z.object({
  name: z.string().min(1).optional(),
  model: modelSelectionSchema.optional(),
  runtime: z.string().optional(),
  loops: z.record(z.string().min(1), loopConfigSchema),
  pipeline: pipelineSchema.optional(),
}).superRefine((config, ctx) => {
  if (!config.pipeline) return;
  const knownLoops = new Set(Object.keys(config.loops));
  const refs: string[] = [];
  for (const step of config.pipeline.steps) collectLoopStepRefs(step, refs);
  for (const ref of refs) {
    if (!knownLoops.has(ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pipeline references unknown loop "${ref}"`,
        path: ["pipeline"],
      });
    }
  }
});

/**
 * Parse and validate a mission JSON document strictly.
 * Returns the validated document or throws with a clear error message.
 */
export function parseMissionDocument(raw: unknown): MissionDocumentParsed {
  const result = missionDocumentSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid mission document: ${issues}`);
  }
  return result.data;
}
