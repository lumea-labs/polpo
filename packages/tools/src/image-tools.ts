/**
 * Image & video tools for generation and vision/analysis.
 *
 * Provides agent capabilities to:
 * - Generate images from text prompts (image_generate) — via fal.ai
 * - Generate videos from text prompts (video_generate) — via fal.ai
 * - Analyze/describe images using vision models (image_analyze) — via OpenAI/Anthropic
 *
 * Architecture: direct fetch() to provider REST APIs — zero vendor SDK dependencies.
 *
 * Providers:
 *   Image generation: fal.ai (FLUX models — fal-ai/flux/dev default)
 *   Video generation: fal.ai (Wan 2.2 — fal-ai/wan/v2.2-1.3b/text-to-video default)
 *   Vision/analysis:  openai (gpt-4.1-mini), anthropic (Claude)
 *
 * Credential resolution order (same as email tools):
 *   1. Agent vault (per-agent credentials — e.g. service "fal" with key "key")
 *   2. Environment variables (global fallback)
 *
 * Environment variables (fallback):
 *   FAL_KEY             — fal.ai image/video generation
 *   OPENAI_API_KEY      — openai vision provider
 *   ANTHROPIC_API_KEY   — anthropic vision provider
 */

import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { PolpoTool as AgentTool, ToolResult as AgentToolResult } from "@polpo-ai/core";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { NodeFileSystem } from "./adapters/node-filesystem.js";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import type { ResolvedVault } from "./types.js";
import { resolveImageProvider, resolveVideoProvider, resolveVisionProvider } from "./lib/provider-resolver.js";

type ToolResult = AgentToolResult<any>;

// ─── Constants ───

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const DEFAULT_TIMEOUT = 120_000; // 2 min for image generation
const VIDEO_TIMEOUT = 300_000; // 5 min for video generation
const FAL_QUEUE_POLL_INTERVAL = 3_000; // 3 sec polling for async queue

// ─── Helpers ───

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
}

/** Resolve fal.ai API key: vault (service "fal-ai", key "key") > FAL_KEY env var. */
function resolveFalKey(vault?: ResolvedVault): string {
  const fromVault = vault?.getKey("fal-ai", "key");
  if (fromVault) return fromVault;
  return requireEnv("FAL_KEY");
}

function imageMime(ext: string): string {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
  };
  return map[ext.toLowerCase()] ?? "image/png";
}

/**
 * Submit a request to fal.ai queue and poll until completion.
 * Uses the queue endpoint (POST https://queue.fal.run/<model>) for reliability,
 * then polls the status endpoint until the result is ready.
 */
async function falQueueRequest(
  modelId: string,
  input: Record<string, unknown>,
  apiKey: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    // Submit to queue
    const submitResp = await fetch(`https://queue.fal.run/${modelId}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    if (!submitResp.ok) {
      const errText = await submitResp.text();
      throw new Error(`fal.ai queue submit ${submitResp.status}: ${errText}`);
    }

    const queueData = await submitResp.json() as {
      request_id: string;
      status_url?: string;
      response_url?: string;
    };

    const requestId = queueData.request_id;
    const statusUrl = queueData.status_url ?? `https://queue.fal.run/${modelId}/requests/${requestId}/status`;
    const responseUrl = queueData.response_url ?? `https://queue.fal.run/${modelId}/requests/${requestId}`;

    // Poll for completion
    while (true) {
      await new Promise(r => setTimeout(r, FAL_QUEUE_POLL_INTERVAL));

      const statusResp = await fetch(statusUrl, {
        headers: { Authorization: `Key ${apiKey}` },
        signal: controller.signal,
      });

      if (!statusResp.ok) {
        throw new Error(`fal.ai status poll ${statusResp.status}`);
      }

      const status = await statusResp.json() as {
        status: string;
        error?: string;
      };

      if (status.status === "COMPLETED") {
        break;
      }
      if (status.status === "FAILED") {
        throw new Error(`fal.ai request failed: ${status.error ?? "unknown error"}`);
      }
      // IN_QUEUE or IN_PROGRESS — keep polling
    }

    // Fetch result
    const resultResp = await fetch(responseUrl, {
      headers: { Authorization: `Key ${apiKey}` },
      signal: controller.signal,
    });

    if (!resultResp.ok) {
      const errText = await resultResp.text();
      throw new Error(`fal.ai result fetch ${resultResp.status}: ${errText}`);
    }

    return await resultResp.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Tool: image_generate ───

const ImageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.png'). Format inferred from extension." }),
  model: Type.Optional(Type.String({
    description: "fal.ai model ID. Default: 'fal-ai/flux/dev'. " +
      "Other options: 'fal-ai/flux-pro/v1.1' (higher quality), 'fal-ai/flux/schnell' (faster).",
  })),
  size: Type.Optional(Type.String({
    description: "Image size as 'WIDTHxHEIGHT' (e.g. '1024x1024', '1024x768', '768x1024'). Default: '1024x1024'.",
  })),
  num_inference_steps: Type.Optional(Type.Number({
    description: "Number of inference steps (higher = better quality, slower). Default varies by model (typically 28).",
  })),
  guidance_scale: Type.Optional(Type.Number({
    description: "Guidance scale / CFG — how closely to follow the prompt. Default: 3.5.",
  })),
  seed: Type.Optional(Type.Number({
    description: "Random seed for reproducible results. Omit for random.",
  })),
});

