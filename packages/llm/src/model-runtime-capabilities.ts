import type { ToolChoice, ToolSet } from "ai";
import {
  canonicalContractFingerprint,
  type PolpoToolStrictness,
} from "@polpo-ai/core";
import { compileToolInputSchemaForRuntime } from "./tool-schema.js";

export type RuntimeCapabilitySupport = "supported" | "unsupported" | "unknown";
export type StructuredOutputCapability = "native" | "emulated" | "unsupported" | "unknown";
export type CombinedToolsOutputCapability = "conformant" | "unsupported" | "unknown";

/** Capabilities of one concrete provider/model/adapter/endpoint route. */
export interface ModelRuntimeCapabilities {
  tools: boolean;
  providerStrictTools: RuntimeCapabilitySupport;
  structuredOutput: StructuredOutputCapability;
  combinedToolsAndOutput: CombinedToolsOutputCapability;
  parallelToolCalls: RuntimeCapabilitySupport;
  providerExecutedTools: RuntimeCapabilitySupport;
  streamedToolInput: RuntimeCapabilitySupport;
}

export const UNKNOWN_MODEL_RUNTIME_CAPABILITIES: Readonly<ModelRuntimeCapabilities> = Object.freeze({
  tools: true,
  providerStrictTools: "unknown",
  structuredOutput: "unknown",
  combinedToolsAndOutput: "unknown",
  parallelToolCalls: "unknown",
  providerExecutedTools: "unknown",
  streamedToolInput: "unknown",
});

export function directProviderRuntimeCapabilities(provider: string): ModelRuntimeCapabilities {
  const normalized = provider.trim().toLowerCase();
  if (["openai", "google", "xai"].includes(normalized)) {
    return {
      tools: true,
      providerStrictTools: "supported",
      structuredOutput: "native",
      combinedToolsAndOutput: "unknown",
      parallelToolCalls: normalized === "google" ? "unknown" : "supported",
      providerExecutedTools: normalized === "openai" ? "supported" : "unknown",
      streamedToolInput: "supported",
    };
  }
  if (normalized === "anthropic") {
    return {
      ...UNKNOWN_MODEL_RUNTIME_CAPABILITIES,
      tools: true,
      providerStrictTools: "unsupported",
      structuredOutput: "emulated",
      parallelToolCalls: "supported",
      streamedToolInput: "supported",
    };
  }
  if (["groq", "mistral"].includes(normalized)) {
    return {
      ...UNKNOWN_MODEL_RUNTIME_CAPABILITIES,
      tools: true,
      structuredOutput: "emulated",
    };
  }
  return { ...UNKNOWN_MODEL_RUNTIME_CAPABILITIES };
}

const strictnessByTool = new WeakMap<object, PolpoToolStrictness>();

/** Preserve Polpo strictness without adding provider-visible extension fields. */
export function markToolStrictness<T extends object>(
  tool: T,
  strictness: PolpoToolStrictness | undefined,
): T {
  if (strictness) strictnessByTool.set(tool, strictness);
  return tool;
}

export type ToolCapabilityWarning =
  | {
      readonly type: "tool-strictness-unavailable";
      readonly toolName: string;
      readonly requested: "provider-preferred";
      readonly capability: "unsupported" | "unknown";
    }
  | {
      readonly type: "tool-schema-constraint-local-only";
      readonly toolName: string;
      readonly capability: "unsupported" | "unknown";
    };

export interface CompiledVisibleTool {
  readonly name: string;
  readonly inputSchemaFingerprint: string;
  readonly providerStrict: boolean;
}

export interface EffectiveTurnPlan {
  readonly phase: "operational" | "terminal-output";
  readonly tools: readonly CompiledVisibleTool[];
  readonly activeTools: readonly string[];
  readonly toolChoice: "auto" | "required" | "none" | { readonly tool: string };
  readonly hasOutputContract: boolean;
  readonly capabilities: Readonly<ModelRuntimeCapabilities>;
  readonly warnings: readonly ToolCapabilityWarning[];
}

