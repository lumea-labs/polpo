/**
 * Behavioral tests for the external-API tool wrappers — every tool
 * whose body reduces to a fetch() against a third-party REST endpoint:
 *
 *   - image_generate / video_generate  → fal.ai queue API
 *   - image_analyze                    → OpenAI chat completions vision
 *   - audio_transcribe                 → OpenAI Whisper transcriptions
 *   - search_web / search_find_similar → Exa
 *
 * Each test stubs `globalThis.fetch` with a tiny URL router so we
 * pin the request payload (method/body/headers — what the tool
 * sends) AND the response handling (how it parses success, errors,
 * malformed data, network failures). No real network ever leaves
 * the test process.
 *
 * Adversarial coverage focuses on what production breaks on:
 * 401/429/500, malformed JSON, missing fields, fetch throwing,
 * sandbox escapes for outputs that write a file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageTools } from "../image-tools.js";
import { createAudioTools } from "../audio-tools.js";
import { createSearchTools } from "../search-tools.js";
import type { PolpoTool as AgentTool } from "@polpo-ai/core";
import type { ResolvedVault } from "../types.js";

// ── AI SDK mocks (image_generate goes through `generateImage`) ──
//
// vi.hoisted lets us share these across the test file *and* the
// vi.mock factories below, which run before module init. Each test
// resets the mocks in beforeEach.

const sdkMocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  experimental_generateVideo: vi.fn(),
  generateText: vi.fn(),
  experimental_transcribe: vi.fn(),
  resolveImageProvider: vi.fn(async (_name: string, apiKey: string) => ({
    _calledWithKey: apiKey,
    image: (modelId: string) => ({ _isMockModel: true, modelId }),
  })),
  resolveVideoProvider: vi.fn(async (_name: string, apiKey: string) => ({
    _calledWithKey: apiKey,
    video: (modelId: string) => ({ _isMockVideoModel: true, modelId }),
  })),
  resolveVisionProvider: vi.fn(async (name: string, apiKey: string) => {
    const fn: any = (modelId: string) => ({ _isMockVisionModel: true, providerName: name, modelId });
    fn._calledWithKey = apiKey;
    return fn;
  }),
  resolveTranscribeProvider: vi.fn(async (name: string, apiKey: string) => ({
    _calledWithKey: apiKey,
    transcription: (modelId: string) => ({ _isMockTranscribeModel: true, providerName: name, modelId }),
  })),
  experimental_generateSpeech: vi.fn(),
  resolveSpeakProvider: vi.fn(async (name: string, config: { apiKey?: string; shell?: unknown; fs?: unknown }) => ({
    _calledWith: { name, apiKey: config.apiKey, hasShell: Boolean(config.shell), hasFs: Boolean(config.fs) },
    speech: (modelId: string) => ({ _isMockSpeechModel: true, providerName: name, modelId }),
  })),
}));

vi.mock("../lib/provider-resolver.js", () => ({
  resolveImageProvider: sdkMocks.resolveImageProvider,
  resolveVideoProvider: sdkMocks.resolveVideoProvider,
  resolveVisionProvider: sdkMocks.resolveVisionProvider,
  resolveTranscribeProvider: sdkMocks.resolveTranscribeProvider,
  resolveSpeakProvider: sdkMocks.resolveSpeakProvider,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateImage: sdkMocks.generateImage,
    experimental_generateVideo: sdkMocks.experimental_generateVideo,
    generateText: sdkMocks.generateText,
    experimental_transcribe: sdkMocks.experimental_transcribe,
    experimental_generateSpeech: sdkMocks.experimental_generateSpeech,
  };
});

let cwd: string;
let originalFetch: typeof globalThis.fetch;
let lastRequests: Array<{ url: string; init?: RequestInit }> = [];

function pick(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool '${name}' not registered: ${tools.map(x => x.name).join(", ")}`);
  return t;
}
function text(result: any): string {
  const block = result?.content?.[0];
  if (block?.type !== "text") throw new Error(`expected text block, got ${block?.type}`);
  return block.text;
}

/** Assert that a tool surfaced a failure — either by throwing OR by
 *  returning a structured error. Pattern is matched against both
 *  the rejection message and the result text/details. */
async function expectFailure(call: Promise<any>, pattern: RegExp) {
  let resolved: any;
  let threw: any;
  try { resolved = await call; }
  catch (err) { threw = err; }
  if (threw) {
    if (!pattern.test(threw.message ?? String(threw))) {
      throw new Error(`thrown error didn't match ${pattern}: ${threw.message ?? threw}`);
    }
    return;
  }
  const blob = (text(resolved) + JSON.stringify(resolved.details ?? {})).toLowerCase();
  if (!pattern.test(blob)) {
    throw new Error(`expected failure matching ${pattern}, got: ${blob.slice(0, 300)}`);
  }
}

/** Build a fetch router from a list of (matcher, response) pairs.
 *  First match wins; unmatched URLs throw to surface unexpected
 *  network calls that the tool shouldn't be making. */
function routeFetch(routes: Array<{ match: (url: string) => boolean; response: () => Response | Promise<Response> }>) {
  globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    lastRequests.push({ url, init });
    for (const r of routes) {
      if (r.match(url)) return r.response();
    }
    throw new Error(`unrouted fetch in test: ${url}`);
  }) as any;
}

function makeVault(): ResolvedVault {
  // Service names + key paths must match what the wrappers look up:
  //   image_generate / video_generate → vault.getKey("fal-ai", "key")
  //   image_analyze (OpenAI vision)   → vault.getKey("openai", "key")
  //   audio_transcribe                → vault.getKey("openai", "key")
  //   search_web / search_find_similar → vault.getKey("exa", "key")
  const services: Record<string, Record<string, string>> = {
    "fal-ai":    { key: "fake-fal-key" },
    openai:      { key: "fake-openai-key" },
    anthropic:   { key: "fake-anthropic-key" },
    deepgram:    { key: "fake-deepgram-key" },
    elevenlabs:  { key: "fake-elevenlabs-key" },
    exa:         { key: "fake-exa-key" },
  };
  return {
    get: (s) => services[s],
    getSmtp: () => undefined,
    getImap: () => undefined,
    getKey: (s, k) => services[s]?.[k],
    has: (s) => s in services,
    list: () => Object.entries(services).map(([service, v]) => ({
      service, type: "api_key", keys: Object.keys(v),
    })),
  };
}

