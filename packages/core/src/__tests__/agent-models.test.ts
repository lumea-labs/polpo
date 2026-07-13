/**
 * Unit tests for the model-string parser and the canonical defaults.
 *
 * The parser is small but load-bearing: every media tool reads through
 * it, so a regression here ripples to image_generate, video_generate,
 * image_analyze, audio_transcribe, audio_speak. The paranoid coverage
 * here pins:
 *   - the FIRST `/` is the separator (not the last, not all)
 *   - empty / malformed strings reject up-front instead of producing
 *     half-initialized providers downstream
 *   - unicode and whitespace pass through untouched (the validator is
 *     position-aware, not character-class-aware)
 */

import { describe, it, expect } from "vitest";
import {
  parseModelString,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_SEARCH_PROVIDER,
  AUDIO_MODEL_CATALOG,
  getAudioModel,
  listAudioModels,
} from "../agent-models.js";

describe("parseModelString — happy path", () => {
  it("splits 'provider/model' on the first slash", () => {
    expect(parseModelString("openai/gpt-4o-mini")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("preserves multi-slash model ids verbatim (fal-ai exposes them)", () => {
    // fal nests model paths multiple levels deep — the model id must
    // survive the split without truncation or re-escaping.
    expect(parseModelString("fal/fal-ai/flux/dev")).toEqual({
      provider: "fal",
      model: "fal-ai/flux/dev",
    });
    expect(parseModelString("fal/fal-ai/wan/v2.2-1.3b/text-to-video")).toEqual({
      provider: "fal",
      model: "fal-ai/wan/v2.2-1.3b/text-to-video",
    });
  });

  it("preserves unicode in provider and model", () => {
    expect(parseModelString("openai/モデル-α")).toEqual({
      provider: "openai",
      model: "モデル-α",
    });
  });

  it("preserves dashes, dots, underscores, version numbers in the model id", () => {
    expect(parseModelString("anthropic/claude-sonnet-4-20250514")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });
    expect(parseModelString("openai/tts-1-hd")).toEqual({
      provider: "openai",
      model: "tts-1-hd",
    });
  });
});

describe("parseModelString — adversarial inputs", () => {
  it("rejects an empty string", () => {
    expect(() => parseModelString("")).toThrow(/non-empty/i);
  });

  it("rejects a string with no slash separator", () => {
    expect(() => parseModelString("just-a-model")).toThrow(/provider.*model/i);
  });

  it("rejects a string starting with a slash (empty provider)", () => {
    expect(() => parseModelString("/gpt-4o")).toThrow(/provider.*model.*non-empty/i);
  });

  it("rejects a string ending with a slash (empty model)", () => {
    expect(() => parseModelString("openai/")).toThrow(/provider.*model.*non-empty/i);
  });

  it("rejects a non-string input (the public type guards this, but doc the runtime guard)", () => {
    expect(() => parseModelString(undefined as unknown as string)).toThrow(/non-empty/i);
    expect(() => parseModelString(null as unknown as string)).toThrow(/non-empty/i);
    expect(() => parseModelString(42 as unknown as string)).toThrow(/non-empty/i);
  });

  it("does not collapse leading/trailing whitespace — the caller is responsible for trimming", () => {
    // Whitespace is part of the provider/model name, even if absurd.
    // We pin "no implicit trim" so callers can't unexpectedly mismatch
    // a vault key with leading space.
    expect(parseModelString(" openai/gpt-4o")).toEqual({
      provider: " openai",
      model: "gpt-4o",
    });
    expect(parseModelString("openai/ gpt-4o")).toEqual({
      provider: "openai",
      model: " gpt-4o",
    });
  });

  it("a single slash 'a/b' with one-char segments is valid", () => {
    expect(parseModelString("a/b")).toEqual({ provider: "a", model: "b" });
  });

  it("a slash at position 1 with provider 'x' is valid (no off-by-one)", () => {
    expect(parseModelString("x/y/z")).toEqual({ provider: "x", model: "y/z" });
  });
});

describe("DEFAULT_*_MODEL constants — wire format", () => {
  // These constants are the central source of truth — every tool
  // falls back to them. Pin the exact strings so a typo or version
  // bump shows up here instead of silently changing tool behavior.
  it("DEFAULT_IMAGE_MODEL is a parseable provider/model pair", () => {
    expect(DEFAULT_IMAGE_MODEL).toBe("fal/fal-ai/flux/dev");
    const parsed = parseModelString(DEFAULT_IMAGE_MODEL);
    expect(parsed.provider).toBe("fal");
  });

  it("DEFAULT_VIDEO_MODEL is parseable", () => {
    expect(DEFAULT_VIDEO_MODEL).toBe("fal/luma-ray-2-flash");
    expect(parseModelString(DEFAULT_VIDEO_MODEL).provider).toBe("fal");
  });

  it("DEFAULT_VISION_MODEL is parseable and routes to a multimodal provider", () => {
    expect(DEFAULT_VISION_MODEL).toBe("openai/gpt-4o-mini");
    expect(parseModelString(DEFAULT_VISION_MODEL).provider).toBe("openai");
  });

  it("DEFAULT_TRANSCRIBE_MODEL is parseable", () => {
    expect(DEFAULT_TRANSCRIBE_MODEL).toBe("openai/whisper-1");
    expect(parseModelString(DEFAULT_TRANSCRIBE_MODEL).provider).toBe("openai");
  });

  it("DEFAULT_TTS_MODEL is parseable", () => {
    expect(DEFAULT_TTS_MODEL).toBe("edge/edge-tts");
    expect(parseModelString(DEFAULT_TTS_MODEL).provider).toBe("edge");
  });

  it("DEFAULT_SEARCH_PROVIDER is just the bare provider name (no model)", () => {
    // Search providers are services, not generative models — there's
    // no model to choose from. The schema field is a simple identifier.
    expect(DEFAULT_SEARCH_PROVIDER).toBe("exa");
  });

  it("every default constant round-trips through the parser without losing info", () => {
    const all = [
      DEFAULT_IMAGE_MODEL,
      DEFAULT_VIDEO_MODEL,
      DEFAULT_VISION_MODEL,
      DEFAULT_TRANSCRIBE_MODEL,
      DEFAULT_TTS_MODEL,
    ];
    for (const value of all) {
      const parsed = parseModelString(value);
      const reconstructed = `${parsed.provider}/${parsed.model}`;
      expect(reconstructed).toBe(value);
    }
  });
});

describe("AUDIO_MODEL_CATALOG", () => {
  it("contains unique, parseable provider/model ids", () => {
    const ids = AUDIO_MODEL_CATALOG.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of AUDIO_MODEL_CATALOG) {
      expect(parseModelString(model.id).provider).toBe(model.provider);
    }
  });

  it("describes direct credentials and keeps local models credential-free", () => {
    for (const model of AUDIO_MODEL_CATALOG) {
      if (model.routing === "direct") expect(model.credentialService).toBe(model.provider);
      else expect(model.credentialService).toBeUndefined();
    }
  });

  it("discovers Deepgram for both transcription and speech", () => {
    expect(listAudioModels("transcription")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "deepgram/nova-3" })]),
    );
    expect(listAudioModels("speech")).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "deepgram/aura-2-livia-it" })]),
    );
  });

  it("prioritizes US English Deepgram voices for speech discovery", () => {
    const deepgramVoices = listAudioModels("speech").filter((model) => model.provider === "deepgram");

    expect(deepgramVoices.slice(0, 3).map((model) => model.id)).toEqual([
      "deepgram/aura-2-thalia-en",
      "deepgram/aura-2-helena-en",
      "deepgram/aura-2-apollo-en",
    ]);
    expect(deepgramVoices.slice(0, 3).every((model) => model.language === "en-US")).toBe(true);
  });

  it("returns defensive copies from lookup helpers", () => {
    const model = getAudioModel("deepgram/nova-3");
    expect(model).toMatchObject({ provider: "deepgram", capability: "transcription" });
    if (model) model.name = "changed";
    expect(getAudioModel("deepgram/nova-3")?.name).toBe("Nova 3");
  });
});
