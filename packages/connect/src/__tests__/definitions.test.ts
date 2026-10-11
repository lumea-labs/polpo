import { describe, expect, it } from "vitest";
import {
  compileConnectorDefinition,
  createConnectorRegistry,
  normalizeConnectorDefinition,
} from "../index.js";
import type { ConnectorDefinition } from "../index.js";

const api: ConnectorDefinition = {
  version: 2,
  id: "company_api",
  name: "Company API",
  source: "custom",
  protocol: "http_api",
  defaultAuthenticationId: "key",
  authentication: [
    { id: "key", type: "api_key", injection: { mode: "header", name: "X-API-Key" } },
    {
      id: "user_oauth", type: "oauth2",
      authorizationUrl: "https://auth.example.com/authorize",
      tokenUrl: "https://auth.example.com/token",
      defaultScopes: ["contacts.read"],
      supportsPkce: true,
    },
  ],
  scopes: [{ id: "contacts.read" }],
  http: {
    origins: ["https://api.example.com"],
    allowedMethods: ["GET"],
    allowedPathPatterns: ["/contacts", "/contacts/*"],
  },
};

describe("versioned Connector definitions", () => {
  it("uses one API definition with independently selected key or OAuth authentication", () => {
    const registry = createConnectorRegistry([api]);
    expect(registry.require(api.id, "key")).toMatchObject({
      id: api.id, protocol: "http_api", authenticationId: "key",
      auth: { type: "api_key", headerName: "X-API-Key" },
      http: { auth: { mode: "header", name: "X-API-Key" } },
    });
    expect(registry.require(api.id, "user_oauth")).toMatchObject({
      id: api.id, protocol: "http_api", authenticationId: "user_oauth",
      auth: { type: "oauth2", supportsPkce: true },
      http: { auth: { mode: "bearer" } },
    });
    expect(registry.require(api.id).authenticationId).toBe("key");
    expect(() => registry.require(api.id, "invented")).toThrow(/authentication/i);
  });

  it("does not reinterpret a credential-only legacy record as a custom HTTP API", () => {
    const registry = createConnectorRegistry([{
      id: "api_key", name: "Legacy key", auth: { type: "api_key" },
    }]);
    expect(registry.require("api_key").http).toBeUndefined();
    expect(registry.describe("api_key")).toMatchObject({
      kind: "credential", source: "legacy", protocol: null,
    });
    expect(() => registry.require("api_key", "invented")).toThrow(/authentication/i);
  });

  it("preserves legacy provider IDs and reports MCP separately from its supported auth", () => {
    const registry = createConnectorRegistry([{
      id: "remote_mcp", name: "Remote MCP", auth: { type: "mcp", auth: "oauth2" },
    }]);
    expect(registry.describe("remote_mcp")).toMatchObject({
      kind: "integration", protocol: "mcp", authentication: [{ type: "oauth2" }],
    });
    expect(registry.require("remote_mcp").auth).toEqual({ type: "mcp", auth: "oauth2" });
  });

  it("describes configured API methods without exposing OAuth client material", () => {
    const registry = createConnectorRegistry([{
      id: "old_oauth", name: "Old OAuth",
      auth: {
        type: "oauth2", authorizationUrl: "https://auth.example.com/auth",
        tokenUrl: "https://auth.example.com/token", clientId: "private-config",
        clientSecret: "test-secret-value",
      },
      http: { origins: ["https://api.example.com"], auth: { mode: "bearer" } },
    }]);
    const serialized = JSON.stringify(registry.describe("old_oauth"));
    expect(serialized).not.toContain("test-secret-value");
    expect(serialized).not.toContain("private-config");
    expect(registry.describe("old_oauth").protocol).toBe("http_api");
  });

  it("supports a public API without manufacturing an authentication credential", () => {
    const provider = compileConnectorDefinition({
      ...api, authentication: [{ id: "public", type: "none" }],
      defaultAuthenticationId: "public",
    });
    expect(provider.auth.type).toBe("none");
    expect(provider.http?.auth).toEqual({ mode: "none" });
  });

  it("normalizes and freezes authored definitions so later mutation cannot broaden policy", () => {
    const input = structuredClone(api);
    const registry = createConnectorRegistry([input]);
    input.http.origins.push("https://attacker.example");
    input.authentication[0].id = "changed";
    const described = registry.describe(api.id);
    expect(described.authentication[0].id).toBe("key");
    expect(registry.require(api.id).http?.origins).toEqual(["https://api.example.com"]);
    expect(Object.isFrozen(described.authentication)).toBe(true);
    expect(Object.isFrozen(described.authentication[0])).toBe(true);
  });

  it.each([
    { protocol: "oauth" },
    { version: 3 },
    { id: "x" },
    { authentication: [{ ...api.authentication[1], id: "key", grantType: "client_credentials" }] },
    { scopes: [{ id: "contacts.read", clientSecret: "must-not-be-a-catalog-field" }] },
    { actions: [{ id: "read", risk: "unexpected" }] },
    { actions: [{ id: "read", inputSchema: { value: Number.NaN } }] },
    { authentication: [] },
    { authentication: [api.authentication[0], api.authentication[0]] },
    { defaultAuthenticationId: "unknown" },
    { http: undefined },
    { http: { origins: ["http://api.example.com"] } },
    { http: { origins: ["https://127.0.0.1"] } },
    { authentication: [{ id: "key", type: "api_key", injection: { mode: "header", name: "Host" } }] },
    { authentication: [{ id: "key", type: "api_key", injection: { mode: "none" } }] },
    { authentication: [{ ...api.authentication[1], id: "key", clientSecret: "test-secret" }] },
    { authentication: [{ ...api.authentication[1], id: "key", authorizationUrl: "http://auth.example.com" }] },
    { authentication: [{ ...api.authentication[1], id: "key", tokenUrl: "https://localhost/token" }] },
    { authentication: [{ ...api.authentication[1], id: "key", extraAuthorizeParams: { redirect_uri: "https://attacker.example" } }] },
  ])("rejects invalid or unsafe definitions before storage: %j", (patch) => {
    expect(() => normalizeConnectorDefinition({ ...api, ...patch })).toThrow();
  });

  it("supports MCP's advertised auth options without treating OAuth as a protocol", () => {
    const mcp: ConnectorDefinition = {
      version: 2, id: "custom_mcp", name: "Custom MCP", source: "custom",
      protocol: "mcp", defaultAuthenticationId: "oauth",
      authentication: [
        { id: "oauth", type: "oauth2", discovery: true },
        { id: "token", type: "api_key", injection: { mode: "bearer" } },
        { id: "public", type: "none" },
      ],
    };
    expect(compileConnectorDefinition(mcp, "oauth").auth).toMatchObject({ type: "mcp", auth: "oauth2" });
    expect(compileConnectorDefinition(mcp, "token").auth).toMatchObject({ type: "mcp", auth: "bearer" });
    expect(compileConnectorDefinition(mcp, "public").auth).toMatchObject({ type: "mcp", auth: "none" });
    expect(() => normalizeConnectorDefinition({ ...mcp, authentication: api.authentication })).toThrow();
  });

  const identity = { method: "userinfo" as const, issuer: "https://auth.example.com", url: "https://identity.example.com/userinfo", requiredScopes: ["contacts.read"] };
  it("preserves a fixed UserInfo identity policy without allowing agents to call the identity origin", () => {
    const provider = compileConnectorDefinition({ ...api, authentication: [api.authentication[0], {
      id: "user_oauth", type: "oauth2", authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token", identity,
    }] }, "user_oauth");
    expect(provider.auth).toMatchObject({ identity });
    expect(provider.http?.origins).toEqual(["https://api.example.com"]);
  });

  it.each([
    { method: "decoded_jwt" }, { issuer: "https://auth.example.com/?tenant=x" }, { url: "http://identity.example.com/userinfo" },
    { url: "https://localhost/userinfo" }, { url: "https://user:secret@identity.example.com/userinfo" },
    { requiredScopes: [] }, { requiredScopes: ["undeclared"] }, { subjectPath: "email" },
    { scopeAliases: { other: "undeclared" } }, { scopeAliases: { "contacts.read": "contacts.read" } },
  ])("rejects unsafe or ambiguous identity policies: %j", patch => {
    expect(() => normalizeConnectorDefinition({ ...api, authentication: [api.authentication[0], { ...api.authentication[1], identity: { ...identity, ...patch } }] })).toThrow();
  });
});
