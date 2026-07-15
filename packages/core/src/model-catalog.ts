import type { ModelRuntimeMode } from "./model-runtime.js";

export const MODEL_CATALOG_LEGACY_TYPES = [
  "language",
  "embedding",
  "image",
  "video",
  "audio",
] as const;

export const MODEL_CATALOG_MODALITIES = [
  "text",
  "image",
  "audio",
  "video",
  "file",
] as const;

export const MODEL_CATALOG_OUTPUT_MODALITIES = [
  "text",
  "image",
  "audio",
  "embedding",
  "video",
] as const;

export const MODEL_CATALOG_CAPABILITIES = [
  "tools",
  "vision",
  "reasoning",
  "file_input",
  "caching",
  "web_search",
  "long_context",
  "cheap",
  "fast",
  "structured_output",
  "transcription",
  "speech",
] as const;

export type ModelCatalogLegacyType = typeof MODEL_CATALOG_LEGACY_TYPES[number];
export type ModelCatalogModality = typeof MODEL_CATALOG_MODALITIES[number];
export type ModelCatalogOutputModality = typeof MODEL_CATALOG_OUTPUT_MODALITIES[number];
export type ModelCatalogCapability = typeof MODEL_CATALOG_CAPABILITIES[number];
export type ModelCatalogSource = "provider" | "gateway" | "static" | "configured";
export type ModelCatalogAgentField =
  | "model"
  | "image_model"
  | "video_model"
  | "vision_model"
  | "transcribe_model"
  | "tts_model";

export interface ModelCatalogPricing {
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  cachedInputPerMillionTokens?: number;
  cacheCreationInputPerMillionTokens?: number;
}

export interface ModelCatalogEntry {
  id: string;
  displayName: string;
  provider: string;
  source: ModelCatalogSource;
  modes: ModelRuntimeMode[];
  agentField: ModelCatalogAgentField;
  inputModalities: ModelCatalogModality[];
  outputModalities: ModelCatalogOutputModality[];
  capabilities: ModelCatalogCapability[];
  pricing?: ModelCatalogPricing;
  contextWindow?: number;
  maxOutputTokens?: number;
  credentialService?: string;
  confidence: "authoritative" | "reported" | "heuristic" | "configured";
}

export interface ModelCatalogSearchInput {
  /**
   * Legacy search discriminator kept for compatibility with existing MCP/UI
   * callers. Prefer `modality` plus `capabilities` for new callers.
   */
  type?: string;
  modality?: string;
  capability?: string;
  capabilities?: readonly string[];
}

export interface NormalizedModelCatalogSearchFilters {
  /**
   * Backward-compatible type value used by legacy read paths.
   */
  type?: ModelCatalogLegacyType;
  modality?: ModelCatalogModality;
  capabilities: ModelCatalogCapability[];
  warnings: string[];
}

const LEGACY_TYPE_ALIASES: Record<string, {
  type: ModelCatalogLegacyType;
  modality?: ModelCatalogModality;
  capabilities?: ModelCatalogCapability[];
  warning?: string;
}> = {
  language: { type: "language", modality: "text" },
  text: {
    type: "language",
    modality: "text",
    warning: '`type: "text"` is a legacy alias. Prefer `type: "language"` or `modality: "text"`.',
  },
  chat: {
    type: "language",
    modality: "text",
    warning: '`type: "chat"` is a legacy alias. Prefer `type: "language"` or `modality: "text"`.',
  },
  embedding: { type: "embedding" },
  embeddings: {
    type: "embedding",
    warning: '`type: "embeddings"` is a legacy alias. Prefer `type: "embedding"`.',
  },
  image: { type: "image", modality: "image" },
  video: { type: "video", modality: "video" },
  audio: { type: "audio", modality: "audio" },
  transcription: {
    type: "audio",
    modality: "audio",
    capabilities: ["transcription"],
    warning: '`type: "transcription"` is a legacy alias. Prefer `modality: "audio", capabilities: ["transcription"]`.',
  },
  stt: {
    type: "audio",
    modality: "audio",
    capabilities: ["transcription"],
    warning: '`type: "stt"` is a legacy alias. Prefer `modality: "audio", capabilities: ["transcription"]`.',
  },
  "speech-to-text": {
    type: "audio",
    modality: "audio",
    capabilities: ["transcription"],
    warning: '`type: "speech-to-text"` is a legacy alias. Prefer `modality: "audio", capabilities: ["transcription"]`.',
  },
  speech: {
    type: "audio",
    modality: "audio",
    capabilities: ["speech"],
    warning: '`type: "speech"` is a legacy alias. Prefer `modality: "audio", capabilities: ["speech"]`.',
  },
  tts: {
    type: "audio",
    modality: "audio",
    capabilities: ["speech"],
    warning: '`type: "tts"` is a legacy alias. Prefer `modality: "audio", capabilities: ["speech"]`.',
  },
  "text-to-speech": {
    type: "audio",
    modality: "audio",
    capabilities: ["speech"],
    warning: '`type: "text-to-speech"` is a legacy alias. Prefer `modality: "audio", capabilities: ["speech"]`.',
  },
};

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  return normalized || undefined;
}