export class ToolCapabilityUnsupportedError extends Error {
  readonly code = "tool_capability_unsupported" as const;

  constructor(
    readonly toolName: string,
    readonly capability: "unsupported" | "unknown",
  ) {
    super(
      `Tool ${JSON.stringify(toolName)} requires provider-native strict input generation, but the selected runtime capability is ${capability}`,
    );
    this.name = "ToolCapabilityUnsupportedError";
  }
}

export class ToolChoiceInvalidError extends Error {
  readonly code = "tool_choice_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ToolChoiceInvalidError";
  }
}

export class OutputCapabilityUnsupportedError extends Error {
  readonly code = "output_capability_unsupported" as const;

  constructor(message: string) {
    super(message);
    this.name = "OutputCapabilityUnsupportedError";
  }
}

/** Reject impossible tool/output plans before a provider request is created. */
export function assertModelTurnCapabilityPlan<TOOLS extends ToolSet>(input: {
  tools?: TOOLS;
  activeTools?: Array<keyof TOOLS>;
  toolChoice?: ToolChoice<TOOLS>;
  output?: unknown;
  capabilities?: ModelRuntimeCapabilities;
}): void {
  const allNames = Object.keys(input.tools ?? {});
  const activeNames = input.activeTools
    ? input.activeTools.map(String)
    : allNames;
  const all = new Set(allNames);
  const active = new Set(activeNames);
  for (const name of active) {
    if (!all.has(name)) {
      throw new ToolChoiceInvalidError(
        `Active tool ${JSON.stringify(name)} is not present in the model-visible inventory`,
      );
    }
  }
  if (active.size > 0 && input.capabilities?.tools === false) {
    throw new ToolCapabilityUnsupportedError(activeNames[0]!, "unsupported");
  }
  if (input.toolChoice === "required" && active.size === 0) {
    throw new ToolChoiceInvalidError("toolChoice required needs at least one active tool");
  }
  if (input.toolChoice === "none" && active.size > 0) {
    throw new ToolChoiceInvalidError(
      "toolChoice none requires an empty model-visible tool inventory",
    );
  }
  if (input.toolChoice && typeof input.toolChoice === "object") {
    const forced = "toolName" in input.toolChoice
      ? String(input.toolChoice.toolName)
      : undefined;
    if (forced && !active.has(forced)) {
      throw new ToolChoiceInvalidError(
        `Forced tool ${JSON.stringify(forced)} is not active and model-visible`,
      );
    }
  }
  if (
    input.output !== undefined
    && active.size > 0
    && input.capabilities?.combinedToolsAndOutput !== "conformant"
  ) {
    throw new OutputCapabilityUnsupportedError(
      "Operational tools and terminal structured output require separate model turns for this runtime route",
    );
  }
  if (input.output !== undefined && input.capabilities?.structuredOutput === "unsupported") {
    throw new OutputCapabilityUnsupportedError(
      "The selected runtime route does not support structured output",
    );
  }
}

