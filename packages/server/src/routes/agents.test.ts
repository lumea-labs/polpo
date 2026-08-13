import { describe, expect, it, vi } from "vitest";
import { agentRoutes } from "./agents.js";

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
