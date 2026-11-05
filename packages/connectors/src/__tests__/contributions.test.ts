import { describe, expect, it, vi } from "vitest";
import { ConnectError, type ConnectorDefinition } from "@polpo-ai/connect";
import {
  createConnectorContributionRegistry,
  defineConnectorContribution,
  type ConnectorContribution,
} from "../contribution.js";

const definition = (patch: Partial<ConnectorDefinition> = {}): ConnectorDefinition => ({
  version: 2,
  id: "example",
  name: "Example",
  source: "catalog",
  protocol: "http_api",
  defaultAuthenticationId: "key",
  authentication: [{
    id: "key",
    type: "api_key",
    injection: { mode: "bearer" },
  }],
  scopes: [{ id: "items.read", label: "Read items" }],
  actions: [{
    id: "example_list_items",
    label: "List items",
    description: "List visible items.",
    scopes: ["items.read"],
    risk: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  }],
  http: {
    origins: ["https://api.example.com"],
    allowedMethods: ["GET"],
    allowedPathPatterns: ["/v1/items"],
  },
  ...patch,
} as ConnectorDefinition);

const contribution = (patch: Partial<ConnectorContribution> = {}) => defineConnectorContribution({
  definition: definition(),
  execute: async (_actionId, input, context) => context.request({
    method: "GET", path: "/v1/items", query: input as Record<string, string>,
  }),
  ...patch,
});

describe("Connector contributions", () => {
  it("derives an immutable tool catalog and dispatches a declared action through the host gateway", async () => {
    const registry = createConnectorContributionRegistry([contribution()]);
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: { items: [] } }));

    expect(registry.tools()).toEqual([{
      name: "example_list_items",
      providerId: "example",
      label: "List items",
      description: "List visible items.",
      parameters: definition().actions![0]!.inputSchema,
    }]);
    await expect(registry.execute("example_list_items", { limit: "10" }, { request }))
      .resolves.toMatchObject({ body: { items: [] } });
    expect(request).toHaveBeenCalledWith({
      actionId: "example_list_items",
      scopes: ["items.read"],
      request: { method: "GET", path: "/v1/items", query: { limit: "10" } },
    });
    expect(Object.isFrozen(registry.getByProvider("example")!.definition)).toBe(true);
    expect(Object.isFrozen(registry.tools()[0])).toBe(true);
  });

  it("rejects actionful HTTP contributions without an executor", () => {
    expect(() => defineConnectorContribution({ definition: definition() }))
      .toThrowError(/executor/i);
  });

  it("rejects executors for definitions without declared actions", () => {
    expect(() => defineConnectorContribution({
      definition: definition({ actions: [] }),
      execute: async () => null,
    })).toThrowError(/does not declare actions/i);
  });

  it("rejects duplicate provider and globally ambiguous action identifiers", () => {
    const first = contribution();
    expect(() => createConnectorContributionRegistry([first, first])).toThrowError(/duplicate connector contribution/i);

    const other = contribution({
      definition: definition({ id: "other", name: "Other" }),
    });
    expect(() => createConnectorContributionRegistry([first, other])).toThrowError(/duplicate connector action/i);
  });

  it("never dispatches unknown actions or a provider-mismatched contribution", async () => {
    const execute = vi.fn(async () => null);
    const registry = createConnectorContributionRegistry([contribution({ execute })]);

    await expect(registry.execute("example_delete_everything", {}, { request: vi.fn() }))
      .rejects.toMatchObject<Partial<ConnectError>>({ code: "invalid_request" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows definition-only MCP contributions because MCP tools are discovered at runtime", () => {
    const mcp = defineConnectorContribution({
      definition: {
        version: 2,
        id: "example_mcp",
        name: "Example MCP",
        source: "catalog",
        protocol: "mcp",
        defaultAuthenticationId: "public",
        authentication: [{ id: "public", type: "none" }],
      },
    });
    const registry = createConnectorContributionRegistry([mcp]);

    expect(registry.definitions().map((entry) => entry.id)).toEqual(["example_mcp"]);
    expect(registry.tools()).toEqual([]);
  });
});
