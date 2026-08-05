import type { CompletionToolExecutor } from "./tool-guardrails.js";

export const MODEL_CONTROLLED_TOOL_NAMES = [
  "tool_list",
  "tool_search",
  "tool_load",
] as const;

const MODEL_CONTROLLED_TOOL_NAME_SET = new Set<string>(MODEL_CONTROLLED_TOOL_NAMES);

/** Host-owned opt-in for model-controlled progressive tool disclosure. */
export interface ModelControlledToolDisclosureConfig {
  mode: "model-controlled";
  initiallyLoaded?: readonly string[];
  maxLoadedTools?: number;
  maxLoadBatch?: number;
  maxSearchResults?: number;
}

export interface ModelControlledToolPoolOptions {
  tools: readonly any[];
  executor: CompletionToolExecutor;
  initiallyLoaded?: readonly string[];
  maxLoadedTools?: number;
  maxLoadBatch?: number;
  maxSearchResults?: number;
}

export interface ModelControlledToolPool {
  /** Complete authorized catalog plus the disclosure meta-tools. */
  tools: any[];
  /** Executes meta-tools locally and rejects calls to real tools until loaded. */
  executor: CompletionToolExecutor;
  /** Names to pass to AI SDK `activeTools` for the next model turn. */
  activeToolNames: () => string[];
  /** Freeze and return the model-visible pool for one model turn. */
  startModelTurn: () => string[];
  /** Polpo tool definitions active for compaction/token estimation. */
  activeTools: () => any[];
  /** Real tools currently visible to the model, excluding meta-tools. */
  loadedToolNames: () => string[];
}

interface CompactToolMetadata {
  name: string;
  label?: string;
  description?: string;
  source: string;
  category: string;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function toolName(tool: any): string {
  return typeof tool?.name === "string" ? tool.name.trim() : "";
}

function toolSource(tool: any): string {
  const name = toolName(tool);
  if (name === "skill_list" || name === "skill_read") return "skill";
  if (name.startsWith("mcp__") || typeof tool?.serverName === "string" || typeof tool?.mcpServer === "string") return "mcp";
  if (typeof tool?.connectionId === "string" || typeof tool?.providerId === "string") return "connection";
  if (typeof tool?.clientSide === "boolean") return "custom";
  return "runtime";
}

function toolCategory(tool: any): string {
  const name = toolName(tool);
  const source = toolSource(tool);
  if (source !== "runtime") return source;
  if (name.startsWith("memory_")) return "memory";
  if (name === "brain_search" || name === "source_read") return "knowledge";
  if (["read", "write", "edit", "ls", "glob", "grep"].includes(name) || name.startsWith("file_")) {
    return "filesystem";
  }
  if (name === "bash" || name.startsWith("shell_")) return "execution";
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("search_") || name === "http_fetch") return "search_http";
  if (name.startsWith("image_") || name.startsWith("video_") || name.startsWith("vision_")) return "media";
  if (name.startsWith("audio_")) return "audio";
  return "runtime";
}

function compactMetadata(tool: any): CompactToolMetadata {
  const description = typeof tool?.description === "string"
    ? tool.description.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, 240)
    : "";
  const label = typeof tool?.label === "string" ? tool.label.trim().slice(0, 120) : "";
  return {
    name: toolName(tool),
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    source: toolSource(tool),
    category: toolCategory(tool),
  };
}

