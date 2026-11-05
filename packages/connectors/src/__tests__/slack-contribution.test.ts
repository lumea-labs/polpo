import { describe, expect, it, vi } from "vitest";
import { type ConnectorActionGateway } from "@polpo-ai/connect";
import { createConnectorContributionRegistry } from "../contribution.js";
import { slackContribution } from "../contributions/slack/index.js";

describe("Slack Connector contribution", () => {
  it("lists conversations through the gateway with bounded pagination", async () => {
    const request = vi.fn<ConnectorActionGateway>(async () => ({
      status: 200,
      headers: {},
      body: { ok: true, channels: [] },
    }));
    const contributions = createConnectorContributionRegistry([slackContribution]);

    await expect(contributions.execute("slack_list_channels", {
      limit: 999, cursor: "next", types: "public_channel",
    }, { request })).resolves.toMatchObject({ ok: true });
    expect(request).toHaveBeenCalledWith({
      actionId: "slack_list_channels",
      scopes: ["channels:read"],
      request: {
        method: "GET",
        path: "/api/conversations.list",
        query: { limit: "200", types: "public_channel", cursor: "next" },
      },
    });
  });

  it("keeps Slack API failures provider-local and does not retry another connection", async () => {
    const request = vi.fn<ConnectorActionGateway>(async () => ({
      status: 200,
      headers: {},
      body: { ok: false, error: "channel_not_found" },
    }));
    const contributions = createConnectorContributionRegistry([slackContribution]);

    await expect(contributions.execute("slack_send_message", {
      channel: "C123", text: "Hello",
    }, { request })).rejects.toMatchObject({ code: "http_error", status: 502 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
