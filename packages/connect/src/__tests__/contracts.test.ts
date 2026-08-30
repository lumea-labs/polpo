import { describe, expect, it } from "vitest";

import type {
  ConnectionLink,
  ConnectionRecord,
  ConnectionSetupSession,
  ConnectorProviderDefinition,
  OAuthClientRecord,
} from "../index.js";

describe("Connection platform contracts", () => {
  it("keeps legacy project-owned Connection records readable", () => {
    const legacy: ConnectionRecord = {
      id: "connection-1",
      providerId: "github",
      projectId: "project-1",
      owner: { type: "user", id: "user-1" },
      authType: "oauth2",
      status: "active",
      grantedScopes: ["repo:read"],
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    };

    expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
    expect(legacy.audience).toBeUndefined();
  });

  it("represents one installation linked to projects without duplicating its secret", () => {
    const connection: ConnectionRecord = {
      id: "connection-shared",
      providerId: "github",
      orgId: "org-1",
      owner: { type: "org", id: "org-1" },
      audience: "shared",
      oauthClientId: "oauth-client-1",
      providerAccountId: "installation-42",
      credentialVersion: "7",
      authType: "oauth2",
      status: "active",
      grantedScopes: ["repo:read"],
      secretRef: "secret-1",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    const links: ConnectionLink[] = ["project-1", "project-2"].map((projectId) => ({
      id: `link-${projectId}`,
      connectionId: connection.id,
      projectId,
      status: "active",
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
    }));

    expect(connection.projectId).toBeUndefined();
    expect(new Set(links.map((link) => link.connectionId))).toEqual(new Set([connection.id]));
    expect(links.map((link) => link.projectId)).toEqual(["project-1", "project-2"]);
  });

  it("separates Connector protocol metadata from OAuth client ownership", () => {
    const connector: ConnectorProviderDefinition = {
      id: "github",
      name: "GitHub",
      auth: {
        type: "oauth2",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
      },
      http: {
        origins: ["https://api.github.com"],
        allowedMethods: ["GET", "POST"],
        allowedPathPatterns: ["/repos/*"],
        auth: { mode: "bearer" },
      },
    };
    const oauthClient: OAuthClientRecord = {
      id: "oauth-client-1",
      providerId: connector.id,
      owner: { type: "org", id: "org-1" },
      status: "active",
      clientId: "client-id",
      secretRef: "oauth-client-secret-1",
      redirectUris: ["https://polpo.sh/v1/connect/oauth/callback"],
    };

    expect(connector.auth).not.toHaveProperty("clientSecret");
    expect(oauthClient.secretRef).toBe("oauth-client-secret-1");
  });

  it("captures immutable end-user setup intent independently from browser input", () => {
    const setup: ConnectionSetupSession = {
      id: "setup-1",
      providerId: "github",
      oauthClientId: "oauth-client-1",
      projectId: "project-1",
      audience: "end_user",
      subject: { type: "external_user", namespace: "acme", id: "user-42" },
      binding: {
        tenant: { namespace: "acme", id: "tenant-1" },
        resource: { namespace: "acme", type: "workspace", id: "workspace-1" },
        scopeEpoch: "3",
      },
      scopes: ["repo:read"],
      returnUrl: "https://app.example/settings/integrations",
      expiresAt: "2026-08-31T00:10:00.000Z",
      createdAt: "2026-08-31T00:00:00.000Z",
    };

    expect(setup.subject).toEqual({
      type: "external_user",
      namespace: "acme",
      id: "user-42",
    });
    expect(setup.audience).toBe("end_user");
  });
});
