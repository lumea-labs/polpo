import { afterEach, describe, expect, it } from "vitest";
import { setProviderOverrides } from "@polpo-ai/llm";
import { resolveNodeModelOptions } from "../llm/model-runtime-options.js";

const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;
const ORIGINAL_POLPO_MODEL = process.env.POLPO_MODEL;

afterEach(() => {
  setProviderOverrides({});
  restoreEnv("OPENAI_API_KEY", ORIGINAL_OPENAI_API_KEY);
  restoreEnv("AI_GATEWAY_API_KEY", ORIGINAL_AI_GATEWAY_API_KEY);
  restoreEnv("POLPO_MODEL", ORIGINAL_POLPO_MODEL);
});

describe("resolveNodeModelOptions", () => {
  it("uses an explicit gateway config when one is configured", () => {
    process.env.OPENAI_API_KEY = "provider-key";

    const options = resolveNodeModelOptions("openai/gpt-4o", {
      url: "https://gateway.example/v1",
      apiKey: "gateway-key",
    });

    expect(options).toEqual({
      mode: "gateway",
      gateway: {
        url: "https://gateway.example/v1",
        apiKey: "gateway-key",
      },
    });
  });

  it("uses direct provider execution when a provider key is available", () => {
    process.env.OPENAI_API_KEY = "provider-key";
    delete process.env.AI_GATEWAY_API_KEY;

    expect(resolveNodeModelOptions("openai/gpt-4o")).toEqual({ mode: "provider" });
  });

  it("keeps AI_GATEWAY_API_KEY as a compatibility fallback when no provider key is available", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "gateway-key";

    expect(resolveNodeModelOptions("openai/gpt-4o")).toEqual({ mode: "gateway" });
  });

  it("uses provider execution for custom OpenAI-compatible provider overrides", () => {
    delete process.env.AI_GATEWAY_API_KEY;
    setProviderOverrides({
      local: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    expect(resolveNodeModelOptions("local/llama3")).toEqual({ mode: "provider" });
  });

  it("defaults to provider mode so missing provider keys fail explicitly", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    expect(resolveNodeModelOptions("openai/gpt-4o")).toEqual({ mode: "provider" });
  });

  it("can infer the provider from POLPO_MODEL when no model is passed", () => {
    process.env.POLPO_MODEL = "openai/gpt-4o";
    process.env.OPENAI_API_KEY = "provider-key";
    delete process.env.AI_GATEWAY_API_KEY;

    expect(resolveNodeModelOptions(undefined)).toEqual({ mode: "provider" });
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