function normalizedSearchText(value: unknown): string {
  return String(value ?? "")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

const GENERIC_SEARCH_TERMS = new Set([
  "a", "an", "and", "api", "call", "create", "delete", "fetch", "file",
  "find", "for", "get", "list", "message", "read", "run", "search", "send",
  "show", "the", "tool", "tools", "update", "use", "with",
]);

function matchesSignificantSearchTerm(tool: any, rawQuery: string): boolean {
  const terms = normalizedSearchText(rawQuery)
    .split(/\s+/)
    .filter((term) => term.length > 2 && !GENERIC_SEARCH_TERMS.has(term));
  if (terms.length === 0) return true;
  const metadata = compactMetadata(tool);
  const haystack = normalizedSearchText([
    metadata.name,
    metadata.label,
    metadata.description,
    metadata.source,
    metadata.category,
  ].filter(Boolean).join(" "));
  const tokens = new Set(haystack.split(/\s+/).filter(Boolean));
  return terms.some((term) =>
    tokens.has(term)
    || haystack.includes(term)
    || [...tokens].some((token) => token.startsWith(term) || term.startsWith(token)),
  );
}

function searchScore(tool: any, rawQuery: string): number {
  const query = normalizedSearchText(rawQuery).trim();
  if (!query) return 0;
  const terms = query.split(/\s+/).filter(Boolean);
  const metadata = compactMetadata(tool);
  const name = normalizedSearchText(metadata.name);
  const label = normalizedSearchText(metadata.label);
  const haystack = normalizedSearchText([
    metadata.name,
    metadata.label,
    metadata.description,
    metadata.source,
    metadata.category,
  ].filter(Boolean).join(" "));
  const tokens = new Set(haystack.split(/\s+/).filter(Boolean));
  let score = haystack.includes(query) ? 8 : 0;
  if (name.includes(query) || label.includes(query)) score += 6;
  for (const term of terms) {
    if (tokens.has(term)) {
      score += 4;
    } else if (haystack.includes(term)) {
      score += 2;
    } else if ([...tokens].some((token) => token.startsWith(term) || term.startsWith(token))) {
      score += 1;
    }
  }
  return score;
}

function disclosureTools(): any[] {
  return [
    {
      name: "tool_list",
      label: "List Tools",
      description: "List compact metadata for tools available to this agent. This does not load or execute tools.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional exact category filter." },
          source: { type: "string", description: "Optional exact source filter." },
          loaded: { type: "boolean", description: "When true, return only tools already loaded in this run." },
          limit: { type: "number", description: "Maximum results. Defaults to 40." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "tool_search",
      label: "Search Tools",
      description: "Search compact metadata for tools available to this agent. Review the results, then explicitly load exact tool names with tool_load.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Capability or tool name to search for." },
          limit: { type: "number", description: "Maximum matching tools. Defaults to 20." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "tool_load",
      label: "Load Tools",
      description: "Load one or more exact authorized tool names into the model's active tool pool for this run. Loading does not execute a tool or grant new permissions.",
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "Exact tool names returned by tool_search or tool_list.",
          },
        },
        required: ["names"],
        additionalProperties: false,
      },
    },
  ];
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

/**
 * Create one request-scoped, model-controlled progressive tool pool.
 *
 * `tools` must already be authorization-filtered by the host. Loading only
 * changes model visibility; execution is still checked against both the
 * authorized catalog and the current pool before reaching the host executor.
 */
