/**
 * Audio tools for speech-to-text (STT) and text-to-speech (TTS).
 *
 * Architecture: thin wrappers over the Vercel AI SDK v6.
 *   - audio_transcribe → `experimental_transcribe`
 *   - audio_speak      → `experimental_generateSpeech`
 *
 * Model selection: each tool picks its model in this order:
 *   1. per-call `model` input (`<provider>/<model>` string),
 *   2. agent-config default (transcribe_model / tts_model),
 *   3. DEFAULT_TRANSCRIBE_MODEL / DEFAULT_TTS_MODEL from @polpo-ai/core.
 *
 * audio_speak's `edge` provider is wrapped as a custom SpeechModelV3 in
 * `lib/edge-speech-model.ts` so it slots into the same SDK call as
 * cloud providers (no special-casing in the tool layer).
 */

import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { PolpoTool, ToolResult as CoreToolResult } from "@polpo-ai/core";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core";
import {
  parseModelString,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_TTS_MODEL,
  type ParsedModel,
} from "@polpo-ai/core";
import { NodeFileSystem } from "./adapters/node-filesystem.js";
import { NodeShell } from "./adapters/node-shell.js";

type ToolResult = CoreToolResult<any>;
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import type { ResolvedVault } from "./types.js";
import {
  resolveTranscribeProvider,
  resolveSpeakProvider,
  type TranscribeProviderName,
  type SpeakProviderName,
} from "./lib/provider-resolver.js";

// ─── Constants ───

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (OpenAI Whisper limit)

// ─── Helpers ───

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
}

function resolveProviderKey(
  vault: ResolvedVault | undefined,
  service: string,
  envKey: string,
): { apiKey: string; credentialType: "project" | "external" } {
  const vaultKey = vault?.getKey(service, "key");
  if (vaultKey) return { apiKey: vaultKey, credentialType: "project" };
  return { apiKey: requireEnv(envKey), credentialType: "external" };
}

function resolveEffectiveModel(
  override: string | undefined,
  configured: string | undefined,
  fallback: string,
): ParsedModel {
  return parseModelString(configured ?? override ?? fallback);
}

function audioModelUsage(input: {
  operation: "audio.transcribe" | "audio.speak";
  parsed: ParsedModel;
  credentialType: "project" | "external" | "none";
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  rawMetadata?: Record<string, unknown>;
}) {
  const modelRef = `${input.parsed.provider}/${input.parsed.model}`;
  const isLocal = input.credentialType === "none";
  return {
    mode: "provider",
    operation: input.operation,
    requestedProvider: input.parsed.provider,
    requestedModel: modelRef,
    resolvedProvider: input.parsed.provider,
    resolvedModel: modelRef,
    finalProvider: input.parsed.provider,
    credentialType: input.credentialType,
    status: "succeeded",
    audioInputSeconds: input.audioInputSeconds,
    audioOutputSeconds: input.audioOutputSeconds,
    costSource: isLocal ? "none" : "unknown",
    billingOwner: isLocal ? "none" : "external",
    rawMetadata: input.rawMetadata,
  };
}

/** Default voices per TTS provider. Used when the input doesn't pass an explicit voice. */
const SPEAK_DEFAULT_VOICES: Record<string, string | undefined> = {
  openai: "alloy",
  deepgram: undefined, // voice is encoded in the model id
  elevenlabs: "21m00Tcm4TlvDq8ikWAM", // Rachel
  edge: undefined, // resolved from language+gender by EdgeSpeechModel
};

// ─── Tool: audio_transcribe ───

const AudioTranscribeSchema = Type.Object({
  path: Type.String({ description: "Path to the audio file to transcribe (mp3, wav, flac, ogg, m4a, webm)" }),
  model: Type.Optional(Type.String({
    description: "Select a transcription model only when the agent has no transcribe_model configured. " +
      "Format: '<provider>/<model>' (e.g. 'openai/whisper-1', 'deepgram/nova-3'). Agent configuration always takes precedence.",
  })),
  language: Type.Optional(Type.String({
    description: "ISO 639-1 language code (e.g. 'en', 'it', 'es'). Always set it when the language is known; otherwise Deepgram auto-detects it.",
  })),
  prompt: Type.Optional(Type.String({ description: "Optional context/prompt to guide transcription (OpenAI Whisper only)" })),
});

