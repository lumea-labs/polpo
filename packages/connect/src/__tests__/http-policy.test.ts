import { describe, expect, it } from "vitest";

import { ConnectionSelectionError } from "@polpo-ai/core";
import {
  assertConnectorRedirectAllowed,
  normalizeConnectorHttpPolicy,
  resolveConnectorHttpRequest,
} from "../index.js";

const policy = normalizeConnectorHttpPolicy({
  origins: ["https://api.example.com"],
  allowedMethods: ["GET", "POST"],
  allowedPathPatterns: ["/v1/items", "/v1/items/*"],
  auth: { mode: "bearer" },
  followRedirects: false,
  maxRequestBytes: 128,
  maxResponseBytes: 1_024,
  timeoutMs: 5_000,
});

describe("Connector HTTP policy", () => {
  it("normalizes a relative provider request without accepting credentials", () => {
    const resolved = resolveConnectorHttpRequest(policy, {
      method: "get",
      path: "/v1/items/42",
      query: { include: ["owner", "labels"], cursor: "next" },
      headers: { Accept: "application/json", "X-Trace": "trace-1" },
      timeoutMs: 2_000,
    });

    expect(resolved).toEqual({
      url: "https://api.example.com/v1/items/42?include=owner&include=labels&cursor=next",
      method: "GET",
      headers: { accept: "application/json", "x-trace": "trace-1" },
      body: undefined,
      idempotencyKey: undefined,
      timeoutMs: 2_000,
      maxResponseBytes: 1_024,
      followRedirects: false,
    });
    expect(JSON.stringify(resolved)).not.toMatch(/token|secret|authorization/i);
  });

  it("caps caller timeouts to the Connector policy", () => {
    expect(resolveConnectorHttpRequest(policy, {
      method: "GET",
      path: "/v1/items",
      timeoutMs: 60_000,
    }).timeoutMs).toBe(5_000);
  });

  it("rejects absolute URLs, traversal, unsupported methods, and unknown paths", () => {
    for (const request of [
      { method: "GET", path: "https://evil.example/steal" },
      { method: "GET", path: "//evil.example/steal" },
      { method: "GET", path: "/v1/items/%2e%2e/admin" },
      { method: "DELETE", path: "/v1/items/42" },
      { method: "GET", path: "/v1/admin" },
    ]) {
      expect(() => resolveConnectorHttpRequest(policy, request)).toThrow(
        expect.objectContaining({ code: "connection_operation_denied" }),
      );
    }
  });

  it("rejects caller-controlled transport, credential, proxy, and cookie headers", () => {
    for (const name of [
      "Authorization",
      "Cookie",
      "Host",
      "Content-Length",
      "Proxy-Authorization",
      "X-Forwarded-Host",
    ]) {
      expect(() => resolveConnectorHttpRequest(policy, {
        method: "GET",
        path: "/v1/items",
        headers: { [name]: "attacker-value" },
      })).toThrow(expect.objectContaining({ code: "connection_operation_denied" }));
    }
  });

  it("rejects oversized and non-serializable request bodies", () => {
    expect(() => resolveConnectorHttpRequest(policy, {
      method: "POST",
      path: "/v1/items",
      body: { value: "x".repeat(256) },
    })).toThrow(expect.objectContaining({ code: "connection_operation_denied" }));

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => resolveConnectorHttpRequest(policy, {
      method: "POST",
      path: "/v1/items",
      body: cyclic,
    })).toThrow(expect.objectContaining({ code: "connection_operation_denied" }));
  });

  it("rejects unsafe Connector origins at registration time", () => {
    for (const origin of [
      "http://api.example.com",
      "https://user:pass@api.example.com",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://10.0.0.1",
      "https://[::1]",
      "https://api.example.com/base-path",
    ]) {
      expect(() => normalizeConnectorHttpPolicy({
        origins: [origin],
        auth: { mode: "bearer" },
      })).toThrow(ConnectionSelectionError);
    }
  });

  it("denies redirects by default and revalidates enabled destinations", () => {
    expect(() => assertConnectorRedirectAllowed(
      policy,
      "https://api.example.com/v1/items/next",
    )).toThrow(expect.objectContaining({ code: "connection_operation_denied" }));

    const redirects = normalizeConnectorHttpPolicy({
      ...policy,
      followRedirects: true,
    });
    expect(assertConnectorRedirectAllowed(
      redirects,
      "https://api.example.com/v1/items/next",
    )).toBe("https://api.example.com/v1/items/next");
    expect(() => assertConnectorRedirectAllowed(
      redirects,
      "https://evil.example/v1/items/next",
    )).toThrow(expect.objectContaining({ code: "connection_operation_denied" }));
  });
});