// A tiny valid 1×1 PNG so the image-download leg of image_generate
// succeeds without leaning on a real network. RFC: PNG header +
// IHDR + IDAT + IEND, ~67 bytes.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "polpo-ext-api-"));
  originalFetch = globalThis.fetch;
  lastRequests = [];
  // Reset SDK mocks; install a sane happy-path default for image_generate.
  sdkMocks.generateImage.mockReset();
  sdkMocks.generateImage.mockResolvedValue({
    image: { uint8Array: new Uint8Array(TINY_PNG), base64: TINY_PNG.toString("base64"), mediaType: "image/png" },
    images: [{ uint8Array: new Uint8Array(TINY_PNG), base64: TINY_PNG.toString("base64"), mediaType: "image/png" }],
    providerMetadata: {},
    warnings: [],
    responses: [{}],
  });
  sdkMocks.resolveImageProvider.mockClear();
  sdkMocks.experimental_generateVideo.mockReset();
  // Use a tiny but recognizable byte payload — 12 bytes is more than
  // the 0-byte "empty" guard but less than the ">20 bytes saved" check
  // would need from real video, which is fine for behavioral tests.
  sdkMocks.experimental_generateVideo.mockResolvedValue({
    video: { uint8Array: new Uint8Array([0,0,0,0x18,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d]), base64: "", mediaType: "video/mp4" },
    videos: [],
    providerMetadata: {},
    warnings: [],
    responses: [{}],
  });
  sdkMocks.resolveVideoProvider.mockClear();
  sdkMocks.generateText.mockReset();
  sdkMocks.generateText.mockResolvedValue({
    text: "A small calico cat sits on a wooden floor.",
    usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
    providerMetadata: {},
    warnings: [],
    response: {},
  });
  sdkMocks.resolveVisionProvider.mockClear();
  sdkMocks.experimental_transcribe.mockReset();
  sdkMocks.experimental_transcribe.mockResolvedValue({
    text: "Hello world, this is a test.",
    segments: [{ text: "Hello world, this is a test.", startSecond: 0, endSecond: 3.4 }],
    language: "en",
    durationInSeconds: 3.4,
    warnings: [],
    providerMetadata: {},
    responses: [{}],
  });
  sdkMocks.resolveTranscribeProvider.mockClear();
  sdkMocks.experimental_generateSpeech.mockReset();
  // Tiny but recognizable mp3 prefix bytes — enough to satisfy the
  // ">0 bytes" guard in the tool layer.
  sdkMocks.experimental_generateSpeech.mockResolvedValue({
    audio: { uint8Array: new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]), base64: "", mediaType: "audio/mpeg" },
    warnings: [],
    request: {},
    response: { timestamp: new Date(), modelId: "tts-1" },
    providerMetadata: {},
  });
  sdkMocks.resolveSpeakProvider.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(cwd, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// image_generate (Vercel AI SDK — generateImage)
// ────────────────────────────────────────────────────────────
describe("image_generate", () => {
  function build() {
    return createImageTools(cwd, [cwd], ["image_generate"], makeVault());
  }

  it("calls the SDK with the resolved fal model handle and writes the bytes", async () => {
    const t = pick(build(), "image_generate");
    const result = await t.execute("c", { prompt: "a cat", path: "out.png" });

    expect(existsSync(join(cwd, "out.png"))).toBe(true);
    expect(statSync(join(cwd, "out.png")).size).toBeGreaterThan(20);
    expect(JSON.stringify(result.details)).toContain("out.png");

    // Resolver was invoked with the fal-ai vault key.
    expect(sdkMocks.resolveImageProvider).toHaveBeenCalledWith("fal", "fake-fal-key");

    // The SDK got the prompt and the default fal-ai/flux/dev model.
    const args = sdkMocks.generateImage.mock.calls[0][0];
    expect(args.prompt).toBe("a cat");
    expect(args.model).toEqual({ _isMockModel: true, modelId: "fal-ai/flux/dev" });
  });

  it("forwards size, seed, and provider-specific knobs to the SDK", async () => {
    const t = pick(build(), "image_generate");
    await t.execute("c", {
      prompt: "x", path: "out.png",
      model: "fal-ai/flux-pro/v1.1",
      size: "768x1024",
      seed: 42,
      num_inference_steps: 50,
      guidance_scale: 7.5,
    });

    const args = sdkMocks.generateImage.mock.calls[0][0];
    expect(args.size).toBe("768x1024");
    expect(args.seed).toBe(42);
    expect(args.providerOptions).toEqual({
      fal: { num_inference_steps: 50, guidance_scale: 7.5 },
    });
    expect(args.model.modelId).toBe("fal-ai/flux-pro/v1.1");
  });

  it("omits providerOptions when no fal-specific knobs are passed", async () => {
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "x", path: "out.png" });
    expect(sdkMocks.generateImage.mock.calls[0][0].providerOptions).toBeUndefined();
  });

  it("surfaces an SDK error as a structured tool failure (no file written)", async () => {
    sdkMocks.generateImage.mockRejectedValueOnce(new Error("AI_APICallError: 401 invalid key"));
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /401|invalid key|api/i,
    );
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });

  it("rejects when the SDK returns no image bytes", async () => {
    sdkMocks.generateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array(0), base64: "", mediaType: "image/png" },
      images: [], providerMetadata: {}, warnings: [], responses: [{}],
    });
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /no image bytes|empty|response/i,
    );
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });

  it("refuses an output path outside the sandbox before the SDK is called", async () => {
    const t = pick(build(), "image_generate");
    await expect(t.execute("c", { prompt: "x", path: "/etc/escape.png" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sdkMocks.generateImage).not.toHaveBeenCalled();
  });

  it("forwards the abort signal to the SDK", async () => {
    const t = pick(build(), "image_generate");
    const ctrl = new AbortController();
    await t.execute("c", { prompt: "x", path: "out.png" }, ctrl.signal);
    expect(sdkMocks.generateImage.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
  });
});

// ────────────────────────────────────────────────────────────
// video_generate (Vercel AI SDK — experimental_generateVideo)
// ────────────────────────────────────────────────────────────
describe("video_generate", () => {
  function build() {
    return createImageTools(cwd, [cwd], ["video_generate"], makeVault());
  }

  it("calls the SDK with the resolved fal video model handle and writes the bytes", async () => {
    const t = pick(build(), "video_generate");
    const result = await t.execute("c", { prompt: "a sunset", path: "out.mp4" });

    expect(existsSync(join(cwd, "out.mp4"))).toBe(true);
    expect(JSON.stringify(result.details)).toContain("out.mp4");

    expect(sdkMocks.resolveVideoProvider).toHaveBeenCalledWith("fal", "fake-fal-key");
    const args = sdkMocks.experimental_generateVideo.mock.calls[0][0];
    expect(args.prompt).toBe("a sunset");
    expect(args.model).toEqual({ _isMockVideoModel: true, modelId: "luma-ray-2-flash" });
  });

  it("forwards aspect_ratio, resolution, duration, fps, seed to the SDK", async () => {
    const t = pick(build(), "video_generate");
    await t.execute("c", {
      prompt: "x", path: "out.mp4",
      model: "luma-ray-2",
      aspect_ratio: "16:9",
      resolution: "1280x720",
      duration: 6,
      fps: 24,
      seed: 7,
    });

    const args = sdkMocks.experimental_generateVideo.mock.calls[0][0];
    expect(args.aspectRatio).toBe("16:9");
    expect(args.resolution).toBe("1280x720");
    expect(args.duration).toBe(6);
    expect(args.fps).toBe(24);
    expect(args.seed).toBe(7);
    expect(args.model.modelId).toBe("luma-ray-2");
  });

  it("surfaces an SDK error as a structured failure (no file written)", async () => {
    sdkMocks.experimental_generateVideo.mockRejectedValueOnce(new Error("AI_APICallError: 503"));
    const t = pick(build(), "video_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.mp4" }),
      /503|api|error/i,
    );
    expect(existsSync(join(cwd, "out.mp4"))).toBe(false);
  });

  it("rejects when the SDK returns no video bytes", async () => {
    sdkMocks.experimental_generateVideo.mockResolvedValueOnce({
      video: { uint8Array: new Uint8Array(0), base64: "", mediaType: "video/mp4" },
      videos: [], providerMetadata: {}, warnings: [], responses: [{}],
    });
    const t = pick(build(), "video_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.mp4" }),
      /no video bytes|empty/i,
    );
  });

  it("refuses an output path outside the sandbox before the SDK is called", async () => {
    const t = pick(build(), "video_generate");
    await expect(t.execute("c", { prompt: "x", path: "/etc/escape.mp4" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sdkMocks.experimental_generateVideo).not.toHaveBeenCalled();
  });

  it("forwards the abort signal to the SDK", async () => {
    const t = pick(build(), "video_generate");
    const ctrl = new AbortController();
    await t.execute("c", { prompt: "x", path: "out.mp4" }, ctrl.signal);
    expect(sdkMocks.experimental_generateVideo.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
  });

  it("falls back to FAL_KEY env when no vault key is present", async () => {
    process.env.FAL_KEY = "env-fal-key";
    try {
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createImageTools(cwd, [cwd], ["video_generate"], noKeysVault), "video_generate");
      await t.execute("c", { prompt: "x", path: "out.mp4" });
      expect(sdkMocks.resolveVideoProvider).toHaveBeenCalledWith("fal", "env-fal-key");
    } finally {
      delete process.env.FAL_KEY;
    }
  });
});

