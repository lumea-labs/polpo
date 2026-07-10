import { describe, expect, it } from "vitest";
import { createConnectorRegistry } from "@polpo-ai/connect";
import { createGenericOAuthConnector, defaultConnectors, githubConnector, googleDriveConnector, mcpUrlConnector, slackConnector } from "../index.js";

describe("curated connectors", () => {
  it("has unique valid provider definitions", () => {
    const registry = createConnectorRegistry(defaultConnectors);
    expect(registry.list().map((provider) => provider.id)).toEqual(["api_key", "github", "slack", "google_drive", "mcp_url"]);
  });

  it("declares actions only with scopes supported by each provider", () => {
    for (const provider of defaultConnectors) {
      const scopeIds = new Set((provider.scopes ?? []).map((scope) => scope.id));
      for (const action of provider.actions ?? []) {
        for (const scope of action.scopes ?? []) {
          expect(scopeIds.has(scope), `${provider.id}.${action.id} references unknown scope ${scope}`).toBe(true);
        }
      }
    }
  });

  it("covers GitHub, Slack, Drive, and MCP with agent-facing actions", () => {
    expect(githubConnector.actions?.map((action) => action.id)).toContain("github_create_issue");
    expect(slackConnector.actions?.map((action) => action.id)).toContain("slack_send_message");
    expect(googleDriveConnector.actions?.map((action) => action.id)).toContain("drive_search_files");
    expect(mcpUrlConnector.actions?.map((action) => action.id)).toContain("mcp_call_tool");
  });

  it("allows generic OAuth connectors to define custom scopes", () => {
    const provider = createGenericOAuthConnector({
      id: "custom_crm",
      name: "Custom CRM",
      authorizationUrl: "https://crm.example/oauth/authorize",
      tokenUrl: "https://crm.example/oauth/token",
      defaultScopes: ["contacts.read"],
    });
    const registry = createConnectorRegistry([provider]);

    expect(registry.validateScopes("custom_crm", ["contacts.write", "contacts.read"])).toEqual(["contacts.read", "contacts.write"]);
  });
});
