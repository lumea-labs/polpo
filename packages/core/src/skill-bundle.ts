/** Portable, binary-safe representation of an Agent Skills directory. */
export interface SkillBundleFile {
  /** POSIX path relative to the skill directory. */
  path: string;
  /** File bytes encoded as canonical base64. */
  content: string;
  encoding: "base64";
}

export interface SkillBundle {
  name: string;
  files: SkillBundleFile[];
}

export const SKILL_BUNDLE_MAX_FILES = 512;
export const SKILL_BUNDLE_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SKILL_BUNDLE_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const SKILL_BUNDLE_MAX_PATH_LENGTH = 240;

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateSkillName(name: string): string | null {
  if (!SAFE_SKILL_NAME.test(name) || name === "." || name === "..") {
    return "Skill name must be a safe directory name";
  }
  return null;
}

export function decodedBase64Size(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Validate a complete bundle before any filesystem mutation occurs. */
export function validateSkillBundleFiles(files: readonly SkillBundleFile[]): string | null {
  if (files.length === 0) return "Skill bundle must contain files";
  if (files.length > SKILL_BUNDLE_MAX_FILES) {
    return `Skill bundle exceeds the ${SKILL_BUNDLE_MAX_FILES}-file limit`;
  }

  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (!file || file.encoding !== "base64" || typeof file.path !== "string" || typeof file.content !== "string") {
      return "Every skill bundle entry must contain path, base64 content, and encoding=base64";
    }
    if (
      file.path.length === 0 ||
      file.path.length > SKILL_BUNDLE_MAX_PATH_LENGTH ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("\0")
    ) {
      return `Invalid skill bundle path: ${file.path}`;
    }
    const segments = file.path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return `Invalid skill bundle path: ${file.path}`;
    }
    if (paths.has(file.path)) return `Duplicate skill bundle path: ${file.path}`;
    paths.add(file.path);

    if (file.content.length % 4 !== 0 || !BASE64.test(file.content)) {
      return `Invalid base64 content for ${file.path}`;
    }
    const bytes = decodedBase64Size(file.content);
    if (bytes > SKILL_BUNDLE_MAX_FILE_BYTES) {
      return `Skill bundle file exceeds the ${SKILL_BUNDLE_MAX_FILE_BYTES}-byte limit: ${file.path}`;
    }
    totalBytes += bytes;
    if (totalBytes > SKILL_BUNDLE_MAX_TOTAL_BYTES) {
      return `Skill bundle exceeds the ${SKILL_BUNDLE_MAX_TOTAL_BYTES}-byte total limit`;
    }
  }

  if (!paths.has("SKILL.md")) return "Skill bundle must contain SKILL.md at its root";
  return null;
}