function createGenerateTool(cwd: string, sandbox: string[], fs: FileSystem, vault?: ResolvedVault): AgentTool<typeof ImageGenerateSchema> {
  return {
    name: "image_generate",
    label: "Generate Image",
    description: "Generate an image from a text prompt via fal.ai (FLUX models). " +
      "Output format inferred from file extension (png, jpg, webp). " +
      "Models: fal-ai/flux/dev (default, balanced), fal-ai/flux-pro/v1.1 (best quality), " +
      "fal-ai/flux/schnell (fastest). Credentials resolved from: agent vault > FAL_KEY env var.",
    parameters: ImageGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_generate");

      try {
        return await generateFal(filePath, params, fs, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image generation error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function generateFal(
  filePath: string,
  params: {
    prompt: string;
    model?: string;
    size?: string;
    num_inference_steps?: number;
    guidance_scale?: number;
    seed?: number;
  },
  fs: FileSystem,
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { generateImage } = await import("ai");

  const apiKey = resolveFalKey(vault);
  const model = params.model ?? "fal-ai/flux/dev";
  const provider = await resolveImageProvider("fal", apiKey);

  // fal-specific knobs go through providerOptions; the SDK passes them
  // through to the model's input untouched.
  const falOptions: Record<string, number> = {};
  if (params.num_inference_steps != null) falOptions.num_inference_steps = params.num_inference_steps;
  if (params.guidance_scale != null) falOptions.guidance_scale = params.guidance_scale;

  const result = await generateImage({
    model: provider.image(model) as any,
    prompt: params.prompt,
    size: params.size as `${number}x${number}` | undefined,
    seed: params.seed,
    providerOptions: Object.keys(falOptions).length ? { fal: falOptions } : undefined,
    abortSignal: signal,
  });

  // The SDK guarantees `result.image` for a successful generation. No
  // download step needed — the SDK has already pulled the bytes.
  const bytes = result.image.uint8Array;
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("No image bytes in SDK response");
  }

  if (!fs.writeFileBuffer) {
    throw new Error("FileSystem implementation does not support writeFileBuffer (required for binary writes).");
  }
  await fs.mkdir(dirname(filePath));
  await fs.writeFileBuffer(filePath, bytes);

  const info = [
    `Image saved: ${filePath}`,
    `Size: ${(bytes.byteLength / 1024).toFixed(1)} KB`,
    `Model: ${model}`,
  ];
  if (params.size) info.push(`Dimensions: ${params.size}`);

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: "fal",
      model,
      size: params.size,
      path: filePath,
      bytes: bytes.byteLength,
    },
  };
}

// ─── Tool: video_generate ───

const VideoGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the video to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.mp4')." }),
  model: Type.Optional(Type.String({
    description: "fal.ai video model ID. Default: 'luma-ray-2-flash' (fast). " +
      "Other typed options: 'luma-ray-2', 'luma-dream-machine', 'minimax-video', 'minimax-video-01', 'hunyuan-video'. " +
      "Any other fal video model id is accepted as a passthrough string.",
  })),
  aspect_ratio: Type.Optional(Type.String({
    description: "Aspect ratio as 'WIDTH:HEIGHT' (e.g. '16:9', '9:16', '1:1').",
  })),
  resolution: Type.Optional(Type.String({
    description: "Resolution as 'WIDTHxHEIGHT' (e.g. '1280x720'). Provider-dependent.",
  })),
  duration: Type.Optional(Type.Number({
    description: "Video duration in seconds. Provider-dependent — typical range 4-10.",
  })),
  fps: Type.Optional(Type.Number({
    description: "Frames per second. Provider-dependent.",
  })),
  seed: Type.Optional(Type.Number({
    description: "Random seed for reproducible results. Omit for random.",
  })),
});

