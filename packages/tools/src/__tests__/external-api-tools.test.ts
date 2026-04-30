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
}));

vi.mock("../lib/provider-resolver.js", () => ({
  resolveImageProvider: sdkMocks.resolveImageProvider,
  resolveVideoProvider: sdkMocks.resolveVideoProvider,
  resolveVisionProvider: sdkMocks.resolveVisionProvider,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateImage: sdkMocks.generateImage,
    experimental_generateVideo: sdkMocks.experimental_generateVideo,
    generateText: sdkMocks.generateText,
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
    "fal-ai":   { key: "fake-fal-key" },
    openai:     { key: "fake-openai-key" },
    anthropic:  { key: "fake-anthropic-key" },
    exa:        { key: "fake-exa-key" },
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
// audio_transcribe (OpenAI Whisper)
// ────────────────────────────────────────────────────────────
describe("audio_transcribe", () => {
  function build() {
    return createAudioTools(cwd, [cwd], ["audio_transcribe"], makeVault());
  }

  it("uploads the audio and returns the transcript text", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00audio"));
    routeFetch([
      { match: (u) => u.includes("api.openai.com/v1/audio/transcriptions"),
        response: () => new Response(JSON.stringify({
          text: "Hello world, this is a test.",
          language: "en",
          duration: 3.4,
        }), { status: 200 }) },
    ]);
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "rec.mp3" });
    expect(text(result)).toContain("Hello world");
    expect(text(result)).toMatch(/Language: en/i);
  });

  it("surfaces a 500 from OpenAI as a clear failure", async () => {
    writeFileSync(join(cwd, "rec.mp3"), Buffer.from("data"));
    routeFetch([
      { match: () => true,
        response: () => new Response("server error", { status: 500 }) },
    ]);
    const t = pick(build(), "audio_transcribe");
    await expectFailure(t.execute("c", { path: "rec.mp3" }), /500|server|openai|error/i);
  });

  it("rejects an audio path outside the sandbox", async () => {
    routeFetch([{ match: () => true, response: () => { throw new Error("network reached"); } }]);
    const t = pick(build(), "audio_transcribe");
    await expect(t.execute("c", { path: "/etc/hostname" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(lastRequests.length).toBe(0);
  });

  it("surfaces a missing audio file as a clear failure", async () => {
    routeFetch([{ match: () => true, response: () => { throw new Error("network reached"); } }]);
    const t = pick(build(), "audio_transcribe");
    await expectFailure(t.execute("c", { path: "ghost.mp3" }), /not found|missing|enoent|no such/i);
    expect(lastRequests.length).toBe(0);
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
});

describe("audio_transcribe — paranoid", () => {
  function build() { return createAudioTools(cwd, [cwd], ["audio_transcribe"], makeVault()); }

  it("handles an API response with no language field", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ text: "Just transcript text." }), { status: 200 }) },
    ]);
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "r.mp3" });
    expect(text(result)).toContain("transcript");
    // Empty/unknown language must not break formatting.
    expect(text(result)).toMatch(/Language: (unknown|—|n\/a|)/i);
  });

  it("handles an API response with empty transcript text", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ text: "", language: "en" }), { status: 200 }) },
    ]);
    const t = pick(build(), "audio_transcribe");
    const result = await t.execute("c", { path: "r.mp3" });
    expect(result).toBeDefined();
    // Pin "no crash; result is parseable even when transcript is empty".
  });

  it("rejects when fetch times out (AbortError)", async () => {
    writeFileSync(join(cwd, "r.mp3"), Buffer.from("data"));
    globalThis.fetch = vi.fn(async () => {
      const e: any = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as any;
    const t = pick(build(), "audio_transcribe");
    await expectFailure(t.execute("c", { path: "r.mp3" }), /abort|timeout|fail|error/i);
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
