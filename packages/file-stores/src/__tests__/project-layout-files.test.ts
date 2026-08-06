import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAgentStore } from "../file-agent-store.js";
import { FileTeamStore } from "../file-team-store.js";
import {
  detectAgentLayout,
  migrateProjectLayoutV2,
  readProjectAgents,
  readProjectTeams,
} from "../project-layout-files.js";

describe("directory project layout", () => {
  let polpoDir: string;

  beforeEach(() => {
    polpoDir = mkdtempSync(join(tmpdir(), "polpo-layout-v2-"));
  });

  afterEach(() => {
    rmSync(polpoDir, { recursive: true, force: true });
  });

  function writeAgent(
    name: string,
    definition: Record<string, unknown> = {},
    instructions = "",
  ): void {
    const directory = join(polpoDir, "agents", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "agent.json"), JSON.stringify(definition), "utf-8");
    writeFileSync(join(directory, "instructions.md"), instructions, "utf-8");
  }

  it("loads agents from isolated directories in stable order", () => {
    writeAgent("support", { role: "Support", team: "success" }, "Help users.\n");
    writeAgent("builder", { role: "Builder", maxTurns: 25 }, "Build products.\n");

    expect(readProjectAgents(polpoDir)).toEqual([
      {
        agent: {
          name: "builder",
          role: "Builder",
          maxTurns: 25,
          systemPrompt: "Build products.\n",
        },
        teamName: "default",
      },
      {
        agent: {
          name: "support",
          role: "Support",
          systemPrompt: "Help users.\n",
        },
        teamName: "success",
      },
    ]);
  });

  it("keeps legacy projects readable and rejects mixed authority", () => {
    writeFileSync(join(polpoDir, "agents.json"), JSON.stringify([
      { agent: { name: "legacy" }, teamName: "default" },
    ]));
    expect(readProjectAgents(polpoDir)[0]?.agent.name).toBe("legacy");

    writeAgent("new-agent");
    expect(() => readProjectAgents(polpoDir)).toThrow(
      "Both .polpo/agents.json and directory-based agent definitions exist",
    );
  });

  it("reads historical wrapped and direct legacy agent entries", () => {
    writeFileSync(join(polpoDir, "agents.json"), JSON.stringify([
      { agent: { name: "wrapped" } },
      { name: "direct", role: "Worker" },
    ]));

    expect(readProjectAgents(polpoDir)).toEqual([
      { agent: { name: "wrapped" }, teamName: "default" },
      { agent: { name: "direct", role: "Worker" }, teamName: "default" },
    ]);
  });

  it("does not confuse legacy per-agent skill directories with v2 definitions", () => {
    writeFileSync(join(polpoDir, "agents.json"), JSON.stringify([
      { agent: { name: "legacy" }, teamName: "default" },
    ]));
    mkdirSync(join(polpoDir, "agents", "legacy", "skills"), { recursive: true });
    expect(detectAgentLayout(polpoDir)).toBe("legacy");
  });

  it("surfaces malformed JSON and missing instructions instead of hiding agents", () => {
    const broken = join(polpoDir, "agents", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "agent.json"), "{broken", "utf-8");
    writeFileSync(join(broken, "instructions.md"), "", "utf-8");
    expect(() => readProjectAgents(polpoDir)).toThrow(/Could not parse agent "broken"/);

    rmSync(broken, { recursive: true });
    const incomplete = join(polpoDir, "agents", "incomplete");
    mkdirSync(incomplete, { recursive: true });
    writeFileSync(join(incomplete, "agent.json"), "{}", "utf-8");
    expect(() => readProjectAgents(polpoDir)).toThrow(
      'Agent "incomplete" is missing instructions.md',
    );
  });

  it("rejects ids that collide on case-insensitive filesystems", () => {
    writeAgent("Support");
    writeAgent("support");
    expect(() => readProjectAgents(polpoDir)).toThrow(/collide on case-insensitive filesystems/);
  });

  it("FileAgentStore writes config and instructions separately and atomically", async () => {
    mkdirSync(join(polpoDir, "agents"));
    const store = new FileAgentStore(polpoDir);
    await store.createAgent({
      name: "builder",
      role: "Builder",
      systemPrompt: "Build carefully.\n",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, "product");

    const directory = join(polpoDir, "agents", "builder");
    const definition = JSON.parse(readFileSync(join(directory, "agent.json"), "utf-8"));
    expect(definition).toEqual({ role: "Builder", team: "product" });
    expect(readFileSync(join(directory, "instructions.md"), "utf-8"))
      .toBe("Build carefully.\n");
    expect(readdirSync(directory).some((name) => name.endsWith(".tmp"))).toBe(false);

    await store.updateAgent("builder", {
      role: "Senior builder",
      systemPrompt: "Ship tested work.\n",
    });
    expect((await store.getAgent("builder"))?.role).toBe("Senior builder");
    expect(readFileSync(join(directory, "instructions.md"), "utf-8"))
      .toBe("Ship tested work.\n");
  });

  it("deletes only owned agent files and preserves adjacent agent assets", async () => {
    mkdirSync(join(polpoDir, "agents"));
    const store = new FileAgentStore(polpoDir);
    await store.createAgent({ name: "builder" }, "default");
    const evals = join(polpoDir, "agents", "builder", "evals");
    mkdirSync(evals);
    writeFileSync(join(evals, "smoke.json"), "{}", "utf-8");

    expect(await store.deleteAgent("builder")).toBe(true);
    expect(existsSync(join(polpoDir, "agents", "builder", "agent.json"))).toBe(false);
    expect(existsSync(join(evals, "smoke.json"))).toBe(true);
  });

  it("loads and updates directory-based teams", async () => {
    mkdirSync(join(polpoDir, "teams"));
    const store = new FileTeamStore(polpoDir);
    await store.createTeam({ name: "platform", description: "Core", agents: [] });
    expect(readProjectTeams(polpoDir)).toEqual([
      { name: "platform", description: "Core", agents: [] },
    ]);
    expect(JSON.parse(readFileSync(join(polpoDir, "teams", "platform.json"), "utf-8")))
      .toEqual({ description: "Core" });

    await store.updateTeam("platform", { description: "Runtime" });
    expect((await store.getTeam("platform"))?.description).toBe("Runtime");

    await store.renameTeam("platform", "runtime");
    expect(existsSync(join(polpoDir, "teams", "platform.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(polpoDir, "teams", "runtime.json"), "utf-8")))
      .toEqual({ description: "Runtime" });
    expect((await store.getTeam("runtime"))?.description).toBe("Runtime");
  });

  it("dry-runs and atomically migrates legacy manifests without losing adjacent assets", () => {
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "demo" }));
    writeFileSync(join(polpoDir, "agents.json"), JSON.stringify([
      {
        agent: {
          name: "builder",
          role: "Builder",
          systemPrompt: "Build.\n",
          allowedTools: ["bash"],
        },
        teamName: "product",
      },
    ]));
    writeFileSync(join(polpoDir, "teams.json"), JSON.stringify([
      { name: "product", description: "Product", agents: [] },
    ]));
    const skills = join(polpoDir, "agents", "builder", "skills");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, "README.md"), "keep", "utf-8");

    const preview = migrateProjectLayoutV2(polpoDir, { dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      changed: true,
      agents: 1,
      teams: 1,
      projectConfig: true,
    });
    expect(existsSync(join(polpoDir, "project.json"))).toBe(false);
    expect(existsSync(join(polpoDir, "agents.json"))).toBe(true);

    const migrated = migrateProjectLayoutV2(polpoDir);
    expect(migrated.dryRun).toBe(false);
    expect(readProjectAgents(polpoDir)[0]).toMatchObject({
      agent: { name: "builder", role: "Builder", systemPrompt: "Build.\n" },
      teamName: "product",
    });
    expect(readProjectTeams(polpoDir)[0]).toMatchObject({
      name: "product",
      description: "Product",
    });
    expect(JSON.parse(readFileSync(join(polpoDir, "project.json"), "utf-8")))
      .toEqual({ project: "demo", schemaVersion: 2 });
    expect(readFileSync(join(skills, "README.md"), "utf-8")).toBe("keep");
    expect(existsSync(join(polpoDir, "agents.v1.json"))).toBe(true);
    expect(existsSync(join(polpoDir, "teams.v1.json"))).toBe(true);
    expect(existsSync(join(polpoDir, "polpo.v1.json"))).toBe(true);
  });

  it("archives a leftover legacy project config without overwriting project.json", () => {
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({ project: "legacy" }));
    writeFileSync(
      join(polpoDir, "project.json"),
      JSON.stringify({ schemaVersion: 2, project: "current" }),
    );

    expect(migrateProjectLayoutV2(polpoDir)).toMatchObject({
      changed: true,
      projectConfig: true,
    });
    expect(JSON.parse(readFileSync(join(polpoDir, "project.json"), "utf-8")))
      .toEqual({ schemaVersion: 2, project: "current" });
    expect(JSON.parse(readFileSync(join(polpoDir, "polpo.v1.json"), "utf-8")))
      .toEqual({ project: "legacy" });
    expect(existsSync(join(polpoDir, "polpo.json"))).toBe(false);
  });

  it("leaves legacy authority untouched when migration validation fails", () => {
    writeFileSync(join(polpoDir, "agents.json"), JSON.stringify([
      { agent: { name: "../escape" }, teamName: "default" },
    ]));
    expect(() => migrateProjectLayoutV2(polpoDir)).toThrow(/Invalid agent id/);
    expect(existsSync(join(polpoDir, "agents.json"))).toBe(true);
    expect(existsSync(join(polpoDir, "agents", "..", "escape", "agent.json"))).toBe(false);
    expect(existsSync(join(polpoDir, "agents.v1.json"))).toBe(false);
  });
});