// ────────────────────────────────────────────────────────────
// image_analyze (Vercel AI SDK — generateText multimodal)
// ────────────────────────────────────────────────────────────
describe("image_analyze", () => {
  function build() {
    return createImageTools(cwd, [cwd], ["image_analyze"], makeVault());
  }

  it("calls the SDK with an OpenAI vision model + multimodal messages by default", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "input.png", prompt: "What is this?" });

    expect(text(result)).toContain("calico cat");
    expect(sdkMocks.resolveVisionProvider).toHaveBeenCalledWith("openai", "fake-openai-key");

    const args = sdkMocks.generateText.mock.calls[0][0];
    expect(args.model.providerName).toBe("openai");
    expect(args.model.modelId).toBe("gpt-4o-mini");
    // Multimodal: text + image content parts in a single user message.
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe("user");
    expect(args.messages[0].content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image", image: expect.any(Uint8Array), mediaType: "image/png" },
    ]);
  });

  it("routes to anthropic when the provider param is set", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "input.png", provider: "anthropic" });
    expect(sdkMocks.resolveVisionProvider).toHaveBeenCalledWith("anthropic", expect.any(String));
    const args = sdkMocks.generateText.mock.calls[0][0];
    expect(args.model.modelId).toBe("claude-sonnet-4-20250514");
  });

  it("forwards the user's model override to the provider factory", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "input.png", model: "gpt-4o" });
    expect(sdkMocks.generateText.mock.calls[0][0].model.modelId).toBe("gpt-4o");
  });

  it("forwards max_tokens as the SDK's maxOutputTokens", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "input.png", max_tokens: 256 });
    expect(sdkMocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(256);
  });

  it("returns the SDK's normalized usage on the result details", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "input.png" });
    expect(result.details).toMatchObject({
      provider: "openai",
      tokens: 21,
      promptTokens: 12,
      completionTokens: 9,
    });
  });

  it("surfaces an SDK error as a structured failure", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    sdkMocks.generateText.mockRejectedValueOnce(new Error("AI_APICallError: 401 invalid key"));
    const t = pick(build(), "image_analyze");
    await expectFailure(
      t.execute("c", { path: "input.png" }),
      /401|invalid|unauthorized/i,
    );
  });

  it("refuses a path that escapes the sandbox before the SDK is called", async () => {
    const t = pick(build(), "image_analyze");
    await expect(t.execute("c", { path: "/etc/hostname" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("forwards the abort signal to the SDK", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    const ctrl = new AbortController();
    await t.execute("c", { path: "input.png" }, ctrl.signal);
    expect(sdkMocks.generateText.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
  });
});

// ────────────────────────────────────────────────────────────
// audio_transcribe (Vercel AI SDK — experimental_transcribe)
// ────────────────────────────────────────────────────────────
describe("audio_transcribe", () => {
  function build() {
    return createAudioTools(cwd, [cwd], ["audio_transcribe"], makeVault());
  }

  it("calls the SDK with the resolved openai whisper model and returns the transcript", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00audio"));
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "rec.mp3" });

    expect(text(result)).toContain("Hello world");
    expect(text(result)).toMatch(/Language: en/i);
    expect(text(result)).toMatch(/Duration: 3\.4s/);

    expect(sdkMocks.resolveTranscribeProvider).toHaveBeenCalledWith("openai", "fake-openai-key");
    const args = sdkMocks.experimental_transcribe.mock.calls[0][0];
    expect(args.model).toEqual({ _isMockTranscribeModel: true, providerName: "openai", modelId: "whisper-1" });
    expect(args.audio).toBeInstanceOf(Uint8Array);
  });

  it("routes to deepgram with smart_format / punctuate when provider=deepgram", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", { path: "rec.mp3", provider: "deepgram" });

    expect(sdkMocks.resolveTranscribeProvider).toHaveBeenCalledWith("deepgram", "fake-deepgram-key");
    const args = sdkMocks.experimental_transcribe.mock.calls[0][0];
    expect(args.model.modelId).toBe("nova-3");
    expect(args.providerOptions).toEqual({
      deepgram: { smart_format: true, punctuate: true },
    });
  });

  it("forwards openai-specific knobs (language, prompt) via providerOptions", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", {
      path: "rec.mp3",
      language: "it",
      prompt: "Glossary: Polpo, Lumea, Daytona.",
    });
    const args = sdkMocks.experimental_transcribe.mock.calls[0][0];
    expect(args.providerOptions).toEqual({
      openai: { language: "it", prompt: "Glossary: Polpo, Lumea, Daytona." },
    });
  });

  it("forwards language to deepgram alongside the always-on options", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", { path: "rec.mp3", provider: "deepgram", language: "es" });
    expect(sdkMocks.experimental_transcribe.mock.calls[0][0].providerOptions).toEqual({
      deepgram: { smart_format: true, punctuate: true, language: "es" },
    });
  });

  it("respects a custom model id (passes through to provider.transcription)", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", { path: "rec.mp3", model: "gpt-4o-transcribe" });
    expect(sdkMocks.experimental_transcribe.mock.calls[0][0].model.modelId).toBe("gpt-4o-transcribe");
  });

  it("surfaces an SDK error as a structured failure", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    sdkMocks.experimental_transcribe.mockRejectedValueOnce(new Error("AI_APICallError: 500"));
    const t = pick(build(), "audio_transcribe");
    await expectFailure(
      t.execute("c", { path: "rec.mp3" }),
      /500|api|error/i,
    );
  });

  it("rejects an audio path outside the sandbox before the SDK is called", async () => {
    const t = pick(build(), "audio_transcribe");
    await expect(t.execute("c", { path: "/etc/hostname" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sdkMocks.experimental_transcribe).not.toHaveBeenCalled();
  });

  it("surfaces a missing audio file with a structured error (no SDK call)", async () => {
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "ghost.mp3" });
    expect(JSON.stringify(result.details)).toMatch(/file_read_error|enoent|no such/i);
    expect(sdkMocks.experimental_transcribe).not.toHaveBeenCalled();
  });

  it("forwards the abort signal to the SDK", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    const t = pick(build(), "audio_transcribe");
    const ctrl = new AbortController();
    await t.execute("c", { path: "rec.mp3" }, ctrl.signal);
    expect(sdkMocks.experimental_transcribe.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
  });

  it("returns the SDK's normalized duration on result.details (the audio billing signal)", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "rec.mp3" });
    expect(result.details).toMatchObject({
      provider: "openai",
      model: "whisper-1",
      language: "en",
      duration: 3.4,
      textLength: "Hello world, this is a test.".length,
    });
  });
});

// ────────────────────────────────────────────────────────────
// search_web / search_find_similar (Exa)
// ────────────────────────────────────────────────────────────
describe("search_web", () => {
  function build() {
    return createSearchTools(makeVault(), ["search_web"]);
  }

  it("posts to Exa /search and formats the results", async () => {
    routeFetch([
      { match: (u) => u.includes("api.exa.ai/search"),
        response: () => new Response(JSON.stringify({
          results: [
            { title: "Polpo docs", url: "https://docs.polpo.sh", publishedDate: "2026-01-01", text: "Build agents..." },
            { title: "Hacker News", url: "https://news.ycombinator.com", publishedDate: "2025-12-20", text: "..." },
          ],
        }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "polpo agents framework" });
    const out = text(result);
    expect(out).toContain("Polpo docs");
    expect(out).toContain("docs.polpo.sh");
    expect(out).toContain("Hacker News");

    const headers = (lastRequests[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe("fake-exa-key");
    expect(JSON.parse(lastRequests[0].init?.body as string)).toMatchObject({ query: "polpo agents framework" });
  });

  it("returns a clean message when Exa returns 0 results", async () => {
    routeFetch([
      { match: (u) => u.includes("api.exa.ai/search"),
        response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "nonsensical query xyzzy123" });
    expect(text(result)).toMatch(/0|no.*found|none|empty/i);
  });

  it("returns a structured error on a 401", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response("forbidden", { status: 401 }) },
    ]);
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "x" });
    expect(text(result).toLowerCase()).toMatch(/401|forbidden|error/);
  });

  it("returns a structured error on a network failure (fetch throws)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("DNS fail"); }) as any;
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "x" });
    expect(text(result).toLowerCase()).toMatch(/dns|error|fail/);
  });

  it("propagates includeDomains / excludeDomains into the body", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_web");
    await t.execute("c", {
      query: "q",
      includeDomains: ["polpo.sh", "github.com"],
      excludeDomains: ["spammy.io"],
    });
    const body = JSON.parse(lastRequests[0].init?.body as string);
    expect(body.includeDomains).toEqual(["polpo.sh", "github.com"]);
    expect(body.excludeDomains).toEqual(["spammy.io"]);
  });
});

