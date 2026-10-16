import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nanoid } from "nanoid";
import {
  validateRuntimeHookPack,
  type RuntimeHookPack,
  type RuntimeHookPackStore,
} from "@polpo-ai/core/runtime-hooks";

export class FileRuntimeHookPackStore implements RuntimeHookPackStore {
  private readonly directory: string;

  constructor(polpoDir: string) {
    this.directory = join(polpoDir, "hooks");
  }

  async list(): Promise<RuntimeHookPack[]> {
    let files: string[];
    try { files = await readdir(this.directory); } catch { return []; }
    const packs: RuntimeHookPack[] = [];
    for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
      packs.push(await this.readFile(join(this.directory, file)));
    }
    return packs;
  }

  async get(name: string): Promise<RuntimeHookPack | undefined> {
    const safe = safeName(name);
    try { return await this.readFile(join(this.directory, `${safe}.json`)); } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(pack: RuntimeHookPack): Promise<void> {
    const validated = validateRuntimeHookPack(pack);
    const name = safeName(validated.name);
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${name}.json`);
    const temporary = join(this.directory, `.${name}.${nanoid(8)}.tmp`);
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async delete(name: string): Promise<boolean> {
    const target = join(this.directory, `${safeName(name)}.json`);
    try { await rm(target); return true; } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  private async readFile(path: string): Promise<RuntimeHookPack> {
    return validateRuntimeHookPack(JSON.parse(await readFile(path, "utf8")));
  }
}

function safeName(name: string): string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name)) {
    throw new Error(`Invalid runtime hook pack name ${JSON.stringify(name)}`);
  }
  return name;
}
