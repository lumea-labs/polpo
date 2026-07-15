/**
 * Lazy resolvers that map a Polpo provider name + ResolvedVault into an
 * AI SDK provider instance. Each resolver dynamically imports the
 * provider package so it stays optional — installing `@polpo-ai/tools`
 * does not pull in `@ai-sdk/fal` / `@ai-sdk/anthropic` / etc unless the
 * matching tool is actually used.
 *
 * Vault key conventions (must match the strings in the tools):
 *   - `fal-ai` / "key"     → fal.ai (image_generate, video_generate)
 *   - `openai`  / "key"    → OpenAI (image_analyze)
 *   - `anthropic` / "key"  → Anthropic (image_analyze)
 *
 * Env-var fallbacks are read by the tool layer, not here. Resolvers
 * receive a fully-resolved API key string.
 */

// ── Public types ──
//
// We deliberately type the model handles as `unknown` here. The `ai`
// package accepts whatever the provider returns; pinning to a specific
// `ImageModelVx` from `@ai-sdk/provider` would couple us to a single
// provider-spec version and force a peerDep bump on every SDK
// promotion. The downstream `generateImage({ model })` /
// `generateText({ model })` calls do their own type checking.

import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core";

export type ImageProviderName = "fal";
export type VisionProviderName = "openai" | "anthropic";
export type VideoProviderName = "fal";
export type TranscribeProviderName = "openai" | "deepgram";
export type SpeakProviderName = "openai" | "deepgram" | "elevenlabs" | "edge";

export interface ImageProvider {
  image(modelId: string): unknown;
}

export interface VideoProvider {
  video(modelId: string): unknown;
}

export interface TranscribeProvider {
  transcription(modelId: string): unknown;
}

export interface SpeakProvider {
  speech(modelId: string): unknown;
}

/** Mirrors the `@ai-sdk/openai` / `@ai-sdk/anthropic` factory shape: a callable that returns a language-model handle for a given model id. */
export interface VisionProvider {
  (modelId: string): unknown;
}

// ── Resolvers ──

/** Build a fal.ai image provider. Throws a friendly error if the optional `@ai-sdk/fal` package is not installed. */
export async function resolveImageProvider(
  name: ImageProviderName,
  apiKey: string,
): Promise<ImageProvider> {
  if (name !== "fal") {
    throw new Error(`Unknown image provider: ${name}`);
  }
  const mod = await loadOptional("@ai-sdk/fal", "image_generate");
  // @ts-ignore — mod typed as `any` from the dynamic import helper
  const fal = mod.createFal({ apiKey });
  return { image: (modelId: string) => fal.image(modelId) };
}

/** Build a video provider — currently fal.ai only. */
export async function resolveVideoProvider(
  name: VideoProviderName,
  apiKey: string,
): Promise<VideoProvider> {
  if (name !== "fal") {
    throw new Error(`Unknown video provider: ${name}`);
  }
  // fal.ai uses image-style queue API even for video; reuse the image
  // provider's queue path. The `ai` SDK `experimental_generateVideo`
  // accepts the result of `fal.video(...)`.
  const mod = await loadOptional("@ai-sdk/fal", "video_generate");
  // @ts-ignore — mod typed as `any` from the dynamic import helper
  const fal = mod.createFal({ apiKey });
  return { video: (modelId: string) => fal.video(modelId) };
}

// ── Managed (Vercel AI Gateway) resolvers ──
//
// Used when the runtime has an AI_GATEWAY_API_KEY and the agent has NO
// provider key of its own. The gateway pays via the configured runtime key
// and returns cost in `providerMetadata.gateway`
// (generationId/marketCost/cost) — the same shape completions already meter.
// BYOK stays on the direct-SDK path above; this is purely additive.

/** A fetch with an extended Undici timeout. Video generation can take
 *  5–15 min — well past Undici's default 5-min headers/body timeout, which
 *  would otherwise abort the request mid-render. Degrades to the default
 *  fetch if `undici` can't be loaded. */