export function prepareToolsForRuntimeCapabilities<TOOLS extends ToolSet>(
  tools: TOOLS | undefined,
  capabilities: ModelRuntimeCapabilities | undefined,
): { tools: TOOLS | undefined; warnings: ToolCapabilityWarning[] } {
  if (!tools) return { tools, warnings: [] };
  const support = capabilities?.providerStrictTools ?? "unknown";
  const warnings: ToolCapabilityWarning[] = [];
  let changed = false;
  const entries = Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object") return [name, tool] as const;
    const compiledSchema = compileToolInputSchemaForRuntime(
      (tool as { inputSchema?: unknown }).inputSchema,
      { preserveCanonicalConstraints: support === "supported" },
    );
    let preparedTool: Record<string, unknown> = tool as Record<string, unknown>;
    if (compiledSchema.inputSchema !== preparedTool.inputSchema) {
      preparedTool = { ...preparedTool, inputSchema: compiledSchema.inputSchema };
      changed = true;
    }
    if (compiledSchema.constraintsLocalOnly) {
      warnings.push({
        type: "tool-schema-constraint-local-only",
        toolName: name,
        capability: support === "supported" ? "unknown" : support,
      });
    }
    const strictness = strictnessByTool.get(tool);
    if (!strictness || strictness === "execution") return [name, preparedTool] as const;
    if (strictness === "provider-required" && support !== "supported") {
      throw new ToolCapabilityUnsupportedError(name, support);
    }
    if (support === "supported") {
      if ((preparedTool as { strict?: boolean }).strict === true) return [name, preparedTool] as const;
      changed = true;
      return [name, { ...preparedTool, strict: true }] as const;
    }
    warnings.push({
      type: "tool-strictness-unavailable",
      toolName: name,
      requested: "provider-preferred",
      capability: support,
    });
    if (!("strict" in preparedTool)) return [name, preparedTool] as const;
    changed = true;
    const { strict: _strict, ...withoutStrict } = preparedTool;
    return [name, withoutStrict] as const;
  });
  return {
    tools: (changed ? Object.fromEntries(entries) : tools) as TOOLS,
    warnings,
  };
}

function normalizedToolChoice<TOOLS extends ToolSet>(
  value: ToolChoice<TOOLS> | undefined,
): EffectiveTurnPlan["toolChoice"] {
  if (value === "required" || value === "none" || value === "auto") return value;
  if (value && typeof value === "object" && "toolName" in value) {
    return { tool: String(value.toolName) };
  }
  return "auto";
}

/** Build the immutable provider-neutral plan before any model network I/O. */
export function createEffectiveTurnPlan<TOOLS extends ToolSet>(input: {
  tools?: TOOLS;
  activeTools?: Array<keyof TOOLS>;
  toolChoice?: ToolChoice<TOOLS>;
  output?: unknown;
  capabilities?: ModelRuntimeCapabilities;
}): { plan: EffectiveTurnPlan; preparedTools: TOOLS | undefined } {
  const prepared = prepareToolsForRuntimeCapabilities(input.tools, input.capabilities);
  assertModelTurnCapabilityPlan({
    ...(prepared.tools ? { tools: prepared.tools } : {}),
    ...(input.activeTools ? { activeTools: input.activeTools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.output ? { output: input.output } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  });
  const allNames = Object.keys(prepared.tools ?? {});
  const activeTools = input.activeTools?.map(String) ?? allNames;
  const active = new Set(activeTools);
  const visibleTools = Object.entries(prepared.tools ?? {})
    .filter(([name]) => active.has(name))
    .map(([name, tool]) => {
      const schema = tool && typeof tool === "object"
        ? (tool as { inputSchema?: { jsonSchema?: unknown } }).inputSchema?.jsonSchema
        : undefined;
      return Object.freeze({
        name,
        inputSchemaFingerprint: canonicalContractFingerprint(schema ?? null),
        providerStrict: Boolean(tool && typeof tool === "object" && (tool as any).strict === true),
      });
    });
  const capabilities = Object.freeze({
    ...(input.capabilities ?? UNKNOWN_MODEL_RUNTIME_CAPABILITIES),
  });
  const plan: EffectiveTurnPlan = Object.freeze({
    phase: input.output !== undefined && activeTools.length === 0
      ? "terminal-output"
      : "operational",
    tools: Object.freeze(visibleTools),
    activeTools: Object.freeze([...activeTools]),
    toolChoice: normalizedToolChoice(input.toolChoice),
    hasOutputContract: input.output !== undefined,
    capabilities,
    warnings: Object.freeze([...prepared.warnings]),
  });
  return { plan, preparedTools: prepared.tools };
}
