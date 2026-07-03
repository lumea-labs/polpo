import { describe, it, expect, afterEach } from "vitest";
import {
  validateProviderKeys,
  validateProviderKeysDetailed,
  setProviderOverrides,
} from "./model-resolver.js";

// A provider name that certainly has no env key, no OAuth profile, and no
// entry in the static PROVIDER_ENV_MAP.
const CUSTOM = "bench-custom";

afterEach(() => {
  setProviderOverrides({});
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