async function makeLongTimeoutFetch(
  timeoutMs: number,
): Promise<typeof globalThis.fetch | undefined> {
  try {
    const undici: any = await import("undici");
    const dispatcher = new undici.Agent({
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    return ((input: any, init: any = {}) =>
      undici.fetch(input, { ...init, dispatcher })) as unknown as typeof globalThis.fetch;
  } catch {
    return undefined; // undici unavailable — fall back to default fetch
  }
}

/** Build a managed image provider routed through the Vercel AI Gateway.
 *  Authenticates via `AI_GATEWAY_API_KEY` (read by the gateway provider). */
export async function resolveManagedImageProvider(): Promise<ImageProvider> {
  const mod = await loadOptional("@ai-sdk/gateway", "managed image_generate");
  // @ts-ignore — mod typed as `any` from the dynamic import helper
  const gw = mod.createGatewayProvider();
  return { image: (modelId: string) => gw.image(modelId) };
}

/** Build a managed video provider routed through the Vercel AI Gateway,
 *  with an extended-timeout fetch so long renders aren't cut off. */
export async function resolveManagedVideoProvider(
  timeoutMs = 20 * 60 * 1000,
): Promise<VideoProvider> {
  const mod = await loadOptional("@ai-sdk/gateway", "managed video_generate");
  const fetchImpl = await makeLongTimeoutFetch(timeoutMs);
  // @ts-ignore — mod typed as `any` from the dynamic import helper
  const gw = mod.createGatewayProvider(fetchImpl ? { fetch: fetchImpl } : undefined);
  return { video: (modelId: string) => gw.video(modelId) };
}

/** Build a speech-to-text (transcription) provider. */
export async function resolveTranscribeProvider(
  name: TranscribeProviderName,
  apiKey: string,
): Promise<TranscribeProvider> {
  if (name === "openai") {
    const mod = await loadOptional("@ai-sdk/openai", "audio_transcribe (openai)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const openai = mod.createOpenAI({ apiKey });
    return { transcription: (modelId: string) => openai.transcription(modelId) };
  }
  if (name === "deepgram") {
    const mod = await loadOptional("@ai-sdk/deepgram", "audio_transcribe (deepgram)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const deepgram = mod.createDeepgram({ apiKey });
    return { transcription: (modelId: string) => deepgram.transcription(modelId) };
  }
  throw new Error(`Unknown transcribe provider: ${name}`);
}

/** Build a text-to-speech provider. The local `edge` provider needs a
 *  Shell + FileSystem (no API key); cloud providers need an API key. */
export async function resolveSpeakProvider(
  name: SpeakProviderName,
  config: { apiKey?: string; shell?: Shell; fs?: FileSystem },
): Promise<SpeakProvider> {
  if (name === "edge") {
    if (!config.shell || !config.fs) {
      throw new Error("edge provider requires shell and fs to be supplied");
    }
    const { createEdgeSpeechProvider } = await import("./edge-speech-model.js");
    return createEdgeSpeechProvider({ shell: config.shell, fs: config.fs });
  }
  if (!config.apiKey) {
    throw new Error(`${name} speech provider requires an apiKey`);
  }
  if (name === "openai") {
    const mod = await loadOptional("@ai-sdk/openai", "audio_speak (openai)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const openai = mod.createOpenAI({ apiKey: config.apiKey });
    return { speech: (modelId: string) => openai.speech(modelId) };
  }
  if (name === "deepgram") {
    const mod = await loadOptional("@ai-sdk/deepgram", "audio_speak (deepgram)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const deepgram = mod.createDeepgram({ apiKey: config.apiKey });
    return { speech: (modelId: string) => deepgram.speech(modelId) };
  }
  if (name === "elevenlabs") {
    const mod = await loadOptional("@ai-sdk/elevenlabs", "audio_speak (elevenlabs)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const elevenlabs = mod.createElevenLabs({ apiKey: config.apiKey });
    return { speech: (modelId: string) => elevenlabs.speech(modelId) };
  }
  throw new Error(`Unknown speak provider: ${name}`);
}

/** Build a vision (multimodal LanguageModel) provider. */
export async function resolveVisionProvider(
  name: VisionProviderName,
  apiKey: string,
): Promise<VisionProvider> {
  if (name === "openai") {
    const mod = await loadOptional("@ai-sdk/openai", "image_analyze (openai)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const openai = mod.createOpenAI({ apiKey });
    return (modelId: string) => openai(modelId);
  }
  if (name === "anthropic") {
    const mod = await loadOptional("@ai-sdk/anthropic", "image_analyze (anthropic)");
    // @ts-ignore — mod typed as `any` from the dynamic import helper
    const anthropic = mod.createAnthropic({ apiKey });
    return (modelId: string) => anthropic(modelId);
  }
  throw new Error(`Unknown vision provider: ${name}`);
}

// ── Internal ──

async function loadOptional(pkg: string, toolName: string): Promise<any> {
  try {
    return await import(pkg);
  } catch (err: any) {
    throw new Error(
      `${pkg} is required for ${toolName} but is not installed. ` +
        `Install it with: pnpm add ${pkg}`,
    );
  }
}
