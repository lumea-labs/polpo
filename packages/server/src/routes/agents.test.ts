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
      updateTeam: async () => undefined,
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
      updateTeam: async () => undefined,
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

function routeDeps() {
  const agents: Record<string, unknown>[] = [];
  const addAgent = vi.fn(async (agent: Record<string, unknown>) => {
    agents.push(agent);
  });
  const updateAgent = vi.fn(async (name: string, updates: Record<string, unknown>) => {
    const index = agents.findIndex((agent) => agent.name === name);
    if (index >= 0) agents[index] = { ...agents[index], ...updates };
    return agents[index];
  });
  return {
    agents,
    addAgent,
    updateAgent,
    getDeps: () => ({
      getAgents: async () => agents,
      addAgent,
      updateAgent,
      removeAgent: async () => true,
      getTeams: async () => [],
      getTeam: async () => undefined,
      addTeam: async () => {},
      updateTeam: async () => undefined,
      removeTeam: async () => true,
      renameTeam: async () => {},
      taskStore: {},
      runStore: {},
      polpoDir: ".polpo",
    }),
  };
}

describe("agent chat preferences routes", () => {
  it("persists chat preferences when creating an agent", async () => {
    const deps = routeDeps();
    const app = agentRoutes(deps.getDeps);
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "support",
        chat: {
          allowUserQuestions: false,
          suggestions: { enabled: true, maxItems: 4 },
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(deps.addAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "support",
        chat: {
          allowUserQuestions: false,
          suggestions: { enabled: true, maxItems: 4 },
        },
      }),
      undefined,
    );
  });

  it("persists chat preferences when updating an agent", async () => {
    const deps = routeDeps();
    deps.agents.push({ name: "support", role: "Support" });
    const app = agentRoutes(deps.getDeps);
    const response = await app.request("/support", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat: {
          allowUserQuestions: true,
          suggestions: { enabled: false, maxItems: 3 },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(deps.updateAgent).toHaveBeenCalledWith("support", {
      chat: {
        allowUserQuestions: true,
        suggestions: { enabled: false, maxItems: 3 },
      },
    });
  });
});

describe("agent team metadata routes", () => {
  it("updates an existing team without invoking the rename contract", async () => {
    const updateTeam = vi.fn(async (name: string, updates: { description?: string }) => ({
      name,
      description: updates.description,
      agents: [],
    }));
    const renameTeam = vi.fn(async () => undefined);
    const app = agentRoutes(() => ({
      getAgents: async () => [],
      addAgent: async () => undefined,
      removeAgent: async () => false,
      updateAgent: async () => undefined,
      getTeams: async () => [],
      getTeam: async () => undefined,
      addTeam: async () => undefined,
      updateTeam,
      removeTeam: async () => false,
      renameTeam,
      taskStore: {},
      runStore: {},
      polpoDir: ".polpo",
    }));

    const response = await app.request("/teams/product", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "Updated description" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { name: "product", description: "Updated description" },
    });
    expect(updateTeam).toHaveBeenCalledWith("product", {
      description: "Updated description",
    });
    expect(renameTeam).not.toHaveBeenCalled();
  });
});
