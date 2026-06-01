/**
 * Image & video tools for generation and vision/analysis.
 *
 * Architecture: thin wrappers over the Vercel AI SDK v6.
 *   - image_generate  → `generateImage` against a configurable provider
 *   - video_generate  → `experimental_generateVideo` against a configurable provider
 *   - image_analyze   → `generateText` (multimodal) against a configurable provider
 *
 * Model selection: each tool picks its model in this order:
 *   1. per-call `model` input parameter (`<provider>/<model>` string),
 *   2. agent-config default passed to the factory (image/video/vision),
 *   3. hardcoded fallback constant from @polpo-ai/core.
 *
 * Provider names are not in the input schema anymore — they ride along
 * with the model string. Every supported provider has a vault key
 * convention (fal-ai, openai, anthropic) with an env-var fallback.
 */

import { resolve, dirname, extname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { PolpoTool as AgentTool, ToolResult as AgentToolResult } from "@polpo-ai/core";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import {
  parseModelString,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VISION_MODEL,
  type ParsedModel,
} from "@polpo-ai/core";
import { NodeFileSystem } from "./adapters/node-filesystem.js";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import type { ResolvedVault } from "./types.js";
import {
  resolveImageProvider,
  resolveVideoProvider,
  resolveVisionProvider,
  resolveManagedImageProvider,
  resolveManagedVideoProvider,
  type ImageProviderName,
  type VideoProviderName,
  type VisionProviderName,
} from "./lib/provider-resolver.js";

type ToolResult = AgentToolResult<any>;

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}. Set it before using this tool.`);
  return val;
}

/** Resolve which model to actually use, in priority order. */
function resolveEffectiveModel(
  override: string | undefined,
  configured: string | undefined,
  fallback: string,
): ParsedModel {
  return parseModelString(override ?? configured ?? fallback);
}

/** Vault-key resolution per provider. Throws with a clear message
 *  when neither vault nor env var has the credential. */
function resolveProviderKey(provider: string, vault?: ResolvedVault): string {
  switch (provider) {
    case "fal":
      return vault?.getKey("fal-ai", "key") ?? requireEnv("FAL_KEY");
    case "openai":
      return vault?.getKey("openai", "key") ?? requireEnv("OPENAI_API_KEY");
    case "anthropic":
      return vault?.getKey("anthropic", "key") ?? requireEnv("ANTHROPIC_API_KEY");
    default:
      throw new Error(`Unknown provider '${provider}': no credential lookup defined`);
  }
}

/** Non-throwing variant of resolveProviderKey — returns undefined when no
 *  credential is configured (vault or env), instead of throwing. */
function tryResolveProviderKey(provider: string, vault?: ResolvedVault): string | undefined {
  try {
    return resolveProviderKey(provider, vault);
  } catch {
    return undefined;
  }
}

/** Managed = route through the Vercel AI Gateway. True only when the agent
 *  has NO provider key of its own AND an AI_GATEWAY_API_KEY is present (the
 *  cloud case). BYOK / self-host with a provider key stays on direct-SDK. */
function shouldUseGateway(provider: string, vault?: ResolvedVault): boolean {
  return !tryResolveProviderKey(provider, vault) && !!process.env.AI_GATEWAY_API_KEY;
}

// Managed defaults: gateway model ids (the fal-namespaced defaults have no
// gateway equivalent, so they can't be used on the gateway path).
const DEFAULT_MANAGED_IMAGE_MODEL = "bfl/flux-pro-1.1";
const DEFAULT_MANAGED_VIDEO_MODEL = "google/veo-3.0-fast-generate-001";

/** Build the gateway model id from a parsed model. fal-namespaced models
 *  have no gateway equivalent → fall back to the managed default. */
function gatewayModelId(parsed: ParsedModel, managedDefault: string): string {
  if (parsed.provider === "fal") return managedDefault;
  return `${parsed.provider}/${parsed.model}`;
}

/** Extract the billable gateway usage from an AI SDK result's
 *  providerMetadata (same shape completions meter). Undefined when the call
 *  didn't go through the gateway (BYOK / direct provider) — then no cost
 *  rides back and nothing is billed. */
function extractGatewayUsage(result: any): Record<string, unknown> | undefined {
  const gw = result?.providerMetadata?.gateway;
  if (!gw?.generationId) return undefined;
  return {
    generationId: gw.generationId,
    marketCostUsd: parseFloat(gw.marketCost ?? gw.cost ?? "0") || undefined,
    actualCostUsd: parseFloat(gw.cost ?? "0") || undefined,
    resolvedModel: gw.routing?.canonicalSlug ?? gw.routing?.originalModelId,
    finalProvider: gw.routing?.finalProvider,
    credentialType: gw.routing?.modelAttempts?.[0]?.providerAttempts?.[0]?.credentialType,
  };
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

// ─── Tool: image_generate ───

const ImageGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the image to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.png'). Format inferred from extension." }),
  model: Type.Optional(Type.String({
    description: "Override the agent's image_model for this call. Format: '<provider>/<model>' " +
      "(e.g. 'fal/fal-ai/flux/dev', 'fal/fal-ai/flux-pro/v1.1'). When omitted, uses the agent's configured image_model.",
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

function createGenerateTool(
  cwd: string,
  sandbox: string[],
  fs: FileSystem,
  configuredModel: string | undefined,
  vault?: ResolvedVault,
): AgentTool<typeof ImageGenerateSchema> {
  return {
    name: "image_generate",
    label: "Generate Image",
    description: "Generate an image from a text prompt. " +
      "Output format inferred from file extension (png, jpg, webp). " +
      "Model is configured at agent level (image_model) — pass `model` here only to override per-call. " +
      "Default: fal/fal-ai/flux/dev. Currently supports fal as image provider.",
    parameters: ImageGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "image_generate");

      try {
        const parsed = resolveEffectiveModel(params.model, configuredModel, DEFAULT_IMAGE_MODEL);
        return await generateImageWithSdk(filePath, parsed, params, fs, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image generation error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function generateImageWithSdk(
  filePath: string,
  parsed: ParsedModel,
  params: {
    prompt: string;
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

  const managed = shouldUseGateway(parsed.provider, vault);

  let model: unknown;
  let providerOptions: Record<string, unknown> | undefined;
  if (managed) {
    // Managed: route through the gateway (platform key pays, cost metered).
    const provider = await resolveManagedImageProvider();
    model = provider.image(gatewayModelId(parsed, DEFAULT_MANAGED_IMAGE_MODEL));
  } else {
    // BYOK / self-host: direct provider SDK with the agent's own key.
    const apiKey = resolveProviderKey(parsed.provider, vault);
    const provider = await resolveImageProvider(parsed.provider as ImageProviderName, apiKey);
    model = provider.image(parsed.model);
    // fal-specific knobs go through providerOptions; the SDK passes them
    // through to the model's input untouched.
    const falOptions: Record<string, number> = {};
    if (params.num_inference_steps != null) falOptions.num_inference_steps = params.num_inference_steps;
    if (params.guidance_scale != null) falOptions.guidance_scale = params.guidance_scale;
    providerOptions = parsed.provider === "fal" && Object.keys(falOptions).length
      ? { fal: falOptions }
      : undefined;
  }

  const result = await generateImage({
    model: model as any,
    prompt: params.prompt,
    size: params.size as `${number}x${number}` | undefined,
    seed: params.seed,
    providerOptions: providerOptions as any,
    abortSignal: signal,
  });

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
    `Model: ${parsed.provider}/${parsed.model}`,
  ];
  if (params.size) info.push(`Dimensions: ${params.size}`);

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: managed ? "gateway" : parsed.provider,
      model: parsed.model,
      size: params.size,
      path: filePath,
      bytes: bytes.byteLength,
      // Billable cost (managed/gateway only) — harvested by the runner.
      usage: extractGatewayUsage(result),
    },
  };
}

// ─── Tool: video_generate ───

const VideoGenerateSchema = Type.Object({
  prompt: Type.String({ description: "Text prompt describing the video to generate" }),
  path: Type.String({ description: "Output file path (e.g. 'output.mp4')." }),
  model: Type.Optional(Type.String({
    description: "Override the agent's video_model for this call. Format: '<provider>/<model>' " +
      "(e.g. 'fal/luma-ray-2-flash', 'fal/luma-ray-2', 'fal/hunyuan-video'). When omitted, uses the agent's configured video_model.",
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

function createVideoGenerateTool(
  cwd: string,
  sandbox: string[],
  fs: FileSystem,
  configuredModel: string | undefined,
  vault?: ResolvedVault,
): AgentTool<typeof VideoGenerateSchema> {
  return {
    name: "video_generate",
    label: "Generate Video",
    description: "Generate a video from a text prompt. " +
      "Output saved as MP4. Model is configured at agent level (video_model) — pass `model` here only to override " +
      "per-call. Default: fal/luma-ray-2-flash. Currently supports fal as video provider.",
    parameters: VideoGenerateSchema,
    async execute(_id, params, signal) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "video_generate");

      try {
        const parsed = resolveEffectiveModel(params.model, configuredModel, DEFAULT_VIDEO_MODEL);
        return await generateVideoWithSdk(filePath, parsed, params, fs, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Video generation error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function generateVideoWithSdk(
  filePath: string,
  parsed: ParsedModel,
  params: {
    prompt: string;
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

  // Managed video is ON by default (same as image) — routed through the
  // gateway when there's no provider key + an AI_GATEWAY_API_KEY. Each clip
  // costs ~$1.20 with no in-sandbox balance pre-check, so a kill switch is
  // kept: set POLPO_MANAGED_VIDEO=0 to force BYOK (direct fal) instead.
  const managed =
    shouldUseGateway(parsed.provider, vault) && process.env.POLPO_MANAGED_VIDEO !== "0";

  let model: unknown;
  if (managed) {
    // Managed: gateway with an extended-timeout fetch (long renders).
    const provider = await resolveManagedVideoProvider();
    model = provider.video(gatewayModelId(parsed, DEFAULT_MANAGED_VIDEO_MODEL));
  } else {
    const apiKey = resolveProviderKey(parsed.provider, vault);
    const provider = await resolveVideoProvider(parsed.provider as VideoProviderName, apiKey);
    model = provider.video(parsed.model);
  }

  const result = await experimental_generateVideo({
    model: model as any,
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
    `Model: ${parsed.provider}/${parsed.model}`,
  ];

  return {
    content: [{ type: "text", text: info.join("\n") }],
    details: {
      provider: managed ? "gateway" : parsed.provider,
      model: parsed.model,
      path: filePath,
      bytes: bytes.byteLength,
      // Billable cost (managed/gateway only) — harvested by the runner.
      usage: extractGatewayUsage(result),
    },
  };
}

// ─── Tool: image_analyze ───

const ImageAnalyzeSchema = Type.Object({
  path: Type.String({ description: "Path to the image file to analyze" }),
  prompt: Type.Optional(Type.String({ description: "Question or instruction for the vision model (default: 'Describe this image in detail')" })),
  model: Type.Optional(Type.String({
    description: "Override the agent's vision_model for this call. Format: '<provider>/<model>' " +
      "(e.g. 'openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-20250514'). When omitted, uses the agent's configured vision_model.",
  })),
  max_tokens: Type.Optional(Type.Number({ description: "Max tokens in response (default: 1024)" })),
});

function createAnalyzeTool(
  cwd: string,
  sandbox: string[],
  fs: FileSystem,
  configuredModel: string | undefined,
  vault?: ResolvedVault,
): AgentTool<typeof ImageAnalyzeSchema> {
  return {
    name: "image_analyze",
    label: "Analyze Image",
    description: "Analyze an image using AI vision models. Can describe contents, extract text (OCR), " +
      "answer questions about the image, identify objects, read charts, etc. " +
      "Model is configured at agent level (vision_model) — pass `model` here only to override per-call. " +
      "Default: openai/gpt-4o-mini. Supported providers: openai, anthropic.",
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

      try {
        const parsed = resolveEffectiveModel(params.model, configuredModel, DEFAULT_VISION_MODEL);
        return await analyzeWithSdk(filePath, fileBuffer, parsed, params, vault, signal);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Image analysis error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

async function analyzeWithSdk(
  filePath: string,
  fileBuffer: Buffer,
  parsed: ParsedModel,
  params: { prompt?: string; max_tokens?: number },
  vault?: ResolvedVault,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const { generateText } = await import("ai");

  const apiKey = resolveProviderKey(parsed.provider, vault);
  const provider = await resolveVisionProvider(parsed.provider as VisionProviderName, apiKey);

  const ext = extname(filePath).toLowerCase();
  const mediaType = imageMime(ext);

  const result = await generateText({
    model: provider(parsed.model) as any,
    maxOutputTokens: params.max_tokens ?? 1024,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: params.prompt ?? "Describe this image in detail." },
        { type: "image", image: new Uint8Array(fileBuffer), mediaType },
      ],
    }],
    abortSignal: signal,
  });

  return {
    content: [{ type: "text", text: result.text }],
    details: {
      provider: parsed.provider,
      model: parsed.model,
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

export interface CreateImageToolsOptions {
  cwd: string;
  allowedPaths?: string[];
  allowedTools?: string[];
  vault?: ResolvedVault;
  fs?: FileSystem;
  /** Resolved agent.image_model. Format: "provider/model". */
  imageModel?: string;
  /** Resolved agent.video_model. Format: "provider/model". */
  videoModel?: string;
  /** Resolved agent.vision_model. Format: "provider/model". */
  visionModel?: string;
}

/**
 * Create image & video tools for generation, vision analysis, and video creation.
 *
 * The 6-arg positional signature is preserved for back-compat. Prefer the
 * options-object form (`{ cwd, vault, imageModel, ... }`) for new callers.
 */
export function createImageTools(
  cwd: string | CreateImageToolsOptions,
  allowedPaths?: string[],
  allowedTools?: string[],
  vault?: ResolvedVault,
  fs?: FileSystem,
): AgentTool<any>[] {
  const opts: CreateImageToolsOptions = typeof cwd === "string"
    ? { cwd, allowedPaths, allowedTools, vault, fs }
    : cwd;

  const sandbox = resolveAllowedPaths(opts.cwd, opts.allowedPaths);
  const _fs = opts.fs ?? new NodeFileSystem();

  const factories: Record<ImageToolName, () => AgentTool<any>> = {
    image_generate: () => createGenerateTool(opts.cwd, sandbox, _fs, opts.imageModel, opts.vault),
    image_analyze:  () => createAnalyzeTool(opts.cwd, sandbox, _fs, opts.visionModel, opts.vault),
    video_generate: () => createVideoGenerateTool(opts.cwd, sandbox, _fs, opts.videoModel, opts.vault),
  };

  const names = opts.allowedTools
    ? ALL_IMAGE_TOOL_NAMES.filter(n => opts.allowedTools!.some(a => a.toLowerCase() === n))
    : ALL_IMAGE_TOOL_NAMES;

  return names.map(n => factories[n]());
}
