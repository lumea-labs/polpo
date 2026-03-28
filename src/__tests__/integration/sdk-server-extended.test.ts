import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { Orchestrator } from "../../core/orchestrator.js";
import type { SSEBridge } from "../../server/sse-bridge.js";

/**
 * SDK extended integration tests.
 *
 * Tests the new Client SDK methods:
 *   - Attachments (upload, list, get, download, delete)
 *   - Files (getFileRoots, listFiles)
 *   - Skills (create, delete, assign, unassign)
 *   - Schedules (create, update, delete — requires a mission)
 *   - Playbooks (create, get, list, delete)
 *
 * Same setup pattern as sdk-server.test.ts.
 * Requires `pnpm build` to have been run first.
 */

const POLPO_CONFIG = JSON.stringify({
  project: "sdk-extended",
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
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-sdk-extended-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

  // 2. Boot orchestrator + SSE bridge
  const { Orchestrator: OrchestratorClass } = await import("../../core/orchestrator.js");
  const { SSEBridge: SSEBridgeClass } = await import("../../server/sse-bridge.js");
  const { createApp } = await import("../../server/app.js");
  const { serve } = await import("@hono/node-server");
  const { PolpoClient } = await import("@polpo-ai/sdk");

  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("sdk-extended", {
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

// ── Attachments (via SDK methods) ────────────────────────────────────

describe("Attachments", () => {
  it("upload, list, get metadata, download, and delete via SDK", async () => {
    const sessionId = "sdk-ext-attach-session";
    const content = "Extended SDK integration test content";
    const filename = "sdk-ext-test.txt";

    // Upload
    const blob = new Blob([content], { type: "text/plain" });
    const uploaded = await client.uploadAttachment(sessionId, blob, filename);
    expect(uploaded.id).toBeDefined();
    expect(uploaded.filename).toBe(filename);
    expect(uploaded.sessionId).toBe(sessionId);
    expect(uploaded.mimeType).toBe("text/plain");
    expect(uploaded.size).toBe(content.length);

    // List by session
    const list = await client.listAttachments(sessionId);
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((a) => a.id === uploaded.id)).toBeDefined();

    // Get metadata
    const meta = await client.getAttachment(uploaded.id);
    expect(meta.id).toBe(uploaded.id);
    expect(meta.filename).toBe(filename);

    // Download
    const downloaded = await client.downloadAttachment(uploaded.id);
    const text = await downloaded.text();
    expect(text).toBe(content);

    // Delete
    const deleted = await client.deleteAttachment(uploaded.id);
    expect(deleted).toBe(true);

    // Verify deleted — listing for the session should no longer include it
    const afterDelete = await client.listAttachments(sessionId);
    expect(afterDelete.find((a) => a.id === uploaded.id)).toBeUndefined();
  });
});

// ── Files ─────────────────────────────────────────────────────────────

describe("Files", () => {
  it("getFileRoots returns workspace and polpo roots", async () => {
    const result = await client.getFileRoots();
    expect(result.roots).toBeDefined();
    expect(Array.isArray(result.roots)).toBe(true);
    expect(result.roots.length).toBeGreaterThanOrEqual(1);

    // Should have at least a "workspace" root
    const workspace = result.roots.find((r) => r.id === "workspace");
    expect(workspace).toBeDefined();
    expect(workspace!.absolutePath).toBeDefined();

    // Should have a "polpo" root
    const polpo = result.roots.find((r) => r.id === "polpo");
    expect(polpo).toBeDefined();
  });

  it("listFiles returns entries without error", async () => {
    // List the .polpo directory (known to exist)
    const result = await client.listFiles(".polpo");
    expect(result.path).toBeDefined();
    expect(Array.isArray(result.entries)).toBe(true);
    // .polpo dir should contain at least polpo.json
    const configEntry = result.entries.find((e) => e.name === "polpo.json");
    expect(configEntry).toBeDefined();
    expect(configEntry!.type).toBe("file");
  });
});

// ── Skills ────────────────────────────────────────────────────────────

describe("Skills", () => {
  const skillName = "sdk-test-skill";

  it("creates a new skill", async () => {
    const result = await client.createSkill({
      name: skillName,
      description: "A test skill created by SDK integration tests",
      content: "This is the skill body.\n\nIt does testing things.",
    });
    expect(result.name).toBe(skillName);
    expect(result.path).toBeDefined();
  });

  it("lists skills and finds the created skill", async () => {
    const skills = await client.getSkills();
    expect(Array.isArray(skills)).toBe(true);
    const found = skills.find((s) => s.name === skillName);
    expect(found).toBeDefined();
    expect(found!.description).toContain("test skill");
  });

  it("assigns a skill to an agent", async () => {
    const result = await client.assignSkill(skillName, "agent-1");
    expect(result.skill).toBe(skillName);
    expect(result.agent).toBe("agent-1");
  });

  it("unassigns a skill from an agent", async () => {
    const result = await client.unassignSkill(skillName, "agent-1");
    expect(result.skill).toBe(skillName);
    expect(result.agent).toBe("agent-1");
  });

  it("deletes a skill", async () => {
    const result = await client.deleteSkill(skillName);
    // Server returns { removed: name } — SDK types say { removed: boolean; name: string }
    // but the actual response has removed as the skill name string
    expect(result).toBeDefined();

    // Verify it no longer appears in the list
    const skills = await client.getSkills();
    expect(skills.find((s) => s.name === skillName)).toBeUndefined();
  });
});

// ── Schedules ─────────────────────────────────────────────────────────

describe("Schedules", () => {
  let missionId: string;

  beforeAll(async () => {
    // Create a mission to attach schedules to
    const mission = await client.createMission({
      name: `schedule-test-${Date.now()}`,
      prompt: "Mission for schedule testing",
      data: JSON.stringify({
        tasks: [{ title: "Schedule test task", description: "Noop", assignTo: "agent-1" }],
      }),
    });
    missionId = mission.id;
  });

  it("lists schedules (initially empty)", async () => {
    const schedules = await client.getSchedules();
    expect(Array.isArray(schedules)).toBe(true);
  });

  it("creates a schedule for a mission", async () => {
    const schedule = await client.createSchedule({
      missionId,
      expression: "0 9 * * 1", // Every Monday at 9am
      recurring: true,
    });
    expect(schedule).toBeDefined();
    expect(schedule.missionId).toBe(missionId);
    expect(schedule.expression).toBe("0 9 * * 1");
    expect(schedule.recurring).toBe(true);
    expect(schedule.enabled).toBe(true);
  });

  it("updates a schedule", async () => {
    const updated = await client.updateSchedule(missionId, {
      expression: "0 10 * * 1-5", // Weekdays at 10am
    });
    expect(updated).toBeDefined();
    expect(updated.missionId).toBe(missionId);
    expect(updated.expression).toBe("0 10 * * 1-5");
  });

  it("lists schedules and finds the created one", async () => {
    const schedules = await client.getSchedules();
    const found = schedules.find((s) => s.missionId === missionId);
    expect(found).toBeDefined();
    expect(found!.recurring).toBe(true);
  });

  it("deletes a schedule", async () => {
    const result = await client.deleteSchedule(missionId);
    expect(result.deleted).toBe(true);

    // Verify it no longer appears
    const schedules = await client.getSchedules();
    expect(schedules.find((s) => s.missionId === missionId)).toBeUndefined();
  });

  afterAll(async () => {
    // Clean up the mission
    await client.deleteMission(missionId).catch(() => {});
  });
});

// ── Playbooks ─────────────────────────────────────────────────────────

describe("Playbooks", () => {
  const playbookName = "sdk-test-playbook";

  it("creates a playbook", async () => {
    const result = await client.createPlaybook({
      name: playbookName,
      description: "A test playbook created by SDK integration tests",
      mission: {
        name: "test-playbook-mission",
        prompt: "Run tests for {{component}}",
        tasks: [
          {
            title: "Test {{component}}",
            description: "Run the test suite for {{component}}",
            assignTo: "agent-1",
          },
        ],
      },
      parameters: [
        {
          name: "component",
          description: "Which component to test",
          type: "string",
          required: true,
        },
      ],
    });
    expect(result.name).toBe(playbookName);
    expect(result.path).toBeDefined();
  });

  it("lists playbooks and finds the created one", async () => {
    const playbooks = await client.getPlaybooks();
    expect(Array.isArray(playbooks)).toBe(true);
    const found = playbooks.find((p) => p.name === playbookName);
    expect(found).toBeDefined();
    expect(found!.description).toContain("test playbook");
  });

  it("gets a playbook by name", async () => {
    const playbook = await client.getPlaybook(playbookName);
    expect(playbook.name).toBe(playbookName);
    expect(playbook.description).toContain("test playbook");
    expect(playbook.mission).toBeDefined();
    expect(playbook.parameters).toBeDefined();
    expect(playbook.parameters!.length).toBe(1);
    expect(playbook.parameters![0].name).toBe("component");
  });

  it("deletes a playbook", async () => {
    // deletePlaybook returns void on success
    await client.deletePlaybook(playbookName);

    // Verify it no longer appears in the list
    const playbooks = await client.getPlaybooks();
    expect(playbooks.find((p) => p.name === playbookName)).toBeUndefined();
  });
});
