import { describe, it, expect, afterEach } from "vitest";
import {
  buildResolvedModelProviderOptions,
  resolveModel,
  resolveModelWithFallback,
  validateProviderKeys,
  validateProviderKeysDetailed,
  setProviderOverrides,
} from "./model-resolver.js";
import type { ModelRuntimeAdapter } from "./model-runtime.js";

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

  it("allows hosts to satisfy gateway execution through a supplied runtime adapter", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    const aiModel = { modelId: "host-gateway-model" } as any;
    const adapter: ModelRuntimeAdapter = {
      mode: "gateway",
      createLanguageModel: () => aiModel,
      extractUsage: () => ({ costSource: "unknown", billingOwner: "external" }),
      classifyError: error => ({ class: "unknown", retryable: false, message: error instanceof Error ? error.message : "" }),
    };

    const model = resolveModel("openai/gpt-4o", { adapter });

    expect(model.runtimeMode).toBe("gateway");
    expect(model.aiModel).toBe(aiModel);
  });

  it("uses the resolved runtime adapter for provider options when available", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    const adapter: ModelRuntimeAdapter = {
      mode: "gateway",
      createLanguageModel: () => ({ modelId: "host-gateway-model" }) as any,
      buildProviderOptions: () => ({ host: { routed: true } }),
      extractUsage: () => ({ costSource: "unknown", billingOwner: "external" }),
      classifyError: error => ({ class: "unknown", retryable: false, message: error instanceof Error ? error.message : "" }),
    };

    const model = resolveModel("openai/gpt-4o", { adapter });

    expect(buildResolvedModelProviderOptions(model, "medium")).toEqual({
      host: { routed: true },
    });
  });

  it("allows hosts to satisfy provider execution through a supplied runtime adapter", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_GATEWAY_API_KEY;
    const aiModel = { modelId: "host-provider-model" } as any;
    const adapter: ModelRuntimeAdapter = {
      mode: "provider",
      createLanguageModel: () => aiModel,
      extractUsage: () => ({ costSource: "unknown", billingOwner: "external" }),
      classifyError: error => ({ class: "unknown", retryable: false, message: error instanceof Error ? error.message : "" }),
    };

    const model = resolveModel("openai/gpt-4o", { adapter });

    expect(model.runtimeMode).toBe("provider");
    expect(model.aiModel).toBe(aiModel);
  });

  it("rejects inconsistent explicit mode and runtime adapter mode", () => {
    const adapter: ModelRuntimeAdapter = {
      mode: "gateway",
      createLanguageModel: () => ({ modelId: "host-gateway-model" }) as any,
      extractUsage: () => ({ costSource: "unknown", billingOwner: "external" }),
      classifyError: error => ({ class: "unknown", retryable: false, message: error instanceof Error ? error.message : "" }),
    };

    expect(() => resolveModel("openai/gpt-4o", { mode: "provider", adapter })).toThrow(/does not match requested mode/);
  });
});

describe("resolveModelWithFallback", () => {
  it("uses normalized fallback candidates", () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.AI_GATEWAY_API_KEY;

    const result = resolveModelWithFallback({
      primary: "missing-provider/no-key",
      fallbacks: [" openai/gpt-4o ", "openai/gpt-4o"],
    });

    expect(result.spec).toBe("openai/gpt-4o");
    expect(result.model.provider).toBe("openai");
  });
});
