import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRouteClassifier } from "@polpo-ai/core/execution-router";
import { Orchestrator } from "../core/orchestrator.js";

const dirs: string[] = [];

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "polpo-router-host-"));
  dirs.push(dir);
  await mkdir(join(dir, ".polpo", "loops"), { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })));
});

describe("Node execution router host ports", () => {
  it("exposes only the classifier explicitly supplied by the host", async () => {
    const classifier: ExecutionRouteClassifier = {
      classify: async () => ({
        mode: "direct",
        confidence: 1,
        reason: "Direct",
      }),
    };
    const dir = await workDir();
    const configured = new Orchestrator({
      workDir: dir,
      resolveExecutionRouteClassifier: () => classifier,
    });
    const unconfigured = new Orchestrator(dir);

    expect(await configured.resolveExecutionRouteClassifier()).toBe(classifier);
    expect(unconfigured.resolveExecutionRouteClassifier()).toBeUndefined();
  });

  it("loads and validates a matching project loop manifest", async () => {
    const dir = await workDir();
    await writeFile(
      join(dir, ".polpo", "loops", "research.json"),
      JSON.stringify({
        name: "research",
        label: "Research",
        start: "answer",
        steps: {
          answer: { type: "agent", next: "end" },
        },
      }),
    );
    const orchestrator = new Orchestrator(dir);

    await expect(orchestrator.getProjectLoop("research")).resolves.toMatchObject({
      name: "research",
      label: "Research",
      start: "answer",
    });
    await expect(orchestrator.getProjectLoop("missing")).resolves.toBeNull();
  });

  it("rejects traversal and mismatched manifest identities", async () => {
    const dir = await workDir();
    await writeFile(
      join(dir, ".polpo", "loops", "research.json"),
      JSON.stringify({
        name: "different",
        start: "answer",
        steps: {
          answer: { type: "agent", next: "end" },
        },
      }),
    );
    const orchestrator = new Orchestrator(dir);

    await expect(orchestrator.getProjectLoop("../secret"))
      .rejects.toThrow("name is invalid");
    await expect(orchestrator.getProjectLoop("research"))
      .rejects.toThrow("declares a different name");
  });
});
