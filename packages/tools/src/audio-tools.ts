/**
 * Audio tools for speech-to-text (STT) and text-to-speech (TTS).
 *
 * Provides agent capabilities to:
 * - Transcribe audio files to text (audio_transcribe)
 * - Generate speech audio from text (audio_speak)
 *
 * Architecture: direct fetch() to provider REST APIs — zero vendor SDK dependencies.
 *
 * Supported providers:
 *   STT: openai (Whisper), deepgram (Nova)
 *   TTS: openai (gpt-4o-mini-tts / tts-1), deepgram (Aura), elevenlabs, edge (free, local)
 *
 * Edge TTS: Uses Microsoft Edge's neural TTS engine via the `edge-tts` CLI.
 * Free, no API key, ~400 voices in 60+ languages. Auto-selects voice from
 * language + gender params. Also used as automatic fallback when cloud providers fail.
 * Install: `pip install edge-tts`
 *
 * Credential resolution order (same as email/image tools):
 *   1. Agent vault (per-agent credentials — e.g. service "openai" key "key")
 *   2. Environment variables (global fallback)
 *   3. Edge TTS (automatic fallback — no credentials needed)
 *
 * Environment variables (fallback):
 *   OPENAI_API_KEY    — openai provider (STT + TTS)
 *   DEEPGRAM_API_KEY  — deepgram provider (STT + TTS)
 *   ELEVENLABS_API_KEY — elevenlabs provider (TTS)
 */

import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { PolpoTool as AgentTool, ToolResult as AgentToolResult } from "@polpo-ai/core";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core";
import { NodeFileSystem } from "./adapters/node-filesystem.js";
import { NodeShell } from "./adapters/node-shell.js";

// Re-export with concrete generic to avoid "requires 1 type argument" errors
type ToolResult = AgentToolResult<any>;
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import type { ResolvedVault } from "./types.js";
import { resolveTranscribeProvider, resolveSpeakProvider, type TranscribeProviderName, type SpeakProviderName } from "./lib/provider-resolver.js";

// ─── Constants ───

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (OpenAI Whisper limit)

// ─── Helpers ───

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
}

// ─── Tool: audio_transcribe ───

const AudioTranscribeSchema = Type.Object({
  path: Type.String({ description: "Path to the audio file to transcribe (mp3, wav, flac, ogg, m4a, webm)" }),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("deepgram"),
  ], { description: "STT provider (default: openai)" })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'whisper-1' (default). Deepgram: 'nova-3' (default)." })),
  language: Type.Optional(Type.String({ description: "ISO 639-1 language code (e.g. 'en', 'it', 'es'). Helps accuracy." })),
  prompt: Type.Optional(Type.String({ description: "Optional context/prompt to guide transcription (OpenAI only)" })),
});