export function createModelControlledToolPool(
  options: ModelControlledToolPoolOptions,
): ModelControlledToolPool {
  const catalog = new Map<string, any>();
  const catalogOrder: string[] = [];
  for (const tool of options.tools) {
    const name = toolName(tool);
    if (!name) continue;
    if (MODEL_CONTROLLED_TOOL_NAME_SET.has(name)) {
      throw new Error(`Tool catalog contains reserved disclosure name "${name}".`);
    }
    if (catalog.has(name)) {
      throw new Error(`Tool catalog contains duplicate tool name "${name}".`);
    }
    catalog.set(name, tool);
    catalogOrder.push(name);
  }

  const maxLoadedTools = positiveInteger(options.maxLoadedTools, 16);
  const maxLoadBatch = positiveInteger(options.maxLoadBatch, 8);
  const maxSearchResults = positiveInteger(options.maxSearchResults, 20);
  const loaded = new Set<string>();
  for (const rawName of options.initiallyLoaded ?? []) {
    const name = String(rawName).trim();
    if (!catalog.has(name)) {
      throw new Error(`Initially loaded tool "${name}" is not in the authorized catalog.`);
    }
    loaded.add(name);
  }
  if (loaded.size > maxLoadedTools) {
    throw new Error(`Initial tool pool exceeds the ${maxLoadedTools}-tool limit.`);
  }
  let executableThisTurn = new Set(loaded);
  const metaTools = disclosureTools();
  const metaToolsByName = new Map(metaTools.map((tool) => [tool.name, tool]));

  const activeToolNames = (): string[] => [
    ...catalogOrder.filter((name) => loaded.has(name)),
    ...MODEL_CONTROLLED_TOOL_NAMES,
  ];
  const startModelTurn = (): string[] => {
    executableThisTurn = new Set(loaded);
    return activeToolNames();
  };
  const activeTools = (): any[] => activeToolNames()
    .map((name) => catalog.get(name) ?? metaToolsByName.get(name))
    .filter(Boolean);
  const loadedToolNames = (): string[] => catalogOrder.filter((name) => loaded.has(name));

  const executor: CompletionToolExecutor = async (name, args, execution) => {
    if (name === "tool_list") {
      const category = typeof args.category === "string" ? args.category.trim() : "";
      const source = typeof args.source === "string" ? args.source.trim() : "";
      const loadedOnly = args.loaded === true;
      const limit = boundedLimit(args.limit, 40, 100);
      const matches = catalogOrder
        .filter((toolNameValue) => !loadedOnly || loaded.has(toolNameValue))
        .map((toolNameValue) => catalog.get(toolNameValue))
        .filter((tool) => !category || toolCategory(tool) === category)
        .filter((tool) => !source || toolSource(tool) === source);
      return JSON.stringify({
        tools: matches.slice(0, limit).map(compactMetadata),
        total: matches.length,
        truncated: matches.length > limit,
      });
    }

    if (name === "tool_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return "Error: tool_search requires a non-empty query.";
      const limit = boundedLimit(args.limit, maxSearchResults, 50);
      const matches = catalogOrder
        .map((toolNameValue) => catalog.get(toolNameValue))
        .filter((tool) => matchesSignificantSearchTerm(tool, query))
        .map((tool) => ({ tool, score: searchScore(tool, query) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || toolName(left.tool).localeCompare(toolName(right.tool)));
      return JSON.stringify({
        query,
        tools: matches.slice(0, limit).map((entry) => compactMetadata(entry.tool)),
        total: matches.length,
        truncated: matches.length > limit,
      });
    }

    if (name === "tool_load") {
      if (!Array.isArray(args.names)) {
        return "Error: tool_load requires an array of exact tool names.";
      }
      const names = [...new Set(args.names.map((value) => typeof value === "string" ? value.trim() : ""))];
      if (names.length === 0 || names.some((value) => !value)) {
        return "Error: tool_load requires at least one exact tool name.";
      }
      if (names.length > maxLoadBatch) {
        return `Error: tool_load accepts at most ${maxLoadBatch} names per call.`;
      }
      for (const requested of names) {
        if (!catalog.has(requested)) {
          return `Error: Tool "${requested}" is not available to this agent.`;
        }
      }
      const additions = names.filter((requested) => !loaded.has(requested));
      if (loaded.size + additions.length > maxLoadedTools) {
        return `Error: Tool pool limit reached (${maxLoadedTools} loaded tools).`;
      }
      for (const requested of additions) loaded.add(requested);
      return JSON.stringify({
        loaded: names,
        active: loadedToolNames(),
        remainingCapacity: maxLoadedTools - loaded.size,
      });
    }

    if (!catalog.has(name)) return `Error: Unknown tool "${name}".`;
    if (!executableThisTurn.has(name)) {
      return `Error: Tool "${name}" is not active in this model turn. Use tool_search and tool_load, then call it on the next turn.`;
    }
    return options.executor(name, args, execution);
  };

  return {
    tools: [...catalogOrder.map((name) => catalog.get(name)), ...metaTools],
    executor,
    activeToolNames,
    startModelTurn,
    activeTools,
    loadedToolNames,
  };
}

/** Extract an exact forced AI SDK tool choice, if one is configured. */
export function forcedModelToolName(toolChoice: unknown): string | undefined {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return undefined;
  const candidate = toolChoice as { type?: unknown; toolName?: unknown };
  return candidate.type === "tool"
    && typeof candidate.toolName === "string"
    && candidate.toolName.trim()
    ? candidate.toolName.trim()
    : undefined;
}

export const MODEL_CONTROLLED_TOOL_PROMPT = [
  "## Tool discovery",
  "",
  "Only a compact discovery catalog is initially visible for most tools.",
  "Use tool_search or tool_list to inspect available capabilities. Discovery is read-only.",
  "After reviewing the returned names and descriptions, explicitly call tool_load with only the exact tools you need.",
  "Loaded tools become directly callable with their original schemas on the next turn.",
  "You may search and load additional tools later in the same run. Loading never grants permissions or executes a tool.",
].join("\n");