function uniqueCapabilities(values: ModelCatalogCapability[]): ModelCatalogCapability[] {
  return [...new Set(values)].sort();
}

export function isModelCatalogLegacyType(value: string): value is ModelCatalogLegacyType {
  return (MODEL_CATALOG_LEGACY_TYPES as readonly string[]).includes(value);
}

export function isModelCatalogModality(value: string): value is ModelCatalogModality {
  return (MODEL_CATALOG_MODALITIES as readonly string[]).includes(value);
}

export function isModelCatalogCapability(value: string): value is ModelCatalogCapability {
  return (MODEL_CATALOG_CAPABILITIES as readonly string[]).includes(value);
}

export function normalizeModelCatalogSearchFilters(input: ModelCatalogSearchInput = {}): NormalizedModelCatalogSearchFilters {
  const warnings: string[] = [];
  const capabilities: ModelCatalogCapability[] = [];
  let type: ModelCatalogLegacyType | undefined;
  let modality: ModelCatalogModality | undefined;

  const rawType = normalizeString(input.type);
  if (rawType !== undefined) {
    const legacy = LEGACY_TYPE_ALIASES[rawType];
    if (!legacy) {
      throw new Error(
        `Unsupported model type "${input.type}". Use one of ${MODEL_CATALOG_LEGACY_TYPES.join(", ")} or prefer modality/capabilities filters.`,
      );
    }
    type = legacy.type;
    modality = legacy.modality;
    if (legacy.capabilities) capabilities.push(...legacy.capabilities);
    if (legacy.warning) warnings.push(legacy.warning);
  }

  const rawModality = normalizeString(input.modality);
  if (rawModality !== undefined) {
    if (!isModelCatalogModality(rawModality)) {
      throw new Error(`Unsupported model modality "${input.modality}". Use one of ${MODEL_CATALOG_MODALITIES.join(", ")}.`);
    }
    modality = rawModality;
    if (type === undefined) {
      if (rawModality === "text") type = "language";
      else if (rawModality === "image") type = "image";
      else if (rawModality === "video") type = "video";
      else if (rawModality === "audio") type = "audio";
    }
  }

  const rawCapabilities = [
    input.capability,
    ...(input.capabilities ?? []),
  ];
  for (const rawCapability of rawCapabilities) {
    const normalizedCapability = normalizeString(rawCapability);
    if (normalizedCapability === undefined) continue;
    const capability = normalizedCapability === "structured-output"
      ? "structured_output"
      : normalizedCapability === "file-input"
        ? "file_input"
        : normalizedCapability;
    if (!isModelCatalogCapability(capability)) {
      throw new Error(`Unsupported model capability "${rawCapability}". Use one of ${MODEL_CATALOG_CAPABILITIES.join(", ")}.`);
    }
    capabilities.push(capability);
  }

  return {
    type,
    modality,
    capabilities: uniqueCapabilities(capabilities),
    warnings,
  };
}
