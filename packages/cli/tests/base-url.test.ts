import { describe, it, expect } from "vitest";
import {
  resolveBaseUrl,
  POLPO_API_DOMAIN,
} from "../src/util/base-url.js";

const FALLBACK = "https://api.polpo.sh";

describe("POLPO_API_DOMAIN constant", () => {
  it("is polpo.cloud", () => {
    expect(POLPO_API_DOMAIN).toBe("polpo.cloud");
  });
});

describe("resolveBaseUrl — priority chain", () => {
  it("flag override wins over everything", () => {
    expect(
      resolveBaseUrl({
        flagOverride: "https://custom.example.com",
        envOverride: "https://env.example.com",
        polpoConfig: { apiUrl: "https://cfg.example.com", projectSlug: "abcdefghijklmnopqrst" },
        fallback: FALLBACK,
      }),
    ).toBe("https://custom.example.com");
  });

  it("env override wins over config + fallback", () => {
    expect(
      resolveBaseUrl({
        envOverride: "https://env.example.com",
        polpoConfig: { apiUrl: "https://cfg.example.com" },
        fallback: FALLBACK,
      }),
    ).toBe("https://env.example.com");
  });

  it("polpo.json apiUrl pin wins over slug derivation", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: { apiUrl: "https://onprem.acme.local", projectSlug: "abcdefghijklmnopqrst" },
        fallback: FALLBACK,
      }),
    ).toBe("https://onprem.acme.local");
  });

  it("derives subdomain from projectSlug when no override", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: { projectSlug: "abcdefghijklmnopqrst" },
        fallback: FALLBACK,
      }),
    ).toBe("https://abcdefghijklmnopqrst.polpo.cloud");
  });

  it("falls back when no slug + no overrides (legacy clients)", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: null,
        fallback: FALLBACK,
      }),
    ).toBe(FALLBACK);
  });

  it("falls back when polpo.json exists but has neither apiUrl nor projectSlug", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: {},
        fallback: FALLBACK,
      }),
    ).toBe(FALLBACK);
  });
});

describe("resolveBaseUrl — trailing slash normalization", () => {
  it("strips trailing slash from flag", () => {
    expect(
      resolveBaseUrl({
        flagOverride: "https://x.example/",
        fallback: FALLBACK,
      }),
    ).toBe("https://x.example");
  });

  it("strips trailing slash from env", () => {
    expect(
      resolveBaseUrl({
        envOverride: "https://x.example/",
        fallback: FALLBACK,
      }),
    ).toBe("https://x.example");
  });

  it("strips trailing slash from config apiUrl", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: { apiUrl: "https://x.example/" },
        fallback: FALLBACK,
      }),
    ).toBe("https://x.example");
  });

  it("strips trailing slash from fallback", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: {},
        fallback: "https://api.polpo.sh/",
      }),
    ).toBe("https://api.polpo.sh");
  });

  it("does NOT touch slug-derived URL (no slash to strip)", () => {
    expect(
      resolveBaseUrl({
        polpoConfig: { projectSlug: "abcdefghijklmnopqrst" },
        fallback: FALLBACK,
      }),
    ).toBe("https://abcdefghijklmnopqrst.polpo.cloud");
  });
});

describe("resolveBaseUrl — edge cases", () => {
  it("empty flag is treated as not provided (falls through)", () => {
    expect(
      resolveBaseUrl({
        flagOverride: "",
        envOverride: "https://env.example.com",
        fallback: FALLBACK,
      }),
    ).toBe("https://env.example.com");
  });

  it("self-hosted scenario: env overrides everything (CI / dev)", () => {
    expect(
      resolveBaseUrl({
        envOverride: "http://localhost:4000",
        polpoConfig: { projectSlug: "abcdefghijklmnopqrst" },
        fallback: FALLBACK,
      }),
    ).toBe("http://localhost:4000");
  });
});