function createVideoGenerateTool(cwd: string, sandbox: string[], fs: FileSystem, vault?: ResolvedVault): AgentTool<typeof VideoGenerateSchema> {
  return {
    name: "video_generate",
    label: "Generate Video",
    description: "Generate a video from a text prompt via fal.ai (Luma / MiniMax / Hunyuan models). " +
      "Output saved as MP4. Models: luma-ray-2-flash (default, fast), luma-ray-2, luma-dream-machine, " +
      "minimax-video, minimax-video-01, hunyuan-video. Generation takes 1-5 minutes depending on model. " +
      "Credentials resolved from: agent vault > FAL_KEY env var.",
    parameters: VideoGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "video_generate");

      try {
        return await generateVideo(filePath, params, fs, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Video generation error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function generateVideo(
  filePath: string,
  params: {
    prompt: string;
    model?: string;
    aspect_ratio?: string;
    resolution?: string;
    duration?: number;
    fps?: number;
    seed?: number;
  },
  fs: FileSystem,
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { experimental_generateVideo } = await import("ai");

  const apiKey = resolveFalKey(vault);
  const model = params.model ?? "luma-ray-2-flash";
  const provider = await resolveVideoProvider("fal", apiKey);

  const result = await experimental_generateVideo({
    model: provider.video(model) as any,
    prompt: params.prompt,
    aspectRatio: params.aspect_ratio as `${number}:${number}` | undefined,
    resolution: params.resolution as `${number}x${number}` | undefined,
    duration: params.duration,
    fps: params.fps,
    seed: params.seed,
    abortSignal: signal,
  });

  const bytes = result.video?.uint8Array;
  if (!bytes || bytes.byteLength === 0) {
    throw new Error("No video bytes in SDK response");
  }

  if (!fs.writeFileBuffer) {
    throw new Error("FileSystem implementation does not support writeFileBuffer (required for binary writes).");
  }
  await fs.mkdir(dirname(filePath));
  await fs.writeFileBuffer(filePath, bytes);

  const sizeMB = (bytes.byteLength / 1024 / 1024).toFixed(2);
  const info = [
    `Video saved: ${filePath}`,
    `Size: ${sizeMB} MB`,
    `Model: ${model}`,
  ];

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: "fal",
      model,
      path: filePath,
      bytes: bytes.byteLength,
    },
  };
}

// ─── Tool: image_analyze ───

const ImageAnalyzeSchema = Type.Object({
  path: Type.String({ description: "Path to the image file to analyze" }),
  prompt: Type.Optional(Type.String({ description: "Question or instruction for the vision model (default: 'Describe this image in detail')" })),
  provider: Type.Optional(Type.Union([
    Type.Literal("openai"),
    Type.Literal("anthropic"),
  ], { description: "Vision provider (default: openai)" })),
  model: Type.Optional(Type.String({ description: "Model name. OpenAI: 'gpt-4.1-mini' (default). Anthropic: 'claude-sonnet-4-20250514' (default)." })),
  max_tokens: Type.Optional(Type.Number({ description: "Max tokens in response (default: 1024)" })),
});

function createAnalyzeTool(cwd: string, sandbox: string[], fs: FileSystem, vault?: ResolvedVault): AgentTool<typeof ImageAnalyzeSchema> {
  return {
    name: "image_analyze",
    label: "Analyze Image",
    description: "Analyze an image using AI vision models. Can describe contents, extract text (OCR), " +
      "answer questions about the image, identify objects, read charts, etc. " +
      "Providers: openai (GPT-4.1-mini, default), anthropic (Claude). " +
      "Credentials resolved from: agent vault > OPENAI_API_KEY or ANTHROPIC_API_KEY env var.",
    parameters: ImageAnalyzeSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_analyze");

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
          content: [{ type: "text", text: `Error reading image file: ${err.message}` }],
          details: { error: "file_read_error" },
        };
      }

      if (fileBuffer.byteLength > MAX_IMAGE_SIZE) {
        return {
          content: [{ type: "text", text: `Image file too large: ${(fileBuffer.byteLength / 1024 / 1024).toFixed(1)} MB (max ${MAX_IMAGE_SIZE / 1024 / 1024} MB)` }],
          details: { error: "file_too_large", size: fileBuffer.byteLength },
        };
      }

      const provider = params.provider ?? "openai";

      try {
        return await analyzeWithSdk(filePath, fileBuffer, provider, params, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image analysis error (${provider}): ${err.message}` }],
          details: { provider, error: err.message },
        };
      }
    },
  };
}

async function analyzeWithSdk(
  filePath: string,
  fileBuffer: Buffer,
  providerName: "openai" | "anthropic",
  params: { prompt?: string; model?: string; max_tokens?: number },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { generateText } = await import("ai");

  const apiKey = providerName === "openai"
    ? vault?.getKey("openai", "key") ?? requireEnv("OPENAI_API_KEY")
    : vault?.getKey("anthropic", "key") ?? requireEnv("ANTHROPIC_API_KEY");

  const defaultModel = providerName === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-20250514";
  const model = params.model ?? defaultModel;
  const prompt = params.prompt ?? "Describe this image in detail.";

  const provider = await resolveVisionProvider(providerName, apiKey);

  const ext = extname(filePath).toLowerCase();
  const mediaType = imageMime(ext);

  const result = await generateText({
    model: provider(model) as any,
    maxOutputTokens: params.max_tokens ?? 1024,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image", image: new Uint8Array(fileBuffer), mediaType },
      ],
    }],
    abortSignal: signal,
  });

  return {
    content: [{ type: "text", text: result.text }],
    details: {
      provider: providerName,
      model,
      path: filePath,
      imageSize: fileBuffer.byteLength,
      tokens: result.usage?.totalTokens,
      promptTokens: result.usage?.inputTokens,
      completionTokens: result.usage?.outputTokens,
    },
  };
}

// ─── Factory ───

export type ImageToolName = "image_generate" | "image_analyze" | "video_generate";

export const ALL_IMAGE_TOOL_NAMES: ImageToolName[] = ["image_generate", "image_analyze", "video_generate"];

/**
 * Create image & video tools for generation, vision analysis, and video creation.
 *
 * @param cwd - Working directory for resolving file paths
 * @param allowedPaths - Sandbox paths for file validation
 * @param allowedTools - Optional filter — only include tools whose names appear here.
 *   Supports wildcards expanded upstream (e.g. "image_*", "video_*").
 * @param vault - Resolved vault for credential resolution (fal-ai, openai, anthropic).
 *   Credentials are resolved as: vault > environment variable.
 */
export function createImageTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
  vault?: ResolvedVault,
  fs?: FileSystem,
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);
  const _fs = fs ?? new NodeFileSystem();

  const factories: Record<ImageToolName, () => AgentTool<any>> = {
    image_generate: () => createGenerateTool(cwd, sandbox, _fs, vault),
    image_analyze: () => createAnalyzeTool(cwd, sandbox, _fs, vault),
    video_generate: () => createVideoGenerateTool(cwd, sandbox, _fs, vault),
  };

  const names = allowedTools
    ? ALL_IMAGE_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_IMAGE_TOOL_NAMES;

  return names.map(n => factories[n]());
}
