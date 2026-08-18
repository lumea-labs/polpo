import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullProject } from "./pull.js";
import { readProjectAgents } from "@polpo-ai/file-stores";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })));
});

describe("pullProject agent execution router", () => {
  it("round-trips execution router settings into an agent definition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-pull-router-"));
    dirs.push(dir);
    const agent = {
      name: "researcher",
      model: "test",
      assignedLoops: ["research"],
      executionRouter: {
        mode: "auto",
        allowedLoops: ["research"],
        minConfidence: 0.82,
        timeoutMs: 750,
        maxInputChars: 2048,
      },
      teamName: "default",
    };
    const client = {
      get: async (path: string) => {
        if (path === "/v1/agents") {
          return { status: 200, data: { data: [agent] } };
        }
        return { status: 404, data: {} };
      },
    };

    const result = await pullProject(client as any, dir, {
      force: true,
      interactive: false,
    });
    const entries = readProjectAgents(dir);

    expect(result.errors).toEqual([]);
    expect(entries[0].agent.executionRouter).toEqual(agent.executionRouter);
  });
});

describe("pullProject skill bundles", () => {
  it("restores nested text and binary resources from cloud", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-pull-skill-bundle-"));
    dirs.push(dir);
    const files = [
      {
        path: "SKILL.md",
        content: Buffer.from("---\nname: frontend-design\ndescription: Design\n---\n\nInstructions.").toString("base64"),
        encoding: "base64",
      },
      {
        path: "references/guide.md",
        content: Buffer.from("# Guide\n").toString("base64"),
        encoding: "base64",
      },
      {
        path: "assets/palette.bin",
        content: Buffer.from([0, 1, 2, 255]).toString("base64"),
        encoding: "base64",
      },
    ];
    const client = {
      get: async (requestPath: string) => {
        if (requestPath === "/v1/skills") {
          return { status: 200, data: { data: [{ name: "frontend-design" }] } };
        }
        if (requestPath === "/v1/skills/frontend-design/bundle") {
          return { status: 200, data: { data: { name: "frontend-design", files } } };
        }
        return { status: 404, data: {} };
      },
    };

    const result = await pullProject(client as any, dir, { force: true, interactive: false });

    expect(result.errors).toEqual([]);
    expect(await readFile(join(dir, "skills", "frontend-design", "references", "guide.md"), "utf8"))
      .toBe("# Guide\n");
    expect(await readFile(join(dir, "skills", "frontend-design", "assets", "palette.bin")))
      .toEqual(Buffer.from([0, 1, 2, 255]));
  });
});
