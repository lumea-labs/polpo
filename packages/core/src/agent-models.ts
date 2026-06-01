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