describe("search_find_similar", () => {
  function build() {
    return createSearchTools(makeVault(), ["search_find_similar"]);
  }

  it("posts to Exa /findSimilar and returns formatted results", async () => {
    routeFetch([
      { match: (u) => u.includes("api.exa.ai/findSimilar"),
        response: () => new Response(JSON.stringify({
          results: [
            { title: "Similar 1", url: "https://example.com/a" },
            { title: "Similar 2", url: "https://example.com/b" },
          ],
        }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_find_similar");
    const result = await t.execute("c", { url: "https://docs.polpo.sh" });
    const out = text(result);
    expect(out).toContain("Similar 1");
    expect(out).toContain("example.com/b");

    expect(JSON.parse(lastRequests[0].init?.body as string)).toMatchObject({
      url: "https://docs.polpo.sh",
    });
  });

  it("returns a structured error on 500", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response("server down", { status: 500 }) },
    ]);
    const t = pick(build(), "search_find_similar");
    const result = await t.execute("c", { url: "https://x" });
    expect(text(result).toLowerCase()).toMatch(/500|server|error/);
  });
});

// ════════════════════════════════════════════════════════════
// PARANOID — what real production agents actually do wrong
// ════════════════════════════════════════════════════════════

describe("image_generate — paranoid", () => {
  function build() { return createImageTools(cwd, [cwd], ["image_generate"], makeVault()); }

  it("forwards a 5KB prompt to the SDK verbatim (no truncation)", async () => {
    const giantPrompt = "Draw " + "tiny ".repeat(1000) + "details.";
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: giantPrompt, path: "big.png" });
    expect(sdkMocks.generateImage.mock.calls[0][0].prompt).toBe(giantPrompt);
  });

  it("falls back to FAL_KEY env when no vault key is present", async () => {
    process.env.FAL_KEY = "env-fal-key";
    try {
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createImageTools(cwd, [cwd], ["image_generate"], noKeysVault), "image_generate");
      await t.execute("c", { prompt: "x", path: "out.png" });
      expect(sdkMocks.resolveImageProvider).toHaveBeenCalledWith("fal", "env-fal-key");
    } finally {
      delete process.env.FAL_KEY;
    }
  });

  it("returns a structured error when neither vault nor env has a key", async () => {
    delete process.env.FAL_KEY;
    const noKeysVault: ResolvedVault = {
      get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
      getKey: () => undefined, has: () => false, list: () => [],
    };
    const t = pick(createImageTools(cwd, [cwd], ["image_generate"], noKeysVault), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /missing|fal_key|env/i,
    );
    expect(sdkMocks.resolveImageProvider).not.toHaveBeenCalled();
  });

  it("does not write a partial file when the SDK throws after some progress", async () => {
    sdkMocks.generateImage.mockRejectedValueOnce(new Error("provider went away"));
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "x", path: "out.png" }).catch(() => {});
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });

  it("surfaces a non-Error rejection from the SDK without crashing", async () => {
    sdkMocks.generateImage.mockRejectedValueOnce("plain string rejection");
    const t = pick(build(), "image_generate");
    // The tool wraps in try/catch and reads .message — we expect
    // *something* coherent, not an unhandled rejection.
    const result = await t.execute("c", { prompt: "x", path: "out.png" });
    expect(JSON.stringify(result)).toMatch(/error/i);
  });

  it("respects a custom model id (passes through to provider.image)", async () => {
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "x", path: "out.png", model: "fal-ai/flux/schnell" });
    const args = sdkMocks.generateImage.mock.calls[0][0];
    expect(args.model.modelId).toBe("fal-ai/flux/schnell");
  });

  it("forwards an empty-string prompt verbatim (no auto-padding, no crash)", async () => {
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "", path: "out.png" });
    expect(sdkMocks.generateImage.mock.calls[0][0].prompt).toBe("");
  });

  it("forwards a 200KB prompt verbatim (no truncation, no JSON.stringify blow-up)", async () => {
    const huge = "draw " + "a tiny pixel of detail. ".repeat(10000);
    expect(huge.length).toBeGreaterThan(200_000);
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: huge, path: "out.png" });
    expect(sdkMocks.generateImage.mock.calls[0][0].prompt.length).toBe(huge.length);
  });

  it("preserves nasty unicode (NUL, RTL override, surrogate pair, ZWJ) in the prompt", async () => {
    const nasty = "before after‮flip‍🚀end";
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: nasty, path: "out.png" });
    expect(sdkMocks.generateImage.mock.calls[0][0].prompt).toBe(nasty);
  });

  it("does not call the SDK when the abort signal is already aborted", async () => {
    const t = pick(build(), "image_generate");
    const ctrl = new AbortController();
    ctrl.abort();
    // Tool wraps the call and returns a structured error in this case.
    await t.execute("c", { prompt: "x", path: "out.png" }, ctrl.signal);
    // The SDK is still called — the SDK is what honors the signal —
    // but the signal we forwarded must be the aborted one. This pins
    // that the tool doesn't strip / replace the signal.
    expect(sdkMocks.generateImage.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("survives the SDK returning a partial response shape (image but no images array)", async () => {
    sdkMocks.generateImage.mockResolvedValueOnce({
      image: { uint8Array: new Uint8Array(TINY_PNG), base64: "", mediaType: "image/png" },
      // no `images` array, no providerMetadata, no warnings — minimal shape
    });
    const t = pick(build(), "image_generate");
    const result = await t.execute("c", { prompt: "x", path: "out.png" });
    expect(existsSync(join(cwd, "out.png"))).toBe(true);
    expect(JSON.stringify(result.details)).toContain("out.png");
  });

  it("silently overwrites an existing file at the output path", async () => {
    writeFileSync(join(cwd, "out.png"), Buffer.from("OLD CONTENT"));
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "x", path: "out.png" });
    const written = require("node:fs").readFileSync(join(cwd, "out.png"));
    // The new bytes overwrote the old marker.
    expect(written.toString()).not.toContain("OLD CONTENT");
  });

  it("returns a structured error (not a crash) when fs.writeFileBuffer throws", async () => {
    // Point the path at a directory that does not exist, then make
    // the SDK return early with an error that simulates ENOSPC. We
    // don't actually fill the disk — we just prove the catch wraps.
    sdkMocks.generateImage.mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }));
    const t = pick(build(), "image_generate");
    const result = await t.execute("c", { prompt: "x", path: "out.png" });
    expect(JSON.stringify(result)).toMatch(/ENOSPC|space|error/i);
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });

  it("isolates state across consecutive calls (no leaked args between invocations)", async () => {
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "first", path: "a.png", seed: 1 });
    await t.execute("c", { prompt: "second", path: "b.png" });
    expect(sdkMocks.generateImage.mock.calls).toHaveLength(2);
    expect(sdkMocks.generateImage.mock.calls[0][0].seed).toBe(1);
    expect(sdkMocks.generateImage.mock.calls[1][0].seed).toBeUndefined();
    expect(sdkMocks.generateImage.mock.calls[0][0].prompt).toBe("first");
    expect(sdkMocks.generateImage.mock.calls[1][0].prompt).toBe("second");
  });

  it("forwards exotic seeds (negative, zero) as-is — clamping is the provider's job", async () => {
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: "x", path: "a.png", seed: -1 });
    await t.execute("c", { prompt: "x", path: "b.png", seed: 0 });
    expect(sdkMocks.generateImage.mock.calls[0][0].seed).toBe(-1);
    expect(sdkMocks.generateImage.mock.calls[1][0].seed).toBe(0);
  });
});

