import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLoopSourceFiles, loadLoopDeployPayload, loadLoopSource } from "../src/util/loops.js";

describe("loop source utilities", () => {
  it("compiles TypeScript loop sources statically for validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-loops-"));
    const polpoDir = join(dir, ".polpo");
    const loopsDir = join(polpoDir, "loops");
    const file = join(loopsDir, "coding-flow.ts");

    try {
      await mkdir(loopsDir, { recursive: true });
      await writeFile(file, `
        import { defineProjectLoop, agentStep, toolStep } from "@polpo-ai/core/loop-code";

        export default defineProjectLoop({
          name: "coding-flow",
          start: "plan",
          steps: {
            plan: agentStep({ label: "Plan", tools: ["read"], next: "build" }),
            build: toolStep({ label: "Build", tool: "bash", input: { command: "pnpm build" }, next: "end" })
          }
        });
      `);

      const loop = await loadLoopSource(file);
      expect(loop.steps.plan).toMatchObject({ type: "agent", label: "Plan" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deploys TypeScript loop sources as source payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-loops-"));
    const polpoDir = join(dir, ".polpo");
    const loopsDir = join(polpoDir, "loops");
    const file = join(loopsDir, "support-flow.ts");

    try {
      await mkdir(loopsDir, { recursive: true });
      await writeFile(file, `
        import { defineLoop, agentStep } from "@polpo-ai/core/loop-code";

        export default defineLoop({
          name: "support-flow",
          start: "triage",
          steps: {
            triage: agentStep({ next: "end" })
          }
        });
      `);

      const payload = await loadLoopDeployPayload(file);
      expect(payload.name).toBe("support-flow");
      expect(payload.body).toMatchObject({ fileName: "support-flow.ts" });
      expect("source" in payload.body).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deploys JSON loop sources as canonical JSON payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-loops-"));
    const file = join(dir, "loop.json");

    try {
      await writeFile(file, JSON.stringify({
        name: "json-flow",
        start: "work",
        steps: { work: { type: "agent", next: "end" } },
      }));

      const payload = await loadLoopDeployPayload(file);
      expect(payload.name).toBe("json-flow");
      expect(payload.body).toMatchObject({ name: "json-flow" });
      expect("source" in payload.body).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate loop files with the same basename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-loops-"));
    const polpoDir = join(dir, ".polpo");
    const loopsDir = join(polpoDir, "loops");

    try {
      await mkdir(loopsDir, { recursive: true });
      await writeFile(join(loopsDir, "flow.json"), "{}");
      await writeFile(join(loopsDir, "flow.ts"), "export default {};");

      expect(() => listLoopSourceFiles(polpoDir)).toThrow('Duplicate loop definition "flow"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
