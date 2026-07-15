import { describe, it, expect, afterEach } from "vitest";
import {
  resolveModel,
  validateProviderKeys,
  validateProviderKeysDetailed,
  setProviderOverrides,
} from "./model-resolver.js";

// A provider name that certainly has no env key, no OAuth profile, and no
// entry in the static PROVIDER_ENV_MAP.
const CUSTOM = "bench-custom";
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;

afterEach(() => {
  setProviderOverrides({});
  if (ORIGINAL_OPENAI_API_KEY === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  }
  if (ORIGINAL_AI_GATEWAY_API_KEY === undefined) {
    delete process.env.AI_GATEWAY_API_KEY;
  } else {
    process.env.AI_GATEWAY_API_KEY = ORIGINAL_AI_GATEWAY_API_KEY;
  }
});

describe("validateProviderKeys — custom provider overrides", () => {
  it("flags an unknown provider without key as missing", () => {
    const missing = validateProviderKeys([`${CUSTOM}/some-model`]);
    expect(missing).toEqual([{ provider: CUSTOM, modelSpec: `${CUSTOM}/some-model` }]);
  });

  it("accepts a provider with a baseUrl override (no env key required)", () => {
    setProviderOverrides({ [CUSTOM]: { baseUrl: "http://127.0.0.1:9999/v1" } });
    const missing = validateProviderKeys([`${CUSTOM}/some-model`]);
    expect(missing).toEqual([]);
  });

  it("an override WITHOUT baseUrl does not satisfy the key requirement", () => {
    setProviderOverrides({ [CUSTOM]: { models: [] } as any });
    const missing = validateProviderKeys([`${CUSTOM}/some-model`]);
    expect(missing).toHaveLength(1);
  });
});

describe("validateProviderKeysDetailed — custom provider overrides", () => {
  it("reports hasKey=true when a baseUrl override exists", () => {
    setProviderOverrides({ [CUSTOM]: { baseUrl: "http://127.0.0.1:9999/v1" } });
    const results = validateProviderKeysDetailed([`${CUSTOM}/some-model`]);
    expect(results).toHaveLength(1);
    expect(results[0].hasKey).toBe(true);
  });

  it("reports hasKey=false without an override", () => {
    const results = validateProviderKeysDetailed([`${CUSTOM}/some-model`]);
    expect(results[0].hasKey).toBe(false);
  });
});

describe("resolveModel — runtime mode selection", () => {
  it("keeps gateway mode as the default for backward compatibility", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.AI_GATEWAY_API_KEY;

    const model = resolveModel("openai/gpt-4o");

    expect(model.runtimeMode).toBe("gateway");
  });

  it("uses direct provider mode only when explicitly requested", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.AI_GATEWAY_API_KEY;

    const model = resolveModel("openai/gpt-4o", { mode: "provider" });

    expect(model.runtimeMode).toBe("provider");
    expect(model.provider).toBe("openai");
    expect(model.id).toBe("gpt-4o");
  });

  it("fails direct provider mode explicitly when the provider key is missing", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;

    expect(() => resolveModel("openai/gpt-4o", { mode: "provider" })).toThrow(/Missing API key|No LLM gateway/);
  });
});
