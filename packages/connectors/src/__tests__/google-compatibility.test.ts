import { describe, expect, it, vi } from "vitest";
import {
  createConnectorRegistry,
  resolveConnectorHttpRequest,
  type ConnectorActionGateway,
} from "@polpo-ai/connect";
import {
  executeGoogleAction,
  gmailDefinition,
  googleDriveDefinition,
} from "../google.js";

describe("Google Connector compatibility exports", () => {
  it("declares read-only API capabilities without OAuth client credentials", () => {
    const registry = createConnectorRegistry([gmailDefinition, googleDriveDefinition]);
    expect(registry.catalog().map((entry) => [entry.id, entry.protocol]))
      .toEqual([["gmail", "http_api"], ["google_drive", "http_api"]]);
    for (const provider of registry.list()) {
      expect(provider.http?.allowedMethods).toEqual(["GET"]);
      expect(() => resolveConnectorHttpRequest(provider.http!, {
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
      })).toThrow();
      expect(JSON.stringify(provider)).not.toMatch(/clientSecret|clientId|accessToken|refreshToken/);
    }
  });

  it("rejects unknown legacy Google actions before gateway access", async () => {
    const request = vi.fn<ConnectorActionGateway>();
    await expect(executeGoogleAction("drive_send_file", {}, { request }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });
});
