import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TEMPLATES,
  findTemplate,
  writeBlankScaffold,
} from "../src/util/template.js";

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
    expect(agents[0].agent.model).toBe("xai/grok-4-fast");
  });

  it("writes .env.local.example with POLPO_API_KEY placeholder", () => {
    writeBlankScaffold(tmpDir, "x");
    const env = fs.readFileSync(
      path.join(tmpDir, ".env.local.example"),
      "utf-8",
    );
    expect(env).toContain("POLPO_API_KEY=");
    expect(env).toContain("POLPO_API_URL=https://api.polpo.sh");
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
