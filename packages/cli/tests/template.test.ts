import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TEMPLATES,
  findTemplate,
  writeBlankScaffold,
} from "../src/util/template.js";
import { SCENARIOS, findScenario } from "../src/util/scenarios.js";
import { parseMissionDocument } from "@polpo-ai/core/schemas";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "polpo-template-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("TEMPLATES", () => {
  it("contains at least one blank template", () => {
    expect(TEMPLATES.some((t) => t.kind === "blank")).toBe(true);
  });

  it("contains at least one remote template", () => {
    expect(TEMPLATES.some((t) => t.kind === "remote")).toBe(true);
  });

  it("every entry has a non-empty id and label", () => {
    for (const t of TEMPLATES) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("remote templates declare installsDeps (they run npm install)", () => {
    for (const t of TEMPLATES.filter((x) => x.kind === "remote")) {
      expect(t.installsDeps).toBe(true);
    }
  });

  it("includes the canonical 'empty' blank template", () => {
    const blank = TEMPLATES.find((t) => t.id === "empty");
    expect(blank).toBeDefined();
    expect(blank?.kind).toBe("blank");
  });
});

describe("findTemplate", () => {
  it("returns the template for a known id", () => {
    const t = findTemplate("empty");
    expect(t).toBeDefined();
    expect(t?.id).toBe("empty");
  });

  it("returns undefined for unknown id", () => {
    expect(findTemplate("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(findTemplate("")).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(findTemplate("Empty")).toBeUndefined();
    expect(findTemplate("EMPTY")).toBeUndefined();
  });

  it("finds each registered template by its declared id", () => {
    for (const t of TEMPLATES) {
      expect(findTemplate(t.id)).toBe(t);
    }
  });
});

describe("writeBlankScaffold", () => {
  it("creates all 5 expected files", () => {
    writeBlankScaffold(tmpDir, "my-project");
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "polpo.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "teams.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "agents.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".env.local.example"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "README.md"))).toBe(true);
  });

  it("writes polpo.json with the project name", () => {
    writeBlankScaffold(tmpDir, "my-project");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".polpo", "polpo.json"), "utf-8"),
    );
    expect(cfg).toEqual({ project: "my-project" });
  });

  it("writes teams.json with a single default team", () => {
    writeBlankScaffold(tmpDir, "x");
    const teams = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".polpo", "teams.json"), "utf-8"),
    );
    expect(Array.isArray(teams)).toBe(true);
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual({
      name: "default",
      description: "Default team",
    });
  });

  it("writes agents.json in canonical array-of-wrapped format [{agent, teamName}]", () => {
    writeBlankScaffold(tmpDir, "x");
    const agents = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".polpo", "agents.json"), "utf-8"),
    );
    expect(Array.isArray(agents)).toBe(true);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toHaveProperty("agent");
    expect(agents[0]).toHaveProperty("teamName");
    expect(agents[0].teamName).toBe("default");
    expect(agents[0].agent.name).toBe("agent-1");
    expect(agents[0].agent.role).toBe("helpful assistant");
    expect(agents[0].agent.model).toBe("xai/grok-4.1-fast-non-reasoning");
    // Full demo-ready palette — assert a representative subset covering
    // every category (core + each extended group via wildcards).
    expect(agents[0].agent.allowedTools).toEqual(expect.arrayContaining([
      "bash", "read", "write", "edit", "glob", "grep", "ls",
      "http_*", "browser_*", "search_*", "vault_*",
      "image_*", "audio_*", "pdf_*", "docx_*", "excel_*", "email_*",
    ]));
  });

  it("writes .env.local.example with POLPO_API_KEY placeholder", () => {
    writeBlankScaffold(tmpDir, "x");
    const env = fs.readFileSync(
      path.join(tmpDir, ".env.local.example"),
      "utf-8",
    );
    expect(env).toContain("POLPO_API_KEY=");
    expect(env).toContain("POLPO_URL=https://your-project-slug.polpo.cloud");
  });

  it("writes README.md with the project name as heading", () => {
    writeBlankScaffold(tmpDir, "my-project");
    const readme = fs.readFileSync(path.join(tmpDir, "README.md"), "utf-8");
    expect(readme).toContain("# my-project");
    expect(readme).toContain("polpo deploy");
  });

  it("is idempotent — second call overwrites existing scaffold cleanly", () => {
    writeBlankScaffold(tmpDir, "first");
    writeBlankScaffold(tmpDir, "second");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".polpo", "polpo.json"), "utf-8"),
    );
    expect(cfg.project).toBe("second");
  });

  it("creates .polpo/ when it already exists (no error)", () => {
    fs.mkdirSync(path.join(tmpDir, ".polpo"));
    expect(() => writeBlankScaffold(tmpDir, "x")).not.toThrow();
  });

  it("works with a name containing spaces and special chars", () => {
    writeBlankScaffold(tmpDir, "My Cool Agent!");
    const cfg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".polpo", "polpo.json"), "utf-8"),
    );
    expect(cfg.project).toBe("My Cool Agent!");
  });
});

