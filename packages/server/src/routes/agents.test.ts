import { describe, expect, it, vi } from "vitest";
import { agentRoutes } from "./agents.js";

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("agentRoutes", () => {
  it("passes the complete authored agent contract and body team to the store", async () => {
    const addAgent = vi.fn(async () => undefined);
    const app = agentRoutes(() => ({
      getAgents: async () => [],
      addAgent,
      removeAgent: async () => false,
      updateAgent: async () => undefined,
      getTeams: async () => [],
      getTeam: async () => undefined,
      addTeam: async () => undefined,
      removeTeam: async () => false,
      renameTeam: async () => undefined,
      taskStore: {},
      runStore: {},
      polpoDir: ".polpo",
    }));

    const response = await app.request("/", json({
      name: "builder",
      team: "product",
      role: "Builder",
      model: "openai/gpt-5",
      allowedPaths: ["/workspace"],
      allowedTools: ["bash"],
      maxConcurrency: 2,
      reasoning: "high",
      emailAllowedDomains: ["example.com"],
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp" },
      },
    }));

    expect(response.status).toBe(201);
    expect(addAgent).toHaveBeenCalledOnce();
    expect(addAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: "builder",
      role: "Builder",
      model: "openai/gpt-5",
      allowedPaths: ["/workspace"],
      allowedTools: ["bash"],
      maxConcurrency: 2,
      reasoning: "high",
      emailAllowedDomains: ["example.com"],
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp" },
      },
    }), "product");
  });

  it("keeps the query team override for existing API clients", async () => {
    const addAgent = vi.fn(async () => undefined);
    const app = agentRoutes(() => ({
      getAgents: async () => [],
      addAgent,
      removeAgent: async () => false,
      updateAgent: async () => undefined,
      getTeams: async () => [],
      getTeam: async () => undefined,
      addTeam: async () => undefined,
      removeTeam: async () => false,
      renameTeam: async () => undefined,
      taskStore: {},
      runStore: {},
      polpoDir: ".polpo",
    }));

    const response = await app.request("/?team=query-team", json({
      name: "builder",
      team: "body-team",
    }));

    expect(response.status).toBe(201);
    expect(addAgent).toHaveBeenCalledWith(expect.any(Object), "query-team");
  });
});
