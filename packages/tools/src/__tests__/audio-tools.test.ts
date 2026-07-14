import { beforeEach, describe, expect, it, vi } from "vitest";

const { transcribeMock, resolveTranscribeProviderMock } = vi.hoisted(() => ({
  transcribeMock: vi.fn(),
  resolveTranscribeProviderMock: vi.fn(),
}));

vi.mock("ai", () => ({
  experimental_transcribe: transcribeMock,
}));

vi.mock("../lib/provider-resolver.js", () => ({
  resolveTranscribeProvider: resolveTranscribeProviderMock,
  resolveSpeakProvider: vi.fn(),
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

describe("audio_transcribe Deepgram options", () => {
  beforeEach(() => {
    transcribeMock.mockReset();
    resolveTranscribeProviderMock.mockReset();
    resolveTranscribeProviderMock.mockResolvedValue({
      transcription: (model: string) => `deepgram:${model}`,
    });
    transcribeMock.mockResolvedValue({
      text: "trascrizione",
      language: "it",
      durationInSeconds: 1,
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
});
