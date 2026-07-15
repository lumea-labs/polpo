import { beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeMock, speakMock, resolveTranscribeProviderMock, resolveSpeakProviderMock } = vi.hoisted(() => ({
  transcribeMock: vi.fn(),
  speakMock: vi.fn(),
  resolveTranscribeProviderMock: vi.fn(),
  resolveSpeakProviderMock: vi.fn(),
}));

vi.mock("ai", () => ({
  experimental_transcribe: transcribeMock,
  experimental_generateSpeech: speakMock,
}));

vi.mock("../lib/provider-resolver.js", () => ({
  resolveTranscribeProvider: resolveTranscribeProviderMock,
  resolveSpeakProvider: resolveSpeakProviderMock,
}));

import { createAudioTools } from "../audio-tools.js";
import type { ResolvedVault } from "../types.js";

const vault = {
  get: () => ({ key: "deepgram-secret" }),
  getSmtp: () => undefined,
  getImap: () => undefined,
  getKey: (service: string, key: string) => service === "deepgram" && key === "key"
    ? "deepgram-secret"
    : undefined,
  has: (service: string) => service === "deepgram",
  list: () => [{ service: "deepgram", type: "api_key", keys: ["key"] }],
} as ResolvedVault;

function createTool() {
  const [tool] = createAudioTools({
    cwd: "/workspace",
    allowedPaths: ["/workspace"],
    allowedTools: ["audio_transcribe"],
    transcribeModel: "deepgram/nova-2",
    vault,
    fs: {
      readFileBuffer: async () => Buffer.from("fake audio"),
    } as any,
  });
  return tool;
}

function createSpeakTool() {
  const [tool] = createAudioTools({
    cwd: "/workspace",
    allowedPaths: ["/workspace"],
    allowedTools: ["audio_speak"],
    ttsModel: "edge/edge-tts",
    fs: {
      mkdir: vi.fn(async () => undefined),
      writeFileBuffer: vi.fn(async () => undefined),
    } as any,
    shell: {} as any,
  });
  return tool;
}

describe("audio_transcribe Deepgram options", () => {
  beforeEach(() => {
    transcribeMock.mockReset();
    speakMock.mockReset();
    resolveTranscribeProviderMock.mockReset();
    resolveSpeakProviderMock.mockReset();
    resolveTranscribeProviderMock.mockResolvedValue({
      transcription: (model: string) => `deepgram:${model}`,
    });
    resolveSpeakProviderMock.mockResolvedValue({
      speech: (model: string) => `edge:${model}`,
    });
    transcribeMock.mockResolvedValue({
      text: "trascrizione",
      language: "it",
      durationInSeconds: 1,
    });
    speakMock.mockResolvedValue({
      audio: { uint8Array: new Uint8Array([1, 2, 3]) },
    });
  });

  it("auto-detects language and uses AI SDK camelCase options when omitted", async () => {
    await createTool().execute("call-1", { path: "sample.wav" });

    expect(transcribeMock).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepgram:nova-2",
      providerOptions: {
        deepgram: {
          smartFormat: true,
          punctuate: true,
          detectLanguage: true,
        },
      },
    }));
    expect(transcribeMock.mock.calls[0][0].providerOptions.deepgram).not.toHaveProperty("smart_format");
  });

  it("emits provider model usage facts for transcription", async () => {
    const result = await createTool().execute("call-usage", { path: "sample.wav" });

    expect(result.details?.modelUsage).toEqual(expect.objectContaining({
      mode: "provider",
      operation: "audio.transcribe",
      requestedProvider: "deepgram",
      requestedModel: "deepgram/nova-2",
      resolvedProvider: "deepgram",
      resolvedModel: "deepgram/nova-2",
      finalProvider: "deepgram",
      credentialType: "project",
      status: "succeeded",
      audioInputSeconds: 1,
      costSource: "unknown",
      billingOwner: "external",
    }));
  });

  it("uses the explicit language instead of auto-detection when provided", async () => {
    await createTool().execute("call-2", { path: "sample.wav", language: "it" });

    expect(transcribeMock).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: {
        deepgram: {
          smartFormat: true,
          punctuate: true,
          language: "it",
        },
      },
    }));
    expect(transcribeMock.mock.calls[0][0].providerOptions.deepgram).not.toHaveProperty("detectLanguage");
  });

  it("emits local model usage facts for edge speech without platform billing", async () => {
    const result = await createSpeakTool().execute("call-speech", {
      text: "hello",
      path: "out.mp3",
      language: "en",
    });

    expect(speakMock).toHaveBeenCalledWith(expect.objectContaining({
      model: "edge:edge-tts",
      text: "hello",
      outputFormat: "mp3",
      language: "en",
    }));
    expect(result.details?.modelUsage).toEqual(expect.objectContaining({
      mode: "provider",
      operation: "audio.speak",
      requestedProvider: "edge",
      requestedModel: "edge/edge-tts",
      resolvedProvider: "edge",
      resolvedModel: "edge/edge-tts",
      finalProvider: "edge",
      credentialType: "none",
      status: "succeeded",
      costSource: "none",
      billingOwner: "none",
    }));
  });
});