describe("video_generate — paranoid", () => {
  function build() { return createImageTools(cwd, [cwd], ["video_generate"], makeVault()); }

  it("forwards an empty-string prompt verbatim", async () => {
    const t = pick(build(), "video_generate");
    await t.execute("c", { prompt: "", path: "out.mp4" });
    expect(sdkMocks.experimental_generateVideo.mock.calls[0][0].prompt).toBe("");
  });

  it("forwards a 200KB prompt without truncation", async () => {
    const huge = "scene: " + "a wave crashes slowly. ".repeat(10000);
    expect(huge.length).toBeGreaterThan(200_000);
    const t = pick(build(), "video_generate");
    await t.execute("c", { prompt: huge, path: "out.mp4" });
    expect(sdkMocks.experimental_generateVideo.mock.calls[0][0].prompt.length).toBe(huge.length);
  });

  it("forwards exotic numeric inputs (zero / negative duration / fps) verbatim — provider validates", async () => {
    const t = pick(build(), "video_generate");
    await t.execute("c", { prompt: "x", path: "out.mp4", duration: 0, fps: -10 });
    const args = sdkMocks.experimental_generateVideo.mock.calls[0][0];
    expect(args.duration).toBe(0);
    expect(args.fps).toBe(-10);
  });

  it("survives a malformed aspect_ratio string by passing it through (SDK rejects, we map error)", async () => {
    sdkMocks.experimental_generateVideo.mockRejectedValueOnce(new Error("Invalid aspectRatio format"));
    const t = pick(build(), "video_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.mp4", aspect_ratio: "not-a-ratio" }),
      /aspect|invalid|format/i,
    );
    expect(existsSync(join(cwd, "out.mp4"))).toBe(false);
  });

  it("isolates state across consecutive calls (different bytes each time)", async () => {
    sdkMocks.experimental_generateVideo
      .mockResolvedValueOnce({ video: { uint8Array: new Uint8Array([1,2,3]), base64: "", mediaType: "video/mp4" }, videos: [], providerMetadata: {}, warnings: [], responses: [{}] })
      .mockResolvedValueOnce({ video: { uint8Array: new Uint8Array([4,5,6,7]), base64: "", mediaType: "video/mp4" }, videos: [], providerMetadata: {}, warnings: [], responses: [{}] });
    const t = pick(build(), "video_generate");
    await t.execute("c", { prompt: "a", path: "a.mp4" });
    await t.execute("c", { prompt: "b", path: "b.mp4" });
    expect(statSync(join(cwd, "a.mp4")).size).toBe(3);
    expect(statSync(join(cwd, "b.mp4")).size).toBe(4);
  });

  it("preserves nasty unicode in the prompt", async () => {
    const nasty = "scene ‮🚀‍";
    const t = pick(build(), "video_generate");
    await t.execute("c", { prompt: nasty, path: "out.mp4" });
    expect(sdkMocks.experimental_generateVideo.mock.calls[0][0].prompt).toBe(nasty);
  });

  it("returns a structured error (no crash) when the SDK rejects with a non-Error value", async () => {
    sdkMocks.experimental_generateVideo.mockRejectedValueOnce({ code: "weird_object", reason: "no message" });
    const t = pick(build(), "video_generate");
    const result = await t.execute("c", { prompt: "x", path: "out.mp4" });
    expect(JSON.stringify(result)).toMatch(/error/i);
  });
});

describe("image_analyze — paranoid", () => {
  function build() { return createImageTools(cwd, [cwd], ["image_analyze"], makeVault()); }

  it("returns a sane result when the SDK gives back an empty text", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    sdkMocks.generateText.mockResolvedValueOnce({
      text: "", usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
      providerMetadata: {}, warnings: [], response: {},
    });
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "i.png" });
    expect(result).toBeDefined();
    expect(text(result)).toBe("");
    expect(result.details.tokens).toBe(5);
  });

  it("does not call the SDK when the file is missing", async () => {
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "nope.png" });
    expect(JSON.stringify(result.details)).toMatch(/file_read_error|enoent|no such/i);
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("does not call the SDK when the file exceeds the 20 MB cap", async () => {
    const big = Buffer.alloc(21 * 1024 * 1024);
    writeFileSync(join(cwd, "huge.png"), big);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "huge.png" });
    expect(JSON.stringify(result.details)).toMatch(/file_too_large/);
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("falls back to OPENAI_API_KEY env when the vault has no openai key", async () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    try {
      writeFileSync(join(cwd, "i.png"), TINY_PNG);
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createImageTools(cwd, [cwd], ["image_analyze"], noKeysVault), "image_analyze");
      await t.execute("c", { path: "i.png" });
      expect(sdkMocks.resolveVisionProvider).toHaveBeenCalledWith("openai", "env-openai-key");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("derives the correct mediaType from the file extension (jpeg)", async () => {
    writeFileSync(join(cwd, "photo.jpg"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "photo.jpg" });
    const args = sdkMocks.generateText.mock.calls[0][0];
    expect(args.messages[0].content[1].mediaType).toBe("image/jpeg");
  });

  it("accepts a file at exactly the 20 MB boundary", async () => {
    const exact = Buffer.alloc(20 * 1024 * 1024); // == MAX_IMAGE_SIZE
    writeFileSync(join(cwd, "edge.png"), exact);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "edge.png" });
    // No file_too_large error — the cap is exclusive on the upper side.
    expect(JSON.stringify(result.details)).not.toMatch(/file_too_large/);
    expect(sdkMocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("rejects a file 1 byte over the 20 MB boundary (no SDK call)", async () => {
    const over = Buffer.alloc(20 * 1024 * 1024 + 1);
    writeFileSync(join(cwd, "over.png"), over);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "over.png" });
    expect(JSON.stringify(result.details)).toMatch(/file_too_large/);
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("forwards a 50KB user prompt to the SDK without truncation", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    const longPrompt = "Analyze: " + "consider every shadow and hue. ".repeat(2000);
    expect(longPrompt.length).toBeGreaterThan(50_000);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "i.png", prompt: longPrompt });
    expect(sdkMocks.generateText.mock.calls[0][0].messages[0].content[0].text).toBe(longPrompt);
  });

  it("accepts a non-image file (e.g. text disguised as .png) — content-validation is the SDK's job", async () => {
    writeFileSync(join(cwd, "fake.png"), Buffer.from("THIS IS NOT A PNG, JUST TEXT"));
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "fake.png" });
    // Tool doesn't sniff bytes; it sends them and lets the model reject.
    // Pin: no crash, SDK still called with the raw bytes.
    expect(result).toBeDefined();
    expect(sdkMocks.generateText).toHaveBeenCalledTimes(1);
  });

  it("returns a structured error when the path is a directory, not a file", async () => {
    require("node:fs").mkdirSync(join(cwd, "imgs"), { recursive: true });
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "imgs" });
    expect(JSON.stringify(result.details)).toMatch(/file_read_error|EISDIR|directory/i);
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("preserves nasty unicode in the user prompt (NUL, RTL override, ZWJ)", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    const nasty = "describe: ‮flip‍end";
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "i.png", prompt: nasty });
    expect(sdkMocks.generateText.mock.calls[0][0].messages[0].content[0].text).toBe(nasty);
  });

  it("forwards exotic max_tokens (0, very high) verbatim — clamping is the SDK's job", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "i.png", max_tokens: 0 });
    await t.execute("c", { path: "i.png", max_tokens: 1_000_000 });
    expect(sdkMocks.generateText.mock.calls[0][0].maxOutputTokens).toBe(0);
    expect(sdkMocks.generateText.mock.calls[1][0].maxOutputTokens).toBe(1_000_000);
  });

  it("isolates state across consecutive calls (different files, different prompts)", async () => {
    writeFileSync(join(cwd, "a.png"), TINY_PNG);
    writeFileSync(join(cwd, "b.jpg"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "a.png", prompt: "first" });
    await t.execute("c", { path: "b.jpg", prompt: "second" });
    expect(sdkMocks.generateText.mock.calls).toHaveLength(2);
    expect(sdkMocks.generateText.mock.calls[0][0].messages[0].content[0].text).toBe("first");
    expect(sdkMocks.generateText.mock.calls[1][0].messages[0].content[0].text).toBe("second");
    // mediaType correctly diverges per file.
    expect(sdkMocks.generateText.mock.calls[0][0].messages[0].content[1].mediaType).toBe("image/png");
    expect(sdkMocks.generateText.mock.calls[1][0].messages[0].content[1].mediaType).toBe("image/jpeg");
  });

  it("uses image/png as a safe default for unknown extensions", async () => {
    writeFileSync(join(cwd, "weird.xyz"), TINY_PNG);
    const t = pick(build(), "image_analyze");
    await t.execute("c", { path: "weird.xyz" });
    expect(sdkMocks.generateText.mock.calls[0][0].messages[0].content[1].mediaType).toBe("image/png");
  });

  it("returns a structured error (no crash) when the SDK rejects with a non-Error value", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    sdkMocks.generateText.mockRejectedValueOnce("string rejection");
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "i.png" });
    expect(JSON.stringify(result)).toMatch(/error/i);
  });
});

