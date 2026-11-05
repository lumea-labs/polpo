import { describe, expect, it, vi } from "vitest";
import { createConnectorRegistry, type ConnectorActionGateway } from "@polpo-ai/connect";
import { createConnectorContributionRegistry } from "../contribution.js";
import { githubContribution } from "../contributions/github/index.js";

describe("GitHub Connector contribution", () => {
  it("owns its complete definition and executes only through the authorized gateway", async () => {
    const registry = createConnectorRegistry([githubContribution.definition]);
    const contributions = createConnectorContributionRegistry([githubContribution]);
    const request = vi.fn<ConnectorActionGateway>(async () => ({
      status: 200,
      headers: {},
      body: [{ id: 1, full_name: "polpo/example" }],
    }));

    expect(registry.catalog()[0]).toMatchObject({ id: "github", protocol: "http_api" });
    await expect(contributions.execute("github_list_repos", { perPage: 40, page: 2 }, { request }))
      .resolves.toEqual([{ id: 1, full_name: "polpo/example" }]);
    expect(request).toHaveBeenCalledWith({
      actionId: "github_list_repos",
      scopes: ["repo"],
      request: {
        method: "GET",
        path: "/user/repos",
        query: { per_page: "40", page: "2", affiliation: "owner,collaborator,organization_member" },
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      },
    });
  });

  it("encodes repository paths and decodes file content without receiving a credential", async () => {
    const request = vi.fn<ConnectorActionGateway>(async () => ({
      status: 200,
      headers: {},
      body: { path: "docs/a b.md", encoding: "base64", content: "SGVsbG8=" },
    }));
    const contributions = createConnectorContributionRegistry([githubContribution]);

    await expect(contributions.execute("github_read_file", {
      owner: "lumea labs", repo: "polpo/core", path: "docs/a b.md", ref: "feature/test",
    }, { request })).resolves.toMatchObject({ contentText: "Hello" });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        path: "/repos/lumea%20labs/polpo%2Fcore/contents/docs/a%20b.md",
        query: { ref: "feature/test" },
      }),
    }));
  });

  it("rejects unsupported actions before gateway access", async () => {
    const request = vi.fn<ConnectorActionGateway>();
    const contributions = createConnectorContributionRegistry([githubContribution]);
    await expect(contributions.execute("github_delete_repo", {}, { request }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });
});