function createTranscribeTool(
  cwd: string,
  sandbox: string[],
  fs: FileSystem,
  configuredModel: string | undefined,
  vault?: ResolvedVault,
): PolpoTool<typeof AudioTranscribeSchema> {
  return {
    name: "audio_transcribe",
    label: "Transcribe Audio",
    description: "Transcribe an audio file to text using speech-to-text AI. " +
      "Supports mp3, wav, flac, ogg, m4a, webm formats. Max file size: 25 MB. " +
      "Model is fixed by the agent's transcribe_model when configured. " +
      "Default: openai/whisper-1. Supported providers: openai, deepgram.",
    parameters: AudioTranscribeSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "audio_transcribe");

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
        const parsed = resolveEffectiveModel(params.model, configuredModel, DEFAULT_TRANSCRIBE_MODEL);
        return await transcribeWithSdk(filePath, fileBuffer, parsed, params, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Transcription error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function transcribeWithSdk(
  _filePath: string,
  fileBuffer: Buffer,
  parsed: ParsedModel,
  params: { language?: string; prompt?: string },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { experimental_transcribe } = await import("ai");

  const credentials = parsed.provider === "openai"
    ? resolveProviderKey(vault, "openai", "OPENAI_API_KEY")
    : parsed.provider === "deepgram"
      ? resolveProviderKey(vault, "deepgram", "DEEPGRAM_API_KEY")
      : (() => { throw new Error(`Unsupported transcribe provider: ${parsed.provider}`); })();

  const provider = await resolveTranscribeProvider(parsed.provider as TranscribeProviderName, credentials.apiKey);

  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (parsed.provider === "openai") {
    const opts: Record<string, unknown> = {};
    if (params.language) opts.language = params.language;
    if (params.prompt) opts.prompt = params.prompt;
    if (Object.keys(opts).length) providerOptions.openai = opts;
  } else {
    const opts: Record<string, unknown> = { smartFormat: true, punctuate: true };
    if (params.language) {
      opts.language = params.language;
    } else {
      opts.detectLanguage = true;
    }
    providerOptions.deepgram = opts;
  }

  const result = await experimental_transcribe({
    model: provider.transcription(parsed.model) as any,
    audio: new Uint8Array(fileBuffer),
    providerOptions: Object.keys(providerOptions).length ? providerOptions as any : undefined,
    abortSignal: signal,
  });

  const info = [
    `Language: ${result.language ?? "unknown"}`,
    `Duration: ${result.durationInSeconds ? `${result.durationInSeconds.toFixed(1)}s` : "unknown"}`,
    `Model: ${parsed.provider}/${parsed.model}`,
  ].join(" | ");

  return {
    content: [{ type: "text", text: `${info}\n\n${result.text}` }],
    details: {
      provider: parsed.provider,
      model: parsed.model,
      language: result.language,
      duration: result.durationInSeconds,
      textLength: result.text.length,
      modelUsage: audioModelUsage({
        operation: "audio.transcribe",
        parsed,
        credentialType: credentials.credentialType,
        audioInputSeconds: result.durationInSeconds,
        rawMetadata: {
          language: result.language,
          textLength: result.text.length,
        },
      }),
    },
  };
}

// ─── Tool: audio_speak ───

const AudioSpeakSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech" }),
  path: Type.String({ description: "Output file path (e.g. 'output.mp3'). Format inferred from extension." }),
  model: Type.Optional(Type.String({
    description: "Select a speech model only when the agent has no tts_model configured. Format: '<provider>/<model>' " +
      "(e.g. 'openai/tts-1', 'openai/tts-1-hd', 'openai/gpt-4o-mini-tts', 'deepgram/aura-2-asteria-en', " +
      "'elevenlabs/eleven_multilingual_v2', 'edge/edge-tts'). Agent configuration always takes precedence.",
  })),
  voice: Type.Optional(Type.String({ description: "Voice name/ID. OpenAI: alloy/echo/fable/onyx/nova/shimmer (default: alloy). ElevenLabs: voice ID (default: Rachel). Edge: full voice name like 'it-IT-DiegoNeural' (auto-selected from language+gender if omitted)." })),
  language: Type.Optional(Type.String({ description: "ISO 639-1 language code (e.g. 'it', 'en', 'es'). Used by edge provider to select the right voice. Also useful for other providers with multilingual models." })),
  gender: Type.Optional(Type.Union([
    Type.Literal("male"),
    Type.Literal("female"),
  ], { description: "Voice gender preference. Used by the edge provider to pick the right voice when no explicit voice is given." })),
  speed: Type.Optional(Type.Number({ description: "Playback speed 0.25-4.0 (OpenAI only, default: 1.0)" })),
  instructions: Type.Optional(Type.String({ description: "Voice style instructions (OpenAI gpt-4o-mini-tts only, e.g. 'Speak in a cheerful tone')" })),
});

