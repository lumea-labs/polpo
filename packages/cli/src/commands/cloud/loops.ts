/**
 * polpo loops — validate and compile agentic loop definitions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { listLoopSourceFiles, loadLoopSource } from "../../util/loops.js";

function resolvePolpoDir(dir?: string): string {
  return path.resolve(dir ?? process.cwd(), ".polpo");
}

export function registerLoopsCommand(program: Command): void {
  const loops = program
    .command("loops")
    .description("Validate and compile project-level agentic loops");

  loops
    .command("validate")
    .description("Validate .polpo/loops definitions")
    .option("--dir <path>", "Project directory", process.cwd())
    .action(async (opts: { dir?: string }) => {
      clack.intro(pc.bold("polpo loops validate"));
      const polpoDir = resolvePolpoDir(opts.dir);
      const files = listLoopSourceFiles(polpoDir);
      if (files.length === 0) {
        clack.log.info("No loop definitions found in .polpo/loops.");
        clack.outro("Done.");
        return;
      }

      let failed = 0;
      for (const file of files) {
        try {
          const loop = await loadLoopSource(file);
          clack.log.success(`${path.relative(polpoDir, file)} ${pc.dim(`(${loop.name})`)}`);
        } catch (err) {
          failed++;
          clack.log.error(`${path.relative(polpoDir, file)} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (failed > 0) {
        clack.outro(pc.red(`${failed} loop definition${failed === 1 ? "" : "s"} failed validation.`));
        process.exitCode = 1;
        return;
      }
      clack.outro(pc.green(`Validated ${files.length} loop definition${files.length === 1 ? "" : "s"}.`));
    });

  loops
    .command("compile [file]")
    .description("Compile a loop module or JSON file to canonical JSON")
    .option("--dir <path>", "Project directory", process.cwd())
    .option("-o, --out <file>", "Write compiled JSON to a file")
    .action(async (file: string | undefined, opts: { dir?: string; out?: string }) => {
      clack.intro(pc.bold("polpo loops compile"));
      const polpoDir = resolvePolpoDir(opts.dir);
      const files = file ? [path.resolve(file)] : listLoopSourceFiles(polpoDir);
      if (files.length === 0) {
        clack.log.info("No loop definitions found in .polpo/loops.");
        clack.outro("Done.");
        return;
      }
      if (opts.out && files.length > 1) {
        clack.log.error("--out can only be used when compiling a single file.");
        process.exitCode = 1;
        return;
      }

      const compiled = [];
      for (const source of files) {
        compiled.push(await loadLoopSource(source));
      }

      const json = JSON.stringify(files.length === 1 ? compiled[0] : compiled, null, 2) + "\n";
      if (opts.out) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(path.resolve(opts.out), json, "utf-8");
        clack.outro(pc.green(`Wrote ${opts.out}.`));
        return;
      }
      process.stdout.write(json);
      clack.outro("Done.");
    });
}
