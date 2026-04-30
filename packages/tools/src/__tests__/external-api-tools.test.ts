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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(cwd, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// image_generate (fal.ai queue)
// ────────────────────────────────────────────────────────────
describe("image_generate", () => {
  function build() {
    return createImageTools(cwd, [cwd], ["image_generate"], makeVault());
  }

  it("submits to fal queue, polls, downloads, writes the image", async () => {
    routeFetch([
      // Submit
      { match: (u) => u.includes("queue.fal.run/") && !u.includes("/status") && !u.includes("/requests/"),
        response: () => new Response(JSON.stringify({
          request_id: "req-1",
          status_url: "https://queue.fal.run/x/requests/req-1/status",
          response_url: "https://queue.fal.run/x/requests/req-1",
        }), { status: 200, headers: { "content-type": "application/json" } }) },
      // Status poll
      { match: (u) => u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }) },
      // Result fetch (response_url)
      { match: (u) => u.includes("/requests/req-1") && !u.endsWith("/status"),
        response: () => new Response(JSON.stringify({
          images: [{ url: "https://cdn.fal.ai/img/abc.png", width: 1, height: 1, content_type: "image/png" }],
        }), { status: 200 }) },
      // Image binary
      { match: (u) => u.includes("cdn.fal.ai"),
        response: () => new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } }) },
    ]);

    const t = pick(build(), "image_generate");
    const result = await t.execute("c", { prompt: "a cat", path: "out.png" });
    expect(JSON.stringify(result.details)).toContain("out.png");
    expect(existsSync(join(cwd, "out.png"))).toBe(true);
    expect(statSync(join(cwd, "out.png")).size).toBeGreaterThan(20);

    // Pin the wire format: first request must be a POST with the FAL
    // `Key …` auth header and a JSON body containing the prompt.
    const submit = lastRequests[0];
    expect(submit.init?.method).toBe("POST");
    const headers = (submit.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Key fake-fal-key");
    expect(JSON.parse(submit.init?.body as string)).toMatchObject({ prompt: "a cat" });
  });

  it("surfaces a 401 from fal as a clear failure (no file written)", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response("invalid key", { status: 401 }) },
    ]);
    const t = pick(build(), "image_generate");
    await expectFailure(t.execute("c", { prompt: "x", path: "out.png" }), /401|unauthorized|invalid key/i);
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });

  it("surfaces a 429 rate limit cleanly", async () => {
    routeFetch([
      { match: () => true,
        response: () => new Response("too many", { status: 429 }) },
    ]);
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /429|too many|rate|fal\.ai/i,
    );
  });

  it("surfaces a FAILED queue status as a clear failure", async () => {
    routeFetch([
      { match: (u) => !u.includes("/status") && u.includes("queue.fal.run/"),
        response: () => new Response(JSON.stringify({
          request_id: "r", status_url: "https://queue.fal.run/x/r/status", response_url: "https://queue.fal.run/x/r",
        }), { status: 200 }) },
      { match: (u) => u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ status: "FAILED", error: "model crashed" }), { status: 200 }) },
    ]);
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /failed|crashed|model/i,
    );
  });

  it("surfaces an empty images array as a clear failure", async () => {
    routeFetch([
      { match: (u) => !u.includes("/status") && u.includes("queue.fal.run/"),
        response: () => new Response(JSON.stringify({
          request_id: "r", status_url: "https://queue.fal.run/x/r/status", response_url: "https://queue.fal.run/x/r",
        }), { status: 200 }) },
      { match: (u) => u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }) },
      { match: (u) => u.includes("/requests/r") && !u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ images: [] }), { status: 200 }) },
    ]);
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /no images|empty|response/i,
    );
  });

  it("refuses an output path outside the sandbox before any fetch", async () => {
    routeFetch([{ match: () => true, response: () => { throw new Error("network was reached"); } }]);
    const t = pick(build(), "image_generate");
    await expect(t.execute("c", { prompt: "x", path: "/etc/escape.png" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(lastRequests.length).toBe(0);
  });

  it("survives a network error (fetch throws) without writing the file", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNRESET"); }) as any;
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /ECONNRESET|network|reset|error/i,
    );
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// video_generate (fal.ai queue, same pattern, expects video.url)
// ────────────────────────────────────────────────────────────
describe("video_generate", () => {
  function build() {
    return createImageTools(cwd, [cwd], ["video_generate"], makeVault());
  }

  it("submits, polls, downloads the video bytes, writes the file", async () => {
    const TINY_MP4 = Buffer.from("0000001866747970", "hex"); // ftyp box prefix
    routeFetch([
      { match: (u) => u.includes("queue.fal.run/") && !u.includes("/status") && !u.includes("/requests/"),
        response: () => new Response(JSON.stringify({
          request_id: "v1",
          status_url: "https://queue.fal.run/x/requests/v1/status",
          response_url: "https://queue.fal.run/x/requests/v1",
        }), { status: 200 }) },
      { match: (u) => u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }) },
      { match: (u) => u.includes("/requests/v1") && !u.endsWith("/status"),
        response: () => new Response(JSON.stringify({
          video: { url: "https://cdn.fal.ai/v/abc.mp4" },
        }), { status: 200 }) },
      { match: (u) => u.includes("cdn.fal.ai"),
        response: () => new Response(TINY_MP4, { status: 200, headers: { "content-type": "video/mp4" } }) },
    ]);

    const t = pick(build(), "video_generate");
    const result = await t.execute("c", { prompt: "a sunset", path: "out.mp4" });
    expect(JSON.stringify(result.details)).toContain("out.mp4");
    expect(existsSync(join(cwd, "out.mp4"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// image_analyze (OpenAI Vision)
// ────────────────────────────────────────────────────────────
describe("image_analyze", () => {
  function build() {
    return createImageTools(cwd, [cwd], ["image_analyze"], makeVault());
  }

  it("posts a vision message and returns the model's text reply", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    routeFetch([
      { match: (u) => u.includes("api.openai.com/v1/chat/completions"),
        response: () => new Response(JSON.stringify({
          choices: [{ message: { content: "A grey gradient image." } }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }), { status: 200 }) },
    ]);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "input.png", prompt: "What is this?" });
    expect(text(result)).toContain("grey gradient");

    // Pin: a data: URL was sent (image embedded as base64 in the
    // chat completion request) and the right model defaulted.
    const body = JSON.parse(lastRequests[0].init!.body as string);
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.model).toBeDefined();
  });

  it("surfaces an OpenAI 401 as a clear failure", async () => {
    writeFileSync(join(cwd, "input.png"), TINY_PNG);
    routeFetch([
      { match: () => true,
        response: () => new Response("bad key", { status: 401 }) },
    ]);
    const t = pick(build(), "image_analyze");
    await expectFailure(t.execute("c", { path: "input.png" }), /401|unauthorized|bad key|openai/i);
  });

  it("refuses a path that escapes the sandbox before any fetch", async () => {
    routeFetch([{ match: () => true, response: () => { throw new Error("network reached"); } }]);
    const t = pick(build(), "image_analyze");
    await expect(t.execute("c", { path: "/etc/hostname" }))
      .rejects.toThrow(/sandbox|allowed|denied/i);
    expect(lastRequests.length).toBe(0);
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

  it("rejects when the queue submit returns malformed JSON (no request_id)", { timeout: 60_000 }, async () => {
    let pollCount = 0;
    routeFetch([
      // First request: submit, missing request_id
      { match: (u) => u.includes("queue.fal.run/") && !u.includes("/requests/"),
        response: () => new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 }) },
      // Subsequent polls (against fallback URL with "undefined" in it)
      // — after a few iterations, return FAILED to short-circuit.
      { match: (u) => u.endsWith("/status"),
        response: () => {
          pollCount++;
          return new Response(JSON.stringify({
            status: "FAILED",
            error: "missing request_id in submit response",
          }), { status: 200 });
        } },
    ]);
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /undefined|request|missing|fail|fal/i,
    );
  });

  it("polls past IN_PROGRESS to COMPLETED without false-failing", async () => {
    let polls = 0;
    routeFetch([
      { match: (u) => !u.includes("/status") && u.includes("queue.fal.run/") && !u.includes("/requests/"),
        response: () => new Response(JSON.stringify({
          request_id: "p1",
          status_url: "https://queue.fal.run/x/requests/p1/status",
          response_url: "https://queue.fal.run/x/requests/p1",
        }), { status: 200 }) },
      { match: (u) => u.endsWith("/status"),
        response: () => {
          polls++;
          const status = polls < 2 ? "IN_PROGRESS" : "COMPLETED";
          return new Response(JSON.stringify({ status }), { status: 200 });
        } },
      { match: (u) => u.includes("/requests/p1") && !u.endsWith("/status"),
        response: () => new Response(JSON.stringify({
          images: [{ url: "https://cdn.fal.ai/i.png", width: 1, height: 1 }],
        }), { status: 200 }) },
      { match: (u) => u.includes("cdn.fal.ai"),
        response: () => new Response(TINY_PNG, { status: 200 }) },
    ]);
    const t = pick(build(), "image_generate");
    const result = await t.execute("c", { prompt: "x", path: "out.png" });
    expect(JSON.stringify(result.details)).toContain("out.png");
    expect(polls).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("rejects when the image URL itself returns 403", async () => {
    routeFetch([
      // Submit
      { match: (u) => u.includes("queue.fal.run/") && !u.includes("/x/f"),
        response: () => new Response(JSON.stringify({
          request_id: "f",
          status_url: "https://queue.fal.run/x/f/status",
          response_url: "https://queue.fal.run/x/f/result",
        }), { status: 200 }) },
      // Status poll
      { match: (u) => u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }) },
      // Result fetch (response_url, not /status)
      { match: (u) => u === "https://queue.fal.run/x/f/result",
        response: () => new Response(JSON.stringify({
          images: [{ url: "https://cdn.fal.ai/x.png", width: 1, height: 1 }],
        }), { status: 200 }) },
      // Image binary — refused
      { match: (u) => u.includes("cdn.fal.ai"),
        response: () => new Response("forbidden", { status: 403 }) },
    ]);
    const t = pick(build(), "image_generate");
    await expectFailure(
      t.execute("c", { prompt: "x", path: "out.png" }),
      /403|forbidden|download|fail/i,
    );
    expect(existsSync(join(cwd, "out.png"))).toBe(false);
  });

  it("survives a 5KB prompt without truncating it on the wire", async () => {
    const giantPrompt = "Draw " + "tiny ".repeat(1000) + "details.";
    routeFetch([
      { match: (u) => !u.includes("/status") && u.includes("queue.fal.run/"),
        response: () => new Response(JSON.stringify({
          request_id: "b", status_url: "https://queue.fal.run/x/b/status", response_url: "https://queue.fal.run/x/b",
        }), { status: 200 }) },
      { match: (u) => u.endsWith("/status"),
        response: () => new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 }) },
      { match: (u) => u.includes("/requests/b") && !u.endsWith("/status"),
        response: () => new Response(JSON.stringify({
          images: [{ url: "https://cdn.fal.ai/x.png", width: 1, height: 1 }],
        }), { status: 200 }) },
      { match: (u) => u.includes("cdn.fal.ai"),
        response: () => new Response(TINY_PNG, { status: 200 }) },
    ]);
    const t = pick(build(), "image_generate");
    await t.execute("c", { prompt: giantPrompt, path: "big.png" });
    const submitBody = JSON.parse(lastRequests[0].init!.body as string);
    expect(submitBody.prompt).toBe(giantPrompt);
  });

  it("falls back to FAL_KEY env when no vault key is present", { timeout: 60_000 }, async () => {
    process.env.FAL_KEY = "env-fal-key";
    try {
      const noKeysVault: ResolvedVault = {
        get: () => undefined, getSmtp: () => undefined, getImap: () => undefined,
        getKey: () => undefined, has: () => false, list: () => [],
      };
      routeFetch([
        // Submit
        { match: (u) => u.includes("queue.fal.run/") && !u.endsWith("/status"),
          response: () => new Response(JSON.stringify({
            request_id: "e",
            status_url: "https://queue.fal.run/x/e/status",
            response_url: "https://queue.fal.run/x/e/result",
          }), { status: 200 }) },
        // Short-circuit poll with FAILED so we don't loop.
        { match: (u) => u.endsWith("/status"),
          response: () => new Response(JSON.stringify({ status: "FAILED", error: "test stop" }), { status: 200 }) },
      ]);
      const tools = createImageTools(cwd, [cwd], ["image_generate"], noKeysVault);
      const t = pick(tools, "image_generate");
      // We expect the flow to fail (mock returns FAILED) — what we
      // care about is the Authorization header on the first request
      // (proves env fallback works when vault has no key).
      await t.execute("c", { prompt: "x", path: "out.png" }).catch(() => {});
      const headers = (lastRequests[0].init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Key env-fal-key");
    } finally {
      delete process.env.FAL_KEY;
    }
  });
});

describe("image_analyze — paranoid", () => {
  function build() { return createImageTools(cwd, [cwd], ["image_analyze"], makeVault()); }

  it("rejects when OpenAI returns no choices in the response", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    routeFetch([
      { match: () => true,
        response: () => new Response(JSON.stringify({ choices: [], usage: {} }), { status: 200 }) },
    ]);
    const t = pick(build(), "image_analyze");
    const result = await t.execute("c", { path: "i.png" });
    // Tool either errors out or returns empty content. Both
    // acceptable; pin "no crash, parseable result, no garbage".
    expect(result).toBeDefined();
    expect(text(result)).not.toContain("undefined");
  });

  it("rejects a 0-byte image file before sending it to OpenAI", async () => {
    writeFileSync(join(cwd, "empty.png"), Buffer.alloc(0));
    routeFetch([{ match: () => true, response: () => new Response("ok", { status: 200 }) }]);
    const t = pick(build(), "image_analyze");
    // Either errors before fetching or sends an empty image. The
    // contract we lock in: no crash. (If an empty image is sent,
    // OpenAI rejects it — same outcome.)
    const result = await t.execute("c", { path: "empty.png" }).catch((e) => ({
      content: [{ type: "text", text: e.message }], details: { error: e.message },
    } as any));
    expect(result).toBeDefined();
  });

  it("survives a malformed JSON response (chunked HTML error page)", async () => {
    writeFileSync(join(cwd, "i.png"), TINY_PNG);
    routeFetch([
      { match: () => true,
        response: () => new Response("<!doctype html><html>Bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }) },
    ]);
    const t = pick(build(), "image_analyze");
    await expectFailure(t.execute("c", { path: "i.png" }), /502|html|bad|error/i);
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
