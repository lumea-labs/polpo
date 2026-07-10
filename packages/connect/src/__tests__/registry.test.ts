import { describe, expect, it } from "vitest";
import { ConnectError, createConnectorRegistry, normalizeScopes } from "../index.js";
import type { ConnectorProviderDefinition } from "../index.js";

const provider: ConnectorProviderDefinition = {
  id: "github",
  name: "GitHub",
  auth: { type: "oauth2", authorizationUrl: "https://github.test/auth", tokenUrl: "https://github.test/token" },
  scopes: [
    { id: "repo" },
    { id: "read:user" },
  ],
};

describe("connect registry", () => {
  it("normalizes scopes deterministically", () => {
    expect(normalizeScopes([" repo ", "", "read:user", "repo"])).toEqual(["read:user", "repo"]);
  });

  it("rejects duplicate provider ids", () => {
    expect(() => createConnectorRegistry([provider, provider])).toThrow(ConnectError);
  });

  it("rejects invalid provider ids", () => {
    expect(() => createConnectorRegistry([{ ...provider, id: "GitHub!" }])).toThrow(ConnectError);
  });

  it("throws provider_not_found for unknown providers", () => {
    const registry = createConnectorRegistry([provider]);
    expect(() => registry.require("slack")).toThrow(/Unknown connector provider/);
  });

  it("rejects scopes not declared by curated providers", () => {
    const registry = createConnectorRegistry([provider]);
    expect(() => registry.validateScopes("github", ["repo", "admin:org"])).toThrow(/does not allow scopes/);
  });

  it("allows custom scopes for generic providers", () => {
    const registry = createConnectorRegistry([{ ...provider, id: "custom_oauth", allowCustomScopes: true }]);
    expect(registry.validateScopes("custom_oauth", ["custom.write", "custom.read"])).toEqual(["custom.read", "custom.write"]);
  });
});