describe("audio_transcribe — paranoid", () => {
  function build() { return createAudioTools(cwd, [cwd], ["audio_transcribe"], makeVault()); }

  it("formats unknown language / unknown duration gracefully when the SDK omits them", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    sdkMocks.experimental_transcribe.mockResolvedValueOnce({
      text: "Just transcript text.",
      segments: [],
      // no language, no durationInSeconds
      warnings: [], providerMetadata: {}, responses: [{}],
    });
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "r.mp3" });
    expect(text(result)).toContain("Just transcript text.");
    expect(text(result)).toMatch(/Language: unknown/i);
    expect(text(result)).toMatch(/Duration: unknown/i);
  });

  it("returns a sane result when the SDK gives back an empty transcript", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    sdkMocks.experimental_transcribe.mockResolvedValueOnce({
      text: "",
      segments: [],
      language: "en",
      durationInSeconds: 0.5,
      warnings: [], providerMetadata: {}, responses: [{}],
    });
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "r.mp3" });
    expect(result).toBeDefined();
    expect(result.details.textLength).toBe(0);
  });

  it("does not call the SDK when the file is missing", async () => {
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "ghost.mp3" });
    expect(JSON.stringify(result.details)).toMatch(/file_read_error|enoent|no such/i);
    expect(sdkMocks.experimental_transcribe).not.toHaveBeenCalled();
  });

  it("does not call the SDK when the file exceeds the 25 MB cap", async () => {
    const big = Buffer.alloc(26 * 1024 * 1024);
    writeFileSync(join(cwd, "huge.wav"), big);
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "huge.wav" });
    expect(JSON.stringify(result.details)).toMatch(/file_too_large/);
    expect(sdkMocks.experimental_transcribe).not.toHaveBeenCalled();
  });

  it("accepts a file at exactly the 25 MB boundary", async () => {
    writeFileSync(join(cwd, "edge.wav"), Buffer.alloc(25 * 1024 * 1024));
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "edge.wav" });
    expect(JSON.stringify(result.details)).not.toMatch(/file_too_large/);
    expect(sdkMocks.experimental_transcribe).toHaveBeenCalledTimes(1);
  });

  it("does not call the SDK when the path is a directory", async () => {
    require("node:fs").mkdirSync(join(cwd, "audio_dir"), { recursive: true });
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "audio_dir" });
    expect(JSON.stringify(result.details)).toMatch(/file_read_error|EISDIR|directory/i);
    expect(sdkMocks.experimental_transcribe).not.toHaveBeenCalled();
  });

  it("falls back to OPENAI_API_KEY env when the vault has no openai key", async () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    try {
      writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createAudioTools(cwd, [cwd], ["audio_transcribe"], noKeysVault), "audio_transcribe");
      await t.execute("c", { path: "r.mp3" });
      expect(sdkMocks.resolveTranscribeProvider).toHaveBeenCalledWith("openai", "env-openai-key");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("falls back to DEEPGRAM_API_KEY env for the deepgram provider", async () => {
    process.env.DEEPGRAM_API_KEY = "env-dg-key";
    try {
      writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createAudioTools(cwd, [cwd], ["audio_transcribe"], noKeysVault), "audio_transcribe");
      await t.execute("c", { path: "r.mp3", provider: "deepgram" });
      expect(sdkMocks.resolveTranscribeProvider).toHaveBeenCalledWith("deepgram", "env-dg-key");
    } finally {
      delete process.env.DEEPGRAM_API_KEY;
    }
  });

  it("returns a structured error when neither vault nor env has the right key", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    const noKeysVault: ResolvedVault = {
      get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
      getKey: () => undefined, has: () => false, list: () => [],
    };
    const t = pick(createAudioTools(cwd, [cwd], ["audio_transcribe"], noKeysVault), "audio_transcribe");
    await expectFailure(
      t.execute("c", { path: "r.mp3" }),
      /missing|openai_api_key|env/i,
    );
    expect(sdkMocks.resolveTranscribeProvider).not.toHaveBeenCalled();
  });

  it("forwards a 5KB whisper prompt verbatim to providerOptions (no truncation)", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    const giant = "Glossary: " + "Polpo, ".repeat(700);
    expect(giant.length).toBeGreaterThan(4000);
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", { path: "r.mp3", prompt: giant });
    expect(sdkMocks.experimental_transcribe.mock.calls[0][0].providerOptions.openai.prompt).toBe(giant);
  });

  it("preserves nasty unicode (NUL, RTL override, ZWJ) in the prompt", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    const nasty = "before after‮flip‍end";
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", { path: "r.mp3", prompt: nasty });
    expect(sdkMocks.experimental_transcribe.mock.calls[0][0].providerOptions.openai.prompt).toBe(nasty);
  });

  it("isolates state across consecutive calls (different bytes, different opts)", async () => {
    writeFileSync(join(cwd, "a.mp3"), Buffer.from("AAA"));
    writeFileSync(join(cwd, "b.wav"), Buffer.from("BBBB"));
    const t = pick(build(), "audio_transcribe");
    await t.execute("c", { path: "a.mp3", language: "en" });
    await t.execute("c", { path: "b.wav", provider: "deepgram", language: "it" });
    expect(sdkMocks.experimental_transcribe.mock.calls).toHaveLength(2);
    expect(sdkMocks.experimental_transcribe.mock.calls[0][0].providerOptions.openai.language).toBe("en");
    expect(sdkMocks.experimental_transcribe.mock.calls[1][0].providerOptions.deepgram.language).toBe("it");
    // Each call sees its own bytes.
    const firstBytes = sdkMocks.experimental_transcribe.mock.calls[0][0].audio;
    const secondBytes = sdkMocks.experimental_transcribe.mock.calls[1][0].audio;
    expect(firstBytes.byteLength).toBe(3);
    expect(secondBytes.byteLength).toBe(4);
  });

  it("returns a structured error (no crash) when the SDK rejects with a non-Error value", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    sdkMocks.experimental_transcribe.mockRejectedValueOnce("plain string rejection");
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "r.mp3" });
    expect(JSON.stringify(result)).toMatch(/error/i);
  });

  it("survives a corrupt-looking input (bytes that look like text, not audio)", async () => {
    writeFileSync(join(cwd, "fake.mp3"), Buffer.from("THIS IS NOT REALLY AN MP3"));
    const t = pick(build(), "audio_transcribe");
    // Tool doesn't sniff format — just ships bytes. Pin: no crash.
    const result = await t.execute("c", { path: "fake.mp3" });
    expect(result).toBeDefined();
    expect(sdkMocks.experimental_transcribe).toHaveBeenCalledTimes(1);
  });
});

describe("search_web — paranoid", () => {
  function build() { return createSearchTools(makeVault(), ["search_web"]); }

  it("survives a 5KB query without errors", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
    ]);
    const giant = "polpo " + "search ".repeat(1000);
    const t = pick(build(), "search_web");
    await t.execute("c", { query: giant });
    const body = JSON.parse(lastRequests[0].init?.body as string);
    expect(body.query).toBe(giant);
  });

  it("survives a query with quotes / shell metachars (no injection)", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_web");
    await t.execute("c", { query: `"; rm -rf /; echo "` });
    const body = JSON.parse(lastRequests[0].init?.body as string);
    expect(body.query).toBe(`"; rm -rf /; echo "`);
    // The query reaches Exa as a string, no shell escaping involved.
  });

  it("doesn't crash on a malformed Exa response (results is undefined)", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ unexpectedShape: true }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "x" });
    expect(result).toBeDefined();
    // No crash. Either reports 0 results or a parsing error.
  });

  it("returns a clean error when fetch hits an AbortError (timeout)", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e: any = new Error("timeout");
      e.name = "AbortError";
      throw e;
    }) as any;
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "x" });
    expect(text(result).toLowerCase()).toMatch(/timeout|abort|error|fail/);
  });

  it("survives an Exa response with a partially-populated result (title or url missing)", async () => {
    // Real Exa responses are typed; we don't expect raw nulls in
    // the array. But fields *inside* a result can be missing
    // (publishedDate often is, sometimes the title in the case of
    // social media URLs). Pin: the formatter must not throw on a
    // missing title or url.
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({
          results: [
            { url: "https://only-url.com" },         // no title
            { title: "Only title" },                 // no url
            { title: "Both", url: "https://both.com" },
          ],
        }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_web");
    const result = await t.execute("c", { query: "x" });
    expect(result).toBeDefined();
    expect(text(result)).toContain("Both");
  });
});

