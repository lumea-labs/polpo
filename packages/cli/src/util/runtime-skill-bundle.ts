import * as fs from "node:fs";
import * as path from "node:path";
import {
  validateSkillBundleFiles,
  validateSkillName,
  type SkillBundle,
  type SkillBundleFile,
} from "@polpo-ai/core/skill-bundle";

export function collectLocalSkillBundle(skillDir: string, name = path.basename(skillDir)): SkillBundle {
  const nameError = validateSkillName(name);
  if (nameError) throw new Error(nameError);
  if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
    throw new Error(`Skill directory not found: ${skillDir}`);
  }

  const files: SkillBundleFile[] = [];
  const walk = (directory: string, relativeDirectory = ""): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill bundle cannot contain a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push({
          path: relativePath,
          content: fs.readFileSync(absolutePath).toString("base64"),
          encoding: "base64",
        });
      } else {
        throw new Error(`Skill bundle contains an unsupported filesystem entry: ${relativePath}`);
      }
    }
  };

  walk(skillDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const validationError = validateSkillBundleFiles(files);
  if (validationError) throw new Error(validationError);
  return { name, files };
}

export function replaceLocalSkillBundle(skillDir: string, bundle: SkillBundle): void {
  const validationError = validateSkillBundleFiles(bundle.files);
  if (validationError) throw new Error(validationError);
  const nameError = validateSkillName(bundle.name);
  if (nameError) throw new Error(nameError);
  if (path.basename(skillDir) !== bundle.name) {
    throw new Error(`Skill bundle name does not match destination directory: ${bundle.name}`);
  }

  const parent = path.dirname(skillDir);
  fs.mkdirSync(parent, { recursive: true });
  const transactionRoot = fs.mkdtempSync(path.join(parent, `.${bundle.name}-`));
  const staged = path.join(transactionRoot, "next");
  const backup = path.join(transactionRoot, "previous");
  fs.mkdirSync(staged, { recursive: true });
  let preserveTransaction = false;

  try {
    for (const file of bundle.files) {
      const destination = path.join(staged, ...file.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.content, "base64"));
    }
    collectLocalSkillBundle(staged, bundle.name);

    const existed = fs.existsSync(skillDir);
    if (existed) fs.renameSync(skillDir, backup);
    try {
      fs.renameSync(staged, skillDir);
    } catch (error) {
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
        if (existed && fs.existsSync(backup)) fs.renameSync(backup, skillDir);
      } catch (rollbackError) {
        preserveTransaction = true;
        throw new AggregateError(
          [error, rollbackError],
          `Could not replace or restore skill bundle ${bundle.name}; backup retained at ${backup}`,
        );
      }
      throw error;
    }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    if (!preserveTransaction) fs.rmSync(transactionRoot, { recursive: true, force: true });
  }
}
