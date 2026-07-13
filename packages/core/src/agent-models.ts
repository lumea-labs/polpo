/**
 * Agent media-model configuration helpers.
 *
 * Polpo agents declare their generative/perceptive backends as
 * `provider/model` strings on the AgentConfig — same shape as the LLM
 * model field. This module is the single source of truth for:
 *   - parsing those strings into a typed `{ provider, model }` pair,
 *   - the canonical defaults per modality,
 *   - resolving a tool's effective model (config > default).
 *
 * The tool layer reads from here; it never invents defaults of its own.
 */

// ── Canonical defaults ──
//
// Format: `<provider>/<model>` where the FIRST `/` is the separator.
// Provider names are stable; model ids may move with provider catalogs.
//
// These defaults are picked to match what `audio_transcribe` / `image_generate`
// / etc shipped with before the agent-config refactor — so an agent that
// doesn't configure anything keeps its prior behavior.

export const DEFAULT_IMAGE_MODEL      = "fal/fal-ai/flux/dev";
export const DEFAULT_VIDEO_MODEL      = "fal/luma-ray-2-flash";
export const DEFAULT_VISION_MODEL     = "openai/gpt-4o-mini";
export const DEFAULT_TRANSCRIBE_MODEL = "openai/whisper-1";
// Edge TTS is free + local (no API key) — the sensible zero-config default.
export const DEFAULT_TTS_MODEL        = "edge/edge-tts";
export const DEFAULT_SEARCH_PROVIDER  = "exa";

// ── Audio model catalog ──

export type AudioModelCapability = "transcription" | "speech";
export type AudioModelRouting = "direct" | "local";

export interface AudioModelDefinition {
  /** Stable provider/model value stored on AgentConfig. */
  id: string;
  /** Human-readable model or voice name. */
  name: string;
  provider: "openai" | "deepgram" | "elevenlabs" | "edge";
  capability: AudioModelCapability;
  /** Direct providers use the agent vault; local models run in the sandbox. */
  routing: AudioModelRouting;
  /** Vault service required by direct providers. */
  credentialService?: "openai" | "deepgram" | "elevenlabs";
  language?: string;
  description?: string;
}

/**
 * Models explicitly supported by Polpo's audio tool adapters.
 *
 * This is the shared discovery catalog for dashboards and builders. The tool
 * runtime still accepts any valid provider/model override so provider catalog
 * additions do not require a Polpo release before advanced users can use them.
 */
export const AUDIO_MODEL_CATALOG: readonly AudioModelDefinition[] = [
  {
    id: "openai/whisper-1",
    name: "Whisper 1",
    provider: "openai",
    capability: "transcription",
    routing: "direct",
    credentialService: "openai",
  },
  {
    id: "openai/gpt-4o-transcribe",
    name: "GPT-4o Transcribe",
    provider: "openai",
    capability: "transcription",
    routing: "direct",
    credentialService: "openai",
  },
  {
    id: "openai/gpt-4o-mini-transcribe",
    name: "GPT-4o mini Transcribe",
    provider: "openai",
    capability: "transcription",
    routing: "direct",
    credentialService: "openai",
  },
  {
    id: "deepgram/nova-3",
    name: "Nova 3",
    provider: "deepgram",
    capability: "transcription",
    routing: "direct",
    credentialService: "deepgram",
    description: "Deepgram's general-purpose multilingual transcription model.",
  },
  {
    id: "deepgram/nova-2",
    name: "Nova 2",
    provider: "deepgram",
    capability: "transcription",
    routing: "direct",
    credentialService: "deepgram",
  },
  {
    id: "edge/edge-tts",
    name: "Edge TTS",
    provider: "edge",
    capability: "speech",
    routing: "local",
    description: "Free local speech synthesis in the agent sandbox.",
  },
  {
    id: "openai/tts-1",
    name: "TTS 1",
    provider: "openai",
    capability: "speech",
    routing: "direct",
    credentialService: "openai",
  },
  {
    id: "openai/tts-1-hd",
    name: "TTS 1 HD",
    provider: "openai",
    capability: "speech",
    routing: "direct",
    credentialService: "openai",
  },
  {
    id: "openai/gpt-4o-mini-tts",
    name: "GPT-4o mini TTS",
    provider: "openai",
    capability: "speech",
    routing: "direct",
    credentialService: "openai",
  },
  {
    id: "deepgram/aura-2-livia-it",
    name: "Aura 2 Livia",
    provider: "deepgram",
    capability: "speech",
    routing: "direct",
    credentialService: "deepgram",
    language: "it",
  },
  {
    id: "deepgram/aura-2-dionisio-it",
    name: "Aura 2 Dionisio",
    provider: "deepgram",
    capability: "speech",
    routing: "direct",
    credentialService: "deepgram",
    language: "it",
  },
  {
    id: "deepgram/aura-2-helena-en",
    name: "Aura 2 Helena",
    provider: "deepgram",
    capability: "speech",
    routing: "direct",
    credentialService: "deepgram",
    language: "en",
  },
  {
    id: "deepgram/aura-2-thalia-en",
    name: "Aura 2 Thalia",
    provider: "deepgram",
    capability: "speech",
    routing: "direct",
    credentialService: "deepgram",
    language: "en",
  },
  {
    id: "elevenlabs/eleven_multilingual_v2",
    name: "Eleven Multilingual v2",
    provider: "elevenlabs",
    capability: "speech",
    routing: "direct",
    credentialService: "elevenlabs",
  },
] as const;

export function listAudioModels(capability?: AudioModelCapability): AudioModelDefinition[] {
  return AUDIO_MODEL_CATALOG
    .filter((model) => capability === undefined || model.capability === capability)
    .map((model) => ({ ...model }));
}

export function getAudioModel(id: string): AudioModelDefinition | undefined {
  const model = AUDIO_MODEL_CATALOG.find((candidate) => candidate.id === id);
  return model ? { ...model } : undefined;
}

// ── Parse helper ──

export interface ParsedModel {
  /** Provider key — used to dispatch to the right SDK package / resolver. */
  provider: string;
  /** Provider-specific model id. May contain further `/` segments. */
  model: string;
}

/**
 * Split a `<provider>/<model>` string on the FIRST `/`.
 *
 * Some model ids contain slashes (e.g. fal exposes `fal-ai/flux/dev` —
 * three segments) so we must keep everything after the first separator
 * as one opaque string. Bare `model` with no provider is rejected; use
 * the explicit `provider/` prefix.
 *
 * Throws on an empty input or a string without a `/`. The caller is
 * responsible for validating that `provider` is supported for its
 * modality.
 */
export function parseModelString(value: string): ParsedModel {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Model string must be a non-empty string");
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(
      `Invalid model string '${value}': expected '<provider>/<model>' with provider and model both non-empty`,
    );
  }
  return {
    provider: value.slice(0, slash),
    model: value.slice(slash + 1),
  };
}