function createTranscribeTool(cwd: string, sandbox: string[], fs: FileSystem, vault?: ResolvedVault): AgentTool<typeof AudioTranscribeSchema> {
  return {
    name: "audio_transcribe",
    label: "Transcribe Audio",
    description: "Transcribe an audio file to text using speech-to-text AI. " +
      "Supports mp3, wav, flac, ogg, m4a, webm formats. Max file size: 25 MB. " +
      "Providers: openai (Whisper, default), deepgram (Nova). " +
      "Credentials resolved from: agent vault > OPENAI_API_KEY or DEEPGRAM_API_KEY env var.",
    parameters: AudioTranscribeSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "audio_transcribe");

      const provider = params.provider ?? "openai";

      if (!fs.readFileBuffer) {
        return {
          content: [{ type: "text", text: "FileSystem implementation does not support readFileBuffer (required for binary reads)." }],
          details: { error: "unsupported_filesystem" },
        };
      }

      let fileBuffer: Buffer;
      try {
        const bytes = await fs.readFileBuffer(filePath);
        fileBuffer = Buffer.from(bytes);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading audio file: ${err.message}` }],
          details: { error: "file_read_error" },
        };
      }

      if (fileBuffer.byteLength > MAX_AUDIO_SIZE) {
        return {
          content: [{ type: "text", text: `Audio file too large: ${(fileBuffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_AUDIO_SIZE / 1024 / 1024} MB)` }],
          details: { error: "file_too_large", size: fileBuffer.byteLength },
        };
      }

      try {
        return await transcribeWithSdk(filePath, fileBuffer, provider, params, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Transcription error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function transcribeWithSdk(
  _filePath: string,
  fileBuffer: Buffer,
  providerName: TranscribeProviderName,
  params: { model?: string; language?: string; prompt?: string },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { experimental_transcribe } = await import("ai");

  const apiKey = providerName === "openai"
    ? vault?.getKey("openai", "key") ?? requireEnv("OPENAI_API_KEY")
    : vault?.getKey("deepgram", "key") ?? requireEnv("DEEPGRAM_API_KEY");

  const defaultModel = providerName === "openai" ? "whisper-1" : "nova-3";
  const model = params.model ?? defaultModel;

  const provider = await resolveTranscribeProvider(providerName, apiKey);

  // Provider-specific knobs. OpenAI/Whisper gets language + prompt;
  // Deepgram gets language + smart_format/punctuate (always on).
  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (providerName === "openai") {
    const opts: Record<string, unknown> = {};
    if (params.language) opts.language = params.language;
    if (params.prompt) opts.prompt = params.prompt;
    if (Object.keys(opts).length) providerOptions.openai = opts;
  } else {
    const opts: Record<string, unknown> = {
      smart_format: true,
      punctuate: true,
    };
    if (params.language) opts.language = params.language;
    providerOptions.deepgram = opts;
  }

  const result = await experimental_transcribe({
    model: provider.transcription(model) as any,
    audio: new Uint8Array(fileBuffer),
    providerOptions: Object.keys(providerOptions).length
      ? providerOptions as any
      : undefined,
    abortSignal: signal,
  });

  const info = [
    `Language: ${result.language ?? "unknown"}`,
    `Duration: ${result.durationInSeconds ? `${result.durationInSeconds.toFixed(1)}s` : "unknown"}`,
    `Model: ${model}`,
  ].join(" | ");

  return {
    content: [{ type: "text", text: `${info}\n\n${result.text}` }],
    details: {
      provider: providerName,
      model,
      language: result.language,
      duration: result.durationInSeconds,
      textLength: result.text.length,
    },
  };
}

// ─── Tool: audio_speak ───

const AudioSpeakSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech" }),
  path: Type.String({ description: "Output file path (e.g. 'output.mp3'). Format inferred from extension." }),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("deepgram"),
    Type.Literal("elevenlabs"),
    Type.Literal("edge"),
  ], { description: "TTS provider. 'openai' (default), 'deepgram', 'elevenlabs', or 'edge' (free, local Microsoft Edge TTS — no API key needed). If the chosen provider fails, edge-tts is tried as automatic fallback." })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'tts-1' (default), 'tts-1-hd', 'gpt-4o-mini-tts'. Deepgram: 'aura-2-en' (default). ElevenLabs: 'eleven_multilingual_v2' (default)." })),
  voice: Type.Optional(Type.String({ description: "Voice name/ID. OpenAI: alloy, echo, fable, onyx, nova, shimmer (default: alloy). ElevenLabs: voice ID. Edge: full voice name like 'it-IT-DiegoNeural' (auto-selected from language+gender if omitted)." })),
  language: Type.Optional(Type.String({ description: "ISO 639-1 language code (e.g. 'it', 'en', 'es'). Used by edge provider to select the right voice. Also useful for other providers with multilingual models." })),
  gender: Type.Optional(Type.Union([
    Type.Literal("male"),
    Type.Literal("female"),
  ], { description: "Voice gender preference. Used by edge provider to pick the right voice when no explicit voice is given. For other providers, choose the voice directly." })),
  speed: Type.Optional(Type.Number({ description: "Playback speed 0.25-4.0 (OpenAI only, default: 1.0)" })),
  instructions: Type.Optional(Type.String({ description: "Voice style instructions (OpenAI gpt-4o-mini-tts only, e.g. 'Speak in a cheerful tone')" })),
});

// Defaults are kept identical to pre-SDK behavior so agent prompts that
// omit `model` / `voice` get the same output as before.
const SPEAK_DEFAULTS: Record<SpeakProviderName, { model: string; voice?: string }> = {
  openai:     { model: "tts-1", voice: "alloy" },
  deepgram:   { model: "aura-2-asteria-en" }, // voice is encoded in the model id
  elevenlabs: { model: "eleven_multilingual_v2", voice: "21m00Tcm4TlvDq8ikWAM" /* Rachel */ },
  edge:       { model: "edge-tts" /* internal label — voice resolved from language+gender */ },
};

function audioFormat(filePath: string, providerName: SpeakProviderName): string {
  const ext = extname(filePath).toLowerCase().replace(".", "");
  if (providerName === "elevenlabs") {
    // ElevenLabs uses a more granular format string; map common
    // extensions and fall back to the standard mp3 codec.
    const map: Record<string, string> = { mp3: "mp3_44100_128", wav: "pcm_44100", flac: "flac" };
    return map[ext] ?? "mp3_44100_128";
  }
  return ext || "mp3";
}

function createSpeakTool(
  cwd: string,
  sandbox: string[],
  fs: FileSystem,
  shell: Shell,
  vault?: ResolvedVault,
): AgentTool<typeof AudioSpeakSchema> {
  return {
    name: "audio_speak",
    label: "Text to Speech",
    description: "Generate speech audio from text using text-to-speech AI. " +
      "Output format inferred from file extension (mp3, wav, flac, opus, aac, pcm). " +
      "Providers: openai (default), deepgram (Aura), elevenlabs, edge (free, no API key — Microsoft Edge neural voices). " +
      "If the chosen cloud provider fails (quota, auth, billing), edge-tts is tried automatically as fallback. " +
      "Use 'language' (ISO 639-1) and 'gender' params to help select the right voice, especially for the edge provider. " +
      "Credentials resolved from: agent vault > OPENAI_API_KEY, DEEPGRAM_API_KEY, or ELEVENLABS_API_KEY env var.",
    parameters: AudioSpeakSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "audio_speak");

      const provider = (params.provider ?? "openai") as SpeakProviderName;

      try {
        return await speakWithSdk(filePath, provider, params, fs, shell, vault, signal);
      } catch (err: any) {
        // Auto-fallback to edge-tts on cloud failures (preserved behavior).
        if (provider !== "edge") {
          try {
            const fallback = await speakWithSdk(filePath, "edge", params, fs, shell, vault, signal);
            const notice = `[Fallback] ${provider} failed (${err.message}), used edge-tts instead.\n`;
            return {
              content: [{ type: "text", text: notice + (fallback.content[0] as any).text }],
              details: {
                ...(fallback.details as Record<string, unknown>),
                fallbackFrom: provider,
                fallbackReason: err.message,
              },
            };
          } catch (edgeErr: any) {
            return {
              content: [{ type: "text", text: `TTS error (${provider}): ${err.message}\nEdge-tts fallback also failed: ${edgeErr.message}` }],
              details: { provider, error: err.message, edgeError: edgeErr.message },
            };
          }
        }
        return {
          content: [{ type: "text", text: `TTS error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function speakWithSdk(
  filePath: string,
  providerName: SpeakProviderName,
  params: {
    text: string;
    model?: string;
    voice?: string;
    language?: string;
    gender?: "male" | "female";
    speed?: number;
    instructions?: string;
  },
  fs: FileSystem,
  shell: Shell,
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { experimental_generateSpeech } = await import("ai");

  const defaults = SPEAK_DEFAULTS[providerName];
  const model = params.model ?? defaults.model;
  const voice = params.voice ?? defaults.voice;

  // Cloud providers need an apiKey. The edge provider needs shell+fs.
  let apiKey: string | undefined;
  if (providerName === "openai") {
    apiKey = vault?.getKey("openai", "key") ?? requireEnv("OPENAI_API_KEY");
  } else if (providerName === "deepgram") {
    apiKey = vault?.getKey("deepgram", "key") ?? requireEnv("DEEPGRAM_API_KEY");
  } else if (providerName === "elevenlabs") {
    apiKey = vault?.getKey("elevenlabs", "key") ?? requireEnv("ELEVENLABS_API_KEY");
  }

  const provider = await resolveSpeakProvider(providerName, { apiKey, shell, fs });

  // Provider-specific knobs flow through providerOptions. The SDK
  // forwards them to each provider unchanged.
  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (providerName === "openai") {
    const opts: Record<string, unknown> = {};
    if (params.speed !== undefined) opts.speed = params.speed;
    if (params.instructions) opts.instructions = params.instructions;
    if (Object.keys(opts).length) providerOptions.openai = opts;
  }
  if (providerName === "edge" && params.gender) {
    providerOptions.edge = { gender: params.gender };
  }

  const outputFormat = audioFormat(filePath, providerName);

  const result = await experimental_generateSpeech({
    model: provider.speech(model) as any,
    text: params.text,
    voice,
    outputFormat,
    language: params.language,
    instructions: params.instructions,
    speed: params.speed,
    providerOptions: Object.keys(providerOptions).length ? providerOptions as any : undefined,
    abortSignal: signal,
  });

  const bytes = result.audio.uint8Array;
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("No audio bytes in SDK response");
  }

  if (!fs.writeFileBuffer) {
    throw new Error("FileSystem implementation does not support writeFileBuffer (required for binary writes).");
  }
  await fs.mkdir(dirname(filePath));
  await fs.writeFileBuffer(filePath, bytes);

  const voiceLabel = voice ?? "(model-bound)";
  const summary = `Speech audio saved: ${filePath} (${(bytes.byteLength / 1024).toFixed(1)} KB, ${outputFormat}, voice: ${voiceLabel}, model: ${model})`;

  return {
    content: [{ type: "text", text: summary }],
    details: {
      provider: providerName,
      model,
      voice: voiceLabel,
      format: outputFormat,
      path: filePath,
      bytes: bytes.byteLength,
      textLength: params.text.length,
    },
  };
}

// ─── Factory ───

export type AudioToolName = "audio_transcribe" | "audio_speak";

export const ALL_AUDIO_TOOL_NAMES: AudioToolName[] = ["audio_transcribe", "audio_speak"];

/**
 * Create audio tools for speech-to-text and text-to-speech.
 *
 * @param cwd - Working directory for resolving file paths
 * @param allowedPaths - Sandbox paths for file validation
 * @param allowedTools - Optional filter
 * @param vault - Resolved vault credentials for credential resolution
 */
export function createAudioTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
  vault?: ResolvedVault,
  fs?: FileSystem,
  shell?: Shell,
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);
  const _fs = fs ?? new NodeFileSystem();
  const _shell = shell ?? new NodeShell();

  const factories: Record<AudioToolName, () => AgentTool<any>> = {
    audio_transcribe: () => createTranscribeTool(cwd, sandbox, _fs, vault),
    audio_speak: () => createSpeakTool(cwd, sandbox, _fs, _shell, vault),
  };

  const names = allowedTools
    ? ALL_AUDIO_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_AUDIO_TOOL_NAMES;

  return names.map(n => factories[n]());
}
