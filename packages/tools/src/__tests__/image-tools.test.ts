import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToolResult } from "@polpo-ai/core";

const generateText = vi.fn();
const gatewayLanguageModel = vi.fn((id: string) => ({ via: "gateway", id }));
const anthropicModel = vi.fn((id: string) => ({ via: "anthropic", id }));
const createAnthropic = vi.fn(() => anthropicModel);

vi.mock("ai", () => ({ generateText }));
vi.mock("@ai-sdk/gateway", () => ({
  createGatewayProvider: () => ({ languageModel: gatewayLanguageModel }),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));

const { createImageTools } = await import("../image-tools.js");

let cwd: string;
const savedEnv = { ...process.env };

function analyzeTool(vault?: { getKey(service: string, key: string): string | undefined }) {
  const tool = createImageTools({
    cwd,
    allowedTools: ["image_analyze"],
    visionModel: "anthropic/claude-haiku-5.5",
    ...(vault ? { vault: vault as any } : {}),
  })[0]!;
  return (params: Record<string, unknown>) => tool.execute("call-1", params as any);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "polpo-image-tools-"));
  writeFileSync(join(cwd, "shot.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]));
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  generateText.mockReset();
  generateText.mockResolvedValue({
    text: "A seaside apartment",
    usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 },
    providerMetadata: { gateway: { generationId: "gen_1", marketCost: "0.0004", cost: "0.0004" } },
  });
  gatewayLanguageModel.mockClear();
  createAnthropic.mockClear();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

describe("image_analyze credential routing — production regression 2026-10-23", () => {
  it("uses the managed gateway when the agent has no provider key", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-test";
    const result = await analyzeTool()({ path: "shot.png" });

    expect(gatewayLanguageModel).toHaveBeenCalledWith("anthropic/claude-haiku-5.5");
    expect(createAnthropic).not.toHaveBeenCalled();
    expect(generateText.mock.calls[0]![0].model).toEqual({ via: "gateway", id: "anthropic/claude-haiku-5.5" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ provider: "gateway", model: "claude-haiku-5.5" });
    expect(result.details.usage).toMatchObject({ generationId: "gen_1" });
  });

  it("keeps an agent's own provider key on the direct BYOK path", async () => {
    process.env.AI_GATEWAY_API_KEY = "gw-test";
    const vault = { getKey: (service: string) => service === "anthropic" ? "sk-ant-agent" : undefined };
    const result = await analyzeTool(vault)({ path: "shot.png" });

    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-agent" });
    expect(anthropicModel).toHaveBeenCalledWith("claude-haiku-5.5");
    expect(gatewayLanguageModel).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ provider: "anthropic" });
    expect(result.details.usage).toBeUndefined();
  });

  it("reports a missing credential as a tool error, never as a successful result", async () => {
    const result = await analyzeTool()({ path: "shot.png" });

    expect(generateText).not.toHaveBeenCalled();
    expect(renderToolResult(result)).toMatch(/^Error: Image analysis error: Missing environment variable: ANTHROPIC_API_KEY/);
  });
});
