/**
 * EdgeSpeechModel — adapter that exposes the local `edge-tts` Python CLI
 * as a Vercel AI SDK SpeechModelV3.
 *
 * Why: edge-tts is the only TTS provider in the Polpo catalog that has
 * no remote API — it's a subprocess shelling out to a Python CLI that
 * talks to Microsoft Edge's neural voices for free. Wrapping it as a
 * SpeechModelV3 lets `audio_speak` route every provider — including
 * edge — through one `experimental_generateSpeech()` call. The tool
 * code stops branching on provider, and tests mock the same surface
 * for all four providers.
 *
 * Round-trip: edge-tts requires a file path to write to. doGenerate
 * writes to a tmp file inside cwd, reads the bytes back, returns them.
 * The caller (`audio_speak`) writes them to the agent's requested
 * sandbox path. Costs one extra disk hop vs the old direct-write path
 * — small price for the uniform abstraction.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core";

// ── Voice resolution ──

/**
 * Default Edge TTS voices per language+gender.
 * Format: `${lang}-${region}-${name}Neural`
 * Each entry: [female, male]. First match wins.
 */
const EDGE_VOICES: Record<string, [female: string, male: string]> = {
  it: ["it-IT-ElsaNeural", "it-IT-DiegoNeural"],
  en: ["en-US-EmmaMultilingualNeural", "en-US-AndrewMultilingualNeural"],
  es: ["es-ES-ElviraNeural", "es-ES-AlvaroNeural"],
  fr: ["fr-FR-DeniseNeural", "fr-FR-HenriNeural"],
  de: ["de-DE-KatjaNeural", "de-DE-ConradNeural"],
  pt: ["pt-BR-FranciscaNeural", "pt-BR-AntonioNeural"],
  ja: ["ja-JP-NanamiNeural", "ja-JP-KeitaNeural"],
  zh: ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"],
  ko: ["ko-KR-SunHiNeural", "ko-KR-InJoonNeural"],
  ar: ["ar-SA-ZariyahNeural", "ar-SA-HamedNeural"],
  hi: ["hi-IN-SwaraNeural", "hi-IN-MadhurNeural"],
  ru: ["ru-RU-SvetlanaNeural", "ru-RU-DmitryNeural"],
  nl: ["nl-NL-ColetteNeural", "nl-NL-MaartenNeural"],
  pl: ["pl-PL-AgnieszkaNeural", "pl-PL-MarekNeural"],
  sv: ["sv-SE-SofieNeural", "sv-SE-MattiasNeural"],
};

/**
 * Resolve the best Edge TTS voice for a given language and gender hint.
 * Falls back to en-US if the language is unknown.
 */
export function resolveEdgeVoice(
  voice?: string,
  language?: string,
  gender?: "male" | "female",
): string {
  // Explicit voice name like "it-IT-DiegoNeural" passes through unchanged.
  if (voice && voice.includes("-") && voice.endsWith("Neural")) return voice;

  const lang = (language ?? "en").toLowerCase().split("-")[0]; // "it-IT" → "it"
  const pair = EDGE_VOICES[lang] ?? EDGE_VOICES.en!;
  return gender === "male" ? pair[1] : pair[0]; // default female if no gender hint
}

// ── Edge-tts availability cache (per-Shell) ──

const _edgeTtsAvailable = new WeakMap<Shell, Promise<boolean>>();

export function edgeTtsAvailable(shell: Shell): Promise<boolean> {
  const existing = _edgeTtsAvailable.get(shell);
  if (existing) return existing;
  const fresh: Promise<boolean> = shell
    .execute("edge-tts --version", { timeout: 5_000 })
    .then((r: { exitCode: number }) => r.exitCode === 0)
    .catch(() => false);
  _edgeTtsAvailable.set(shell, fresh);
  return fresh;
}

/** Quote a CLI argument for inclusion in a `shell.execute` command line. */
function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// ── SpeechModelV3 implementation ──

const EDGE_TTS_TIMEOUT = 120_000; // 2 min per generation

interface EdgeSpeechCallOptions {
  text: string;
  voice?: string;
  language?: string;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export class EdgeSpeechModel {
  readonly specificationVersion = "v3" as const;
  readonly provider = "edge" as const;
  readonly modelId: string;

  constructor(
    modelId: string,
    private readonly shell: Shell,
    private readonly fs: FileSystem,
  ) {
    this.modelId = modelId;
  }

  async doGenerate(options: EdgeSpeechCallOptions): Promise<{
    audio: Uint8Array;
    warnings: never[];
    request: { body?: unknown };
    response: { timestamp: Date; modelId: string };
  }> {
    if (!(await edgeTtsAvailable(this.shell))) {
      throw new Error("edge-tts CLI is not installed. Install it with: pip install edge-tts");
    }

    // edge-tts only accepts these gender hints; ignore anything else.
    const providerOpts = (options.providerOptions ?? {}) as {
      gender?: "male" | "female";
    };

    const voice = resolveEdgeVoice(options.voice, options.language, providerOpts.gender);

    // Write to a tmp file we own, then read back. The tool layer
    // re-writes into the agent's sandbox path so the output matches
    // every other provider.
    const tmpFile = join(
      tmpdir(),
      `polpo-edge-tts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.mp3`,
    );

    const cmd = [
      "edge-tts",
      "--text", quoteArg(options.text),
      "--voice", quoteArg(voice),
      "--write-media", quoteArg(tmpFile),
    ].join(" ");

    const result = await this.shell.execute(cmd, {
      timeout: EDGE_TTS_TIMEOUT,
      signal: options.abortSignal,
    } as any);

    if (result.exitCode !== 0) {
      const stderr = (result.stderr || result.stdout || "").trim();
      throw new Error(`edge-tts failed: ${stderr || `exit ${result.exitCode}`}`);
    }

    if (!this.fs.readFileBuffer) {
      throw new Error("FileSystem implementation does not support readFileBuffer");
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFileBuffer(tmpFile);
    } catch (err: any) {
      throw new Error(`edge-tts produced no output file: ${err.message}`);
    } finally {
      // Best-effort cleanup; ignore failures.
      try { await this.fs.remove(tmpFile); } catch { /* noop */ }
    }

    return {
      audio: bytes,
      warnings: [],
      request: { body: { voice, modelId: this.modelId } },
      response: {
        timestamp: new Date(),
        modelId: this.modelId,
      },
    };
  }
}

// ── Provider factory (matches the @ai-sdk/* shape) ──

export interface EdgeSpeechProvider {
  speech(modelId: string): EdgeSpeechModel;
}

export function createEdgeSpeechProvider(deps: {
  shell: Shell;
  fs: FileSystem;
}): EdgeSpeechProvider {
  return {
    speech: (modelId: string) => new EdgeSpeechModel(modelId, deps.shell, deps.fs),
  };
}