// ─── Scenario seeding ──────────────────────────────────────────────

describe("scenario seeding", () => {
  it("registry exposes 3 scenarios with unique ids", () => {
    expect(SCENARIOS).toHaveLength(3);
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const sc of SCENARIOS) {
    describe(`scenario ${sc.id}`, () => {
      beforeEach(() => writeBlankScaffold(tmpDir, "demo", sc));

      it("renames the seed agent to the scenario's agent.name", () => {
        const agents = JSON.parse(
          fs.readFileSync(path.join(tmpDir, ".polpo", "agents.json"), "utf-8"),
        );
        expect(agents[0].agent.name).toBe(sc.agent.name);
        expect(agents[0].agent.role).toBe(sc.agent.role);
      });

      it("keeps the full default tool palette including memory_*", () => {
        const agents = JSON.parse(
          fs.readFileSync(path.join(tmpDir, ".polpo", "agents.json"), "utf-8"),
        );
        expect(agents[0].agent.allowedTools).toContain("memory_*");
        expect(agents[0].agent.allowedTools).toContain("pdf_*");
        expect(agents[0].agent.allowedTools).toContain("excel_*");
        expect(agents[0].agent.allowedTools).toContain("search_*");
      });

      it("writes project + agent memory files", () => {
        const project = fs.readFileSync(path.join(tmpDir, ".polpo", "memory.md"), "utf-8");
        const agent = fs.readFileSync(
          path.join(tmpDir, ".polpo", "memory", `${sc.agent.name}.md`),
          "utf-8",
        );
        expect(project.length).toBeGreaterThan(50);
        expect(agent.length).toBeGreaterThan(50);
      });

      it("writes a single draft task with file_exists expectation (no llm_review)", () => {
        const taskPath = path.join(tmpDir, ".polpo", "tasks", `${sc.task.filename}.json`);
        const task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
        expect(task.draft).toBe(true);
        expect(task.assignTo).toBe(sc.agent.name);
        // No llm_review — verification is deterministic.
        const types = (task.expectations as Array<{ type: string }>).map((e) => e.type);
        expect(types).not.toContain("llm_review");
        expect(types).toContain("file_exists");
      });

      it("writes a draft mission whose data parses against missionDocumentSchema", () => {
        const missionPath = path.join(tmpDir, ".polpo", "missions", `${sc.mission.filename}.json`);
        const file = JSON.parse(fs.readFileSync(missionPath, "utf-8"));
        expect(file.status).toBe("draft");
        // parseMissionDocument is the same validator the server runs at execute-time.
        const parsed = parseMissionDocument(file.data);
        expect(parsed.tasks).toHaveLength(4);
      });

      it("mission graph: linear brief → research → (spreadsheet || pdf) parallel", () => {
        const missionPath = path.join(tmpDir, ".polpo", "missions", `${sc.mission.filename}.json`);
        const file = JSON.parse(fs.readFileSync(missionPath, "utf-8"));
        const tasks = file.data.tasks as Array<{ title: string; dependsOn?: string[] }>;
        const byTitle = new Map(tasks.map((t) => [t.title, t.dependsOn ?? []]));

        // Brief is the root.
        expect(byTitle.get("create_brief")).toEqual([]);
        // The two terminal tasks share a single dependency — that's how parallelism is expressed.
        const spreadsheetDeps = tasks.find((t) => t.title === "build_spreadsheet")?.dependsOn ?? [];
        const pdfDeps = tasks.find((t) => t.title === "build_pdf")?.dependsOn ?? [];
        expect(spreadsheetDeps).toEqual(pdfDeps);
        expect(spreadsheetDeps).toHaveLength(1);
        // And that dependency itself depends on create_brief (the research step).
        const researchTitle = spreadsheetDeps[0];
        expect(byTitle.get(researchTitle)).toEqual(["create_brief"]);
      });
    });
  }

  it("findScenario returns undefined for an unknown id", () => {
    expect(findScenario("nope")).toBeUndefined();
  });

  it("without scenario, agent name + role stay legacy 'agent-1' / 'helpful assistant'", () => {
    writeBlankScaffold(tmpDir, "demo");
    const agents = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".polpo", "agents.json"), "utf-8"),
    );
    expect(agents[0].agent.name).toBe("agent-1");
    expect(agents[0].agent.role).toBe("helpful assistant");
    // And no scenario directories are created.
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "tasks"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "missions"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".polpo", "memory.md"))).toBe(false);
  });
});
