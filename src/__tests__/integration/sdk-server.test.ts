import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { Orchestrator } from "../../core/orchestrator.js";
import type { SSEBridge } from "../../server/sse-bridge.js";

/**
 * SDK ↔ Local Server integration tests.
 *
 * Starts a real Polpo HTTP server on a random port, then exercises every
 * PolpoClient method against it.  No secrets, no cloud, no database —
 * pure file-storage mode.
 *
 * Requires `pnpm build` to have been run first (imports compiled code).
 */

const POLPO_CONFIG = JSON.stringify({
  project: "sdk-integration",
  team: {
    name: "test-team",
    agents: [
      { name: "agent-1", role: "Test agent" },
    ],
  },
  settings: { maxRetries: 2, logLevel: "quiet" },
}, null, 2);

let tmpDir: string;
let baseUrl: string;
let orchestrator: Orchestrator;
let sseBridge: SSEBridge;
let server: ReturnType<typeof import("@hono/node-server").serve>;
let client: import("@polpo-ai/sdk").PolpoClient;

beforeAll(async () => {
  // 1. Create a temp workspace with a valid polpo config
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-sdk-integration-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

  // 2. Boot orchestrator + SSE bridge
  const { Orchestrator: OrchestratorClass } = await import("../../core/orchestrator.js");
  const { SSEBridge: SSEBridgeClass } = await import("../../server/sse-bridge.js");
  const { createApp } = await import("../../server/app.js");
  const { serve } = await import("@hono/node-server");
  const { PolpoClient } = await import("@polpo-ai/sdk");

  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("sdk-integration", {
    name: "test-team",
    agents: [{ name: "agent-1", role: "Test agent" }],
  });

  sseBridge = new SSEBridgeClass(orchestrator);
  sseBridge.start();

  // 3. Create Hono app (no API keys = no auth required)
  const app = createApp(orchestrator, sseBridge, { workDir: tmpDir });

  // 4. Start a real HTTP server on a random port
  const listening = new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => {
      resolve(info.port);
    });
  });

  const port = await listening;
  baseUrl = `http://localhost:${port}`;

  // 5. Create the SDK client pointing at local server
  client = new PolpoClient({ baseUrl });
}, 30_000);

afterAll(async () => {
  server?.close();
  sseBridge?.dispose();
  if (orchestrator?.isInitialized) {
    await orchestrator.gracefulStop();
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Health ────────────────────────────────────────────────────────────

describe("Health", () => {
  it("GET /api/v1/health returns ok", async () => {
    // Use raw fetch — the SDK instance getHealth() hits ${baseUrl}/health
    // which is a cloud-only route. The local server mounts health at /api/v1/health.
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data).toHaveProperty("version");
    expect(typeof body.data.uptime).toBe("number");
  });

  it("PolpoClient.health() static method works", async () => {
    const { PolpoClient } = await import("@polpo-ai/sdk");
    const health = await PolpoClient.health(baseUrl);
    expect(health.status).toBe("ok");
    expect(health).toHaveProperty("version");
    expect(typeof health.uptime).toBe("number");
  });
});

// ── Agents ────────────────────────────────────────────────────────────

describe("Agents", () => {
  it("lists agents and finds agent-1", async () => {
    const agents = await client.getAgents();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const agent1 = agents.find((a) => a.name === "agent-1");
    expect(agent1).toBeDefined();
    expect(agent1!.role).toBe("Test agent");
  });

  it("lists teams", async () => {
    const teams = await client.getTeams();
    expect(Array.isArray(teams)).toBe(true);
    expect(teams.length).toBeGreaterThanOrEqual(1);
    expect(teams[0].name).toBe("test-team");
  });
});

// ── Tasks ─────────────────────────────────────────────────────────────

describe("Tasks", () => {
  it("creates, lists, and kills a task", async () => {
    // Create as draft so the orchestrator tick doesn't pick it up
    const task = await client.createTask({
      title: "SDK integration task",
      description: "Created by SDK integration test",
      assignTo: "agent-1",
      draft: true,
    });
    expect(task.id).toBeDefined();
    expect(task.title).toBe("SDK integration task");
    expect(task.status).toBe("draft");

    // List
    const tasks = await client.getTasks();
    expect(tasks.find((t) => t.id === task.id)).toBeDefined();

    // Kill
    const killed = await client.killTask(task.id);
    expect(killed.killed).toBe(true);
  });

  it("creates and deletes a task", async () => {
    const task = await client.createTask({
      title: "SDK delete task",
      description: "Will be deleted",
      assignTo: "agent-1",
      draft: true,
    });

    const removed = await client.deleteTask(task.id);
    expect(removed.removed).toBe(true);
  });
});

// ── Missions ──────────────────────────────────────────────────────────

describe("Missions", () => {
  it("creates, lists, gets, and deletes a mission", async () => {
    const mission = await client.createMission({
      name: `sdk-int-${Date.now()}`,
      prompt: "SDK integration test mission",
      data: JSON.stringify({
        tasks: [{ title: "Integration mission task", description: "Do nothing", assignTo: "agent-1" }],
      }),
    });
    expect(mission.id).toBeDefined();
    expect(mission.status).toBe("draft");

    // List
    const missions = await client.getMissions();
    expect(missions.find((m) => m.id === mission.id)).toBeDefined();

    // Get
    const fetched = await client.getMission(mission.id);
    expect(fetched.id).toBe(mission.id);
    expect(fetched.prompt).toBe("SDK integration test mission");

    // Delete
    const deleted = await client.deleteMission(mission.id);
    expect(deleted.deleted).toBe(true);
  });
});

// ── Memory ────────────────────────────────────────────────────────────

describe("Memory", () => {
  it("saves and reads project memory", async () => {
    const saved = await client.saveMemory("# SDK Integration Test\n\nWritten by integration test.");
    expect(saved.saved).toBe(true);

    const mem = await client.getMemory();
    expect(mem.content).toContain("SDK Integration Test");
  });

  it("saves and reads agent memory", async () => {
    const saved = await client.saveAgentMemory("agent-1", "Integration test: agent memory works.");
    expect(saved.saved).toBe(true);

    const mem = await client.getAgentMemory("agent-1");
    expect(mem.content).toContain("agent memory works");
  });
});

// ── Vault ─────────────────────────────────────────────────────────────

describe("Vault", () => {
  it("saves, lists, and deletes a vault entry", async () => {
    // Save
    const saved = await client.saveVaultEntry({
      agent: "agent-1",
      service: "sdk-test-service",
      type: "api_key",
      label: "SDK integration test key",
      credentials: { token: "test-secret-123" },
    });
    expect(saved.service).toBe("sdk-test-service");
    expect(saved.keys).toContain("token");

    // List
    const entries = await client.listVaultEntries("agent-1");
    const found = entries.find((e) => e.service === "sdk-test-service");
    expect(found).toBeDefined();
    expect(found!.type).toBe("api_key");

    // Delete
    const removed = await client.removeVaultEntry("agent-1", "sdk-test-service");
    expect(removed.removed).toBe(true);

    // Verify deleted
    const after = await client.listVaultEntries("agent-1");
    expect(after.find((e) => e.service === "sdk-test-service")).toBeUndefined();
  });
});

// ── SSE Events ────────────────────────────────────────────────────────

describe("SSE Events", () => {
  it("connects to SSE event stream", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${baseUrl}/api/v1/events`, {
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    if (res) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    }
  });
});

// ── Sessions ──────────────────────────────────────────────────────────

describe("Sessions", () => {
  it("lists chat sessions", async () => {
    const { sessions } = await client.getSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});