function audioFormat(filePath: string, providerName: SpeakProviderName): string {
  const ext = extname(filePath).toLowerCase().replace(".", "");
  if (providerName === "elevenlabs") {
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
  configuredModel: string | undefined,
  vault?: ResolvedVault,
): PolpoTool<typeof AudioSpeakSchema> {
  return {
    name: "audio_speak",
    label: "Text to Speech",
    description: "Generate speech audio from text using text-to-speech AI. " +
      "Output format inferred from file extension (mp3, wav, flac, opus, aac, pcm). " +
      "Model is fixed by the agent's tts_model when configured. " +
      "Default: edge/edge-tts. Supported providers: openai, deepgram, elevenlabs, edge (free, local Microsoft Edge TTS — no API key needed).",
    parameters: AudioSpeakSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "audio_speak");

      try {
        const parsed = resolveEffectiveModel(params.model, configuredModel, DEFAULT_TTS_MODEL);
        return await speakWithSdk(filePath, parsed, params, fs, shell, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `TTS error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function speakWithSdk(
  filePath: string,
  parsed: ParsedModel,
  params: {
    text: string;
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

  const providerName = parsed.provider as SpeakProviderName;
  const voice = params.voice ?? SPEAK_DEFAULT_VOICES[providerName];

  // Cloud providers need an apiKey. The edge provider needs shell+fs.
  let apiKey: string | undefined;
  let credentialType: "project" | "external" | "none" = "none";
  if (providerName === "openai") {
    const credentials = resolveProviderKey(vault, "openai", "OPENAI_API_KEY");
    apiKey = credentials.apiKey;
    credentialType = credentials.credentialType;
  } else if (providerName === "deepgram") {
    const credentials = resolveProviderKey(vault, "deepgram", "DEEPGRAM_API_KEY");
    apiKey = credentials.apiKey;
    credentialType = credentials.credentialType;
  } else if (providerName === "elevenlabs") {
    const credentials = resolveProviderKey(vault, "elevenlabs", "ELEVENLABS_API_KEY");
    apiKey = credentials.apiKey;
    credentialType = credentials.credentialType;
  } else if (providerName !== "edge") {
    throw new Error(`Unsupported tts provider: ${providerName}`);
  }

  const provider = await resolveSpeakProvider(providerName, { apiKey, shell, fs });

  // Provider-specific knobs flow through providerOptions.
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
    model: provider.speech(parsed.model) as any,
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
  const summary = `Speech audio saved: ${filePath} (${(bytes.byteLength / 1024).toFixed(1)} KB, ${outputFormat}, voice: ${voiceLabel}, model: ${parsed.provider}/${parsed.model})`;

  return {
    content: [{ type: "text", text: summary }],
    details: {
      provider: providerName,
      model: parsed.model,
      voice: voiceLabel,
      format: outputFormat,
      path: filePath,
      bytes: bytes.byteLength,
      textLength: params.text.length,
      modelUsage: audioModelUsage({
        operation: "audio.speak",
        parsed,
        credentialType,
        rawMetadata: {
          voice: voiceLabel,
          format: outputFormat,
          path: filePath,
          bytes: bytes.byteLength,
          textLength: params.text.length,
        },
      }),
    },
  };
}

// ─── Factory ───

export type AudioToolName = "audio_transcribe" | "audio_speak";

export const ALL_AUDIO_TOOL_NAMES: AudioToolName[] = ["audio_transcribe", "audio_speak"];

export interface CreateAudioToolsOptions {
  cwd: string;
  allowedPaths?: string[];
  allowedTools?: string[];
  vault?: ResolvedVault;
  fs?: FileSystem;
  shell?: Shell;
  /** Resolved agent.transcribe_model. Format: "provider/model". */
  transcribeModel?: string;
  /** Resolved agent.tts_model. Format: "provider/model". */
  ttsModel?: string;
}

/**
 * Create audio tools for speech-to-text and text-to-speech.
 *
 * The 6-arg positional signature is preserved for back-compat. Prefer
 * the options-object form for new callers.
 */
export function createAudioTools(
  cwd: string | CreateAudioToolsOptions,
  allowedPaths?: string[],
  allowedTools?: string[],
  vault?: ResolvedVault,
  fs?: FileSystem,
  shell?: Shell,
): PolpoTool<any>[] {
  const opts: CreateAudioToolsOptions = typeof cwd === "string"
    ? { cwd, allowedPaths, allowedTools, vault, fs, shell }
    : cwd;

  const sandbox = resolveAllowedPaths(opts.cwd, opts.allowedPaths);
  const _fs = opts.fs ?? new NodeFileSystem();
  const _shell = opts.shell ?? new NodeShell();

  const factories: Record<AudioToolName, () => PolpoTool<any>> = {
    audio_transcribe: () => createTranscribeTool(opts.cwd, sandbox, _fs, opts.transcribeModel, opts.vault),
    audio_speak: () => createSpeakTool(opts.cwd, sandbox, _fs, _shell, opts.ttsModel, opts.vault),
  };

  const names = opts.allowedTools
    ? ALL_AUDIO_TOOL_NAMES.filter(n => opts.allowedTools!.some(a => a.toLowerCase() === n))
    : ALL_AUDIO_TOOL_NAMES;

  return names.map(n => factories[n]());
}