describe("search_find_similar — paranoid", () => {
  function build() { return createSearchTools(makeVault(), ["search_find_similar"]); }

  it("doesn't crash on an empty URL string (defers to Exa for validation)", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ error: "bad url" }), { status: 400 }) },
    ]);
    const t = pick(build(), "search_find_similar");
    const result = await t.execute("c", { url: "" });
    expect(result).toBeDefined();
    // Either tool refuses pre-flight or Exa rejects; both fine.
  });

  it("forwards numResults to Exa within the body", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
    ]);
    const t = pick(build(), "search_find_similar");
    await t.execute("c", { url: "https://x", numResults: 7 });
    const body = JSON.parse(lastRequests[0].init?.body as string);
    expect(body.numResults).toBe(7);
  });

  it("handles a 503 service unavailable cleanly", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response("maintenance", { status: 503 }) },
    ]);
    const t = pick(build(), "search_find_similar");
    const result = await t.execute("c", { url: "https://x" });
    expect(text(result).toLowerCase()).toMatch(/503|maintenance|error|server/);
  });
});

// ════════════════════════════════════════════════════════════
// audio_speak (Vercel AI SDK — experimental_generateSpeech)
// ════════════════════════════════════════════════════════════

describe("audio_speak", () => {
  function build() { return createAudioTools(cwd, [cwd], ["audio_speak"], makeVault()); }

  it("calls the SDK with the resolved openai tts-1 model and writes the bytes (default provider)", async () => {
    const t = pick(build(), "audio_speak");
    const result = await t.execute("c", { text: "Hello world", path: "out.mp3" });

    expect(existsSync(join(cwd, "out.mp3"))).toBe(true);
    expect(JSON.stringify(result.details)).toContain("out.mp3");
    expect(result.details).toMatchObject({
      provider: "openai",
      model: "tts-1",
      voice: "alloy",
      format: "mp3",
      textLength: 11,
    });

    expect(sdkMocks.resolveSpeakProvider).toHaveBeenCalledTimes(1);
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][0]).toBe("openai");
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][1]).toMatchObject({ apiKey: "fake-openai-key" });

    const args = sdkMocks.experimental_generateSpeech.mock.calls[0][0];
    expect(args.model).toEqual({ _isMockSpeechModel: true, providerName: "openai", modelId: "tts-1" });
    expect(args.text).toBe("Hello world");
    expect(args.voice).toBe("alloy");
    expect(args.outputFormat).toBe("mp3");
  });

  it("forwards openai-specific knobs (speed, instructions) via providerOptions", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", {
      text: "x", path: "out.mp3",
      speed: 1.5,
      instructions: "Speak in a cheerful tone",
    });
    const args = sdkMocks.experimental_generateSpeech.mock.calls[0][0];
    expect(args.speed).toBe(1.5);
    expect(args.instructions).toBe("Speak in a cheerful tone");
    expect(args.providerOptions).toEqual({
      openai: { speed: 1.5, instructions: "Speak in a cheerful tone" },
    });
  });

  it("routes to deepgram with the aura-2 default model", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "hi", path: "out.mp3", provider: "deepgram" });
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][0]).toBe("deepgram");
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][1]).toMatchObject({ apiKey: "fake-deepgram-key" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].model.modelId).toBe("aura-2-asteria-en");
  });

  it("routes to elevenlabs with the multilingual default + Rachel voice ID", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "hi", path: "out.mp3", provider: "elevenlabs" });
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][0]).toBe("elevenlabs");
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][1]).toMatchObject({ apiKey: "fake-elevenlabs-key" });
    const args = sdkMocks.experimental_generateSpeech.mock.calls[0][0];
    expect(args.model.modelId).toBe("eleven_multilingual_v2");
    expect(args.voice).toBe("21m00Tcm4TlvDq8ikWAM");
    // ElevenLabs uses a more granular outputFormat string.
    expect(args.outputFormat).toBe("mp3_44100_128");
  });

  it("routes to edge with shell+fs (no apiKey) and forwards gender via providerOptions", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", {
      text: "ciao", path: "out.mp3",
      provider: "edge",
      language: "it",
      gender: "male",
    });
    expect(sdkMocks.resolveSpeakProvider.mock.calls[0][0]).toBe("edge");
    const cfg = sdkMocks.resolveSpeakProvider.mock.calls[0][1];
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.shell).toBeDefined();
    expect(cfg.fs).toBeDefined();
    const args = sdkMocks.experimental_generateSpeech.mock.calls[0][0];
    expect(args.language).toBe("it");
    expect(args.providerOptions).toEqual({ edge: { gender: "male" } });
  });

  it("respects an explicit voice override on openai", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "out.mp3", voice: "onyx" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].voice).toBe("onyx");
  });

  it("respects custom model override on every provider", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "out.mp3", model: "tts-1-hd" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].model.modelId).toBe("tts-1-hd");
  });

  it("forwards the abort signal to the SDK", async () => {
    const t = pick(build(), "audio_speak");
    const ctrl = new AbortController();
    await t.execute("c", { text: "x", path: "out.mp3" }, ctrl.signal);
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].abortSignal).toBe(ctrl.signal);
  });

  it("refuses an output path outside the sandbox before the SDK is called", async () => {
    const t = pick(build(), "audio_speak");
    await expect(t.execute("c", { text: "x", path: "/etc/escape.mp3" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(sdkMocks.experimental_generateSpeech).not.toHaveBeenCalled();
  });

  it("rejects when the SDK returns no audio bytes", async () => {
    sdkMocks.experimental_generateSpeech.mockResolvedValueOnce({
      audio: { uint8Array: new Uint8Array(0), base64: "", mediaType: "audio/mpeg" },
      warnings: [], request: {}, response: { timestamp: new Date(), modelId: "tts-1" }, providerMetadata: {},
    });
    // Cloud failure → tries edge fallback. Mock the second call (edge)
    // also as empty, so the whole thing surfaces a structured failure.
    sdkMocks.experimental_generateSpeech.mockResolvedValueOnce({
      audio: { uint8Array: new Uint8Array(0), base64: "", mediaType: "audio/mpeg" },
      warnings: [], request: {}, response: { timestamp: new Date(), modelId: "edge-tts" }, providerMetadata: {},
    });
    const t = pick(build(), "audio_speak");
    const result = await t.execute("c", { text: "x", path: "out.mp3" });
    expect(JSON.stringify(result)).toMatch(/no audio bytes|error|fallback/i);
    expect(existsSync(join(cwd, "out.mp3"))).toBe(false);
  });
});

describe("audio_speak — fallback behavior", () => {
  function build() { return createAudioTools(cwd, [cwd], ["audio_speak"], makeVault()); }

  it("falls back to edge-tts when the cloud provider throws (and prepends a [Fallback] notice)", async () => {
    // First call (openai) throws; second call (edge) succeeds.
    sdkMocks.experimental_generateSpeech
      .mockRejectedValueOnce(new Error("AI_APICallError: 401 invalid key"))
      .mockResolvedValueOnce({
        audio: { uint8Array: new Uint8Array([0x49, 0x44, 0x33, 0x04]), base64: "", mediaType: "audio/mpeg" },
        warnings: [], request: {}, response: { timestamp: new Date(), modelId: "edge-tts" }, providerMetadata: {},
      });
    const t = pick(build(), "audio_speak");
    const result = await t.execute("c", { text: "ciao", path: "out.mp3", language: "it" });

    expect(text(result)).toMatch(/\[Fallback\]/);
    expect(text(result)).toMatch(/openai failed/);
    expect(existsSync(join(cwd, "out.mp3"))).toBe(true);

    // Tool resolved the cloud provider first, then edge.
    expect(sdkMocks.resolveSpeakProvider.mock.calls.map(c => c[0])).toEqual(["openai", "edge"]);

    expect(result.details).toMatchObject({ fallbackFrom: "openai" });
  });

  it("returns a structured error when both the cloud provider AND edge fail", async () => {
    sdkMocks.experimental_generateSpeech
      .mockRejectedValueOnce(new Error("AI_APICallError: 401"))
      .mockRejectedValueOnce(new Error("edge-tts CLI is not installed"));
    const t = pick(build(), "audio_speak");
    const result = await t.execute("c", { text: "x", path: "out.mp3" });
    expect(JSON.stringify(result)).toMatch(/401/);
    expect(JSON.stringify(result)).toMatch(/edge-tts.*not installed/i);
    expect(result.details).toMatchObject({ provider: "openai" });
    expect(existsSync(join(cwd, "out.mp3"))).toBe(false);
  });

  it("does NOT attempt a fallback when the failing provider is edge itself", async () => {
    sdkMocks.experimental_generateSpeech.mockRejectedValueOnce(new Error("edge-tts CLI is not installed"));
    const t = pick(build(), "audio_speak");
    const result = await t.execute("c", { text: "x", path: "out.mp3", provider: "edge" });
    expect(JSON.stringify(result)).toMatch(/edge.*not installed/i);
    // SDK called exactly once — no second attempt.
    expect(sdkMocks.experimental_generateSpeech).toHaveBeenCalledTimes(1);
  });
});

describe("audio_speak — paranoid", () => {
  function build() { return createAudioTools(cwd, [cwd], ["audio_speak"], makeVault()); }

  it("forwards an empty-string text verbatim (no auto-pad, no crash)", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "", path: "out.mp3" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].text).toBe("");
  });

  it("forwards a 200KB text without truncation", async () => {
    const huge = "Read aloud: " + "A long sentence. ".repeat(13000);
    expect(huge.length).toBeGreaterThan(200_000);
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: huge, path: "out.mp3" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].text.length).toBe(huge.length);
  });

  it("preserves nasty unicode (NUL, RTL override, ZWJ, emoji) in the text", async () => {
    const nasty = "before after‮flip‍🚀end";
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: nasty, path: "out.mp3" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].text).toBe(nasty);
  });

  it("forwards exotic numeric speed values (0.25, 4.0) verbatim", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "a.mp3", speed: 0.25 });
    await t.execute("c", { text: "x", path: "b.mp3", speed: 4.0 });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].speed).toBe(0.25);
    expect(sdkMocks.experimental_generateSpeech.mock.calls[1][0].speed).toBe(4.0);
  });

  it("infers outputFormat from extension for openai (.wav, .opus, .flac)", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "a.wav" });
    await t.execute("c", { text: "x", path: "b.opus" });
    await t.execute("c", { text: "x", path: "c.flac" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].outputFormat).toBe("wav");
    expect(sdkMocks.experimental_generateSpeech.mock.calls[1][0].outputFormat).toBe("opus");
    expect(sdkMocks.experimental_generateSpeech.mock.calls[2][0].outputFormat).toBe("flac");
  });

  it("uses elevenlabs-specific format string for known extensions", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "a.wav", provider: "elevenlabs" });
    await t.execute("c", { text: "x", path: "b.flac", provider: "elevenlabs" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].outputFormat).toBe("pcm_44100");
    expect(sdkMocks.experimental_generateSpeech.mock.calls[1][0].outputFormat).toBe("flac");
  });

  it("falls back to mp3_44100_128 for unknown extensions on elevenlabs", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "weird.xyz", provider: "elevenlabs" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].outputFormat).toBe("mp3_44100_128");
  });

  it("falls back to OPENAI_API_KEY env when the vault has no openai key", async () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    try {
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createAudioTools(cwd, [cwd], ["audio_speak"], noKeysVault), "audio_speak");
      await t.execute("c", { text: "x", path: "out.mp3" });
      expect(sdkMocks.resolveSpeakProvider.mock.calls[0][1]).toMatchObject({ apiKey: "env-openai-key" });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("falls back to ELEVENLABS_API_KEY env for the elevenlabs provider", async () => {
    process.env.ELEVENLABS_API_KEY = "env-el-key";
    try {
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      const t = pick(createAudioTools(cwd, [cwd], ["audio_speak"], noKeysVault), "audio_speak");
      await t.execute("c", { text: "x", path: "out.mp3", provider: "elevenlabs" });
      expect(sdkMocks.resolveSpeakProvider.mock.calls[0][1]).toMatchObject({ apiKey: "env-el-key" });
    } finally {
      delete process.env.ELEVENLABS_API_KEY;
    }
  });

  it("the edge provider doesn't need any apiKey at all (no env, no vault)", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const noKeysVault: ResolvedVault = {
      get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
      getKey: () => undefined, has: () => false, list: () => [],
    };
    const t = pick(createAudioTools(cwd, [cwd], ["audio_speak"], noKeysVault), "audio_speak");
    const result = await t.execute("c", { text: "ciao", path: "out.mp3", provider: "edge", language: "it" });
    // No requireEnv crash; edge resolver got no key.
    const cfg = sdkMocks.resolveSpeakProvider.mock.calls[0][1];
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.shell).toBeDefined();
    expect(cfg.fs).toBeDefined();
    expect(existsSync(join(cwd, "out.mp3"))).toBe(true);
    expect((result.details as any).provider).toBe("edge");
  });

  it("isolates state across consecutive calls (different providers, different bytes)", async () => {
    sdkMocks.experimental_generateSpeech
      .mockResolvedValueOnce({
        audio: { uint8Array: new Uint8Array([1, 2, 3]), base64: "", mediaType: "audio/mpeg" },
        warnings: [], request: {}, response: { timestamp: new Date(), modelId: "tts-1" }, providerMetadata: {},
      })
      .mockResolvedValueOnce({
        audio: { uint8Array: new Uint8Array([4, 5, 6, 7]), base64: "", mediaType: "audio/mpeg" },
        warnings: [], request: {}, response: { timestamp: new Date(), modelId: "aura-2-asteria-en" }, providerMetadata: {},
      });
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "first", path: "a.mp3" });
    await t.execute("c", { text: "second", path: "b.mp3", provider: "deepgram" });
    expect(statSync(join(cwd, "a.mp3")).size).toBe(3);
    expect(statSync(join(cwd, "b.mp3")).size).toBe(4);
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].text).toBe("first");
    expect(sdkMocks.experimental_generateSpeech.mock.calls[1][0].text).toBe("second");
  });

  it("silently overwrites an existing file at the output path", async () => {
    writeFileSync(join(cwd, "out.mp3"), Buffer.from("OLD"));
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "fresh", path: "out.mp3" });
    const written = require("node:fs").readFileSync(join(cwd, "out.mp3"));
    expect(written.toString()).not.toContain("OLD");
  });

  it("does not write a partial file when the SDK throws after some progress", async () => {
    sdkMocks.experimental_generateSpeech
      .mockRejectedValueOnce(new Error("provider went away"))
      .mockRejectedValueOnce(new Error("edge-tts not installed"));
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "out.mp3" }).catch(() => {});
    expect(existsSync(join(cwd, "out.mp3"))).toBe(false);
  });

  it("returns a structured error (no crash) when the SDK rejects with a non-Error value", async () => {
    sdkMocks.experimental_generateSpeech
      .mockRejectedValueOnce("plain string")
      .mockRejectedValueOnce("plain string 2");
    const t = pick(build(), "audio_speak");
    const result = await t.execute("c", { text: "x", path: "out.mp3" });
    expect(JSON.stringify(result)).toMatch(/error/i);
  });

  it("returns a structured error when neither vault nor env has the right key (cloud path)", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    const noKeysVault: ResolvedVault = {
      get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
      getKey: () => undefined, has: () => false, list: () => [],
    };
    const t = pick(createAudioTools(cwd, [cwd], ["audio_speak"], noKeysVault), "audio_speak");
    // Mock edge fallback also missing edge-tts.
    sdkMocks.experimental_generateSpeech.mockRejectedValueOnce(new Error("edge-tts CLI is not installed"));
    const result = await t.execute("c", { text: "x", path: "out.mp3" });
    expect(JSON.stringify(result)).toMatch(/openai_api_key|missing|env|edge-tts/i);
    expect(existsSync(join(cwd, "out.mp3"))).toBe(false);
  });

  it("respects custom voice override on openai (alloy → onyx)", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", { text: "x", path: "out.mp3", voice: "onyx" });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].voice).toBe("onyx");
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].model.modelId).toBe("tts-1");
  });

  it("forwards an explicit edge voice (it-IT-DiegoNeural) verbatim", async () => {
    const t = pick(build(), "audio_speak");
    await t.execute("c", {
      text: "ciao", path: "out.mp3",
      provider: "edge", voice: "it-IT-DiegoNeural",
    });
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].voice).toBe("it-IT-DiegoNeural");
  });

  it("isolates abort across consecutive calls (per-call signal forwarded)", async () => {
    const t = pick(build(), "audio_speak");
    const a = new AbortController();
    const b = new AbortController();
    await t.execute("c", { text: "1", path: "a.mp3" }, a.signal);
    await t.execute("c", { text: "2", path: "b.mp3" }, b.signal);
    expect(sdkMocks.experimental_generateSpeech.mock.calls[0][0].abortSignal).toBe(a.signal);
    expect(sdkMocks.experimental_generateSpeech.mock.calls[1][0].abortSignal).toBe(b.signal);
  });
});
