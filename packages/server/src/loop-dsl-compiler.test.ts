import { describe, expect, it } from "vitest";
import type { FileEntry, FileStat, FileSystem } from "@polpo-ai/core";
import { compileLoopSource, LoopDslCompileError } from "./loop-dsl-compiler.js";
import { loopRoutes } from "./routes/loops.js";

class MemoryFileSystem implements FileSystem {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`not found: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = `${path}/`;
    return [...this.files.keys()]
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length).split("/")[0])
      .filter((file, index, files) => files.indexOf(file) === index);
  }

  async readdirWithTypes(path: string): Promise<FileEntry[]> {
    return (await this.readdir(path)).map((name) => ({ name, isDirectory: false, isFile: true }));
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.dirs.delete(path);
  }

  async stat(path: string): Promise<FileStat> {
    return { size: this.files.get(path)?.length ?? 0, isDirectory: this.dirs.has(path), isFile: this.files.has(path) };
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.files.get(oldPath);
    if (content !== undefined) {
      this.files.set(newPath, content);
      this.files.delete(oldPath);
    }
  }
}

describe("loop DSL compiler", () => {
  it("compiles static TypeScript loop DSL to canonical JSON", () => {
    const loop = compileLoopSource(`
      import { defineProjectLoop, agentStep, toolStep, when, otherwise, bash } from "@polpo-ai/core/loop-code";

      export default defineProjectLoop({
        name: "ts-coding-flow",
        description: "Typed authoring, JSON runtime.",
        hooks: {
          "loop:end": [bash("echo done")]
        },
        start: "plan",
        steps: {
          plan: agentStep({
            label: "Plan",
            tools: ["read", "grep"],
            next: "build"
          }),
          build: toolStep({
            label: "Build",
            tool: "bash",
            input: { command: "pnpm build" },
            saveAs: "build",
            next: [
              when("build.exitCode != 0", "plan"),
              otherwise("end")
            ]
          })
        }
      });
    `);

    expect(loop).toMatchObject({
      version: "1",
      kind: "graph",
      context: "shared",
      name: "ts-coding-flow",
      hooks: {
        "loop:end": [{ tool: "bash", input: { command: "echo done" } }],
      },
      steps: {
        plan: { type: "agent", label: "Plan", tools: ["read", "grep"], next: "build" },
        build: {
          type: "tool",
          label: "Build",
          tool: "bash",
          next: [{ when: "build.exitCode != 0", to: "plan" }, { to: "end" }],
        },
      },
    });
  });

  it("rejects free-form code instead of executing it", () => {
    expect(() =>
      compileLoopSource(`
        const start = "plan";
        export default defineProjectLoop({
          name: "bad",
          start,
          steps: { plan: agentStep({ next: "end" }) }
        });
      `),
    ).toThrow(LoopDslCompileError);
  });

  it("accepts source payloads on the loops route and persists canonical JSON", async () => {
    const fs = new MemoryFileSystem();
    const app = loopRoutes(() => ({ fs, polpoDir: "/project/.polpo" }));
    const res = await app.request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: `
          import { defineLoop, agentStep } from "@polpo-ai/core/loop-code";

          export default defineLoop({
            name: "route-ts-loop",
            start: "work",
            steps: {
              work: agentStep({ label: "Work", next: "end" })
            }
          });
        `,
        fileName: "route-ts-loop.ts",
      }),
    });

    expect(res.status).toBe(200);
    const saved = JSON.parse(await fs.readFile("/project/.polpo/loops/route-ts-loop.json"));
    expect(saved).toMatchObject({
      name: "route-ts-loop",
      steps: { work: { type: "agent", label: "Work", next: "end" } },
    });
  });
});
