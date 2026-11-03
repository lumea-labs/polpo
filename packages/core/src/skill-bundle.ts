import { validateAgentSkillName } from "./skill-manifest.js";

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

export type SkillBundleSource = "archive" | "directory" | "git" | "builder" | "bundle";

export interface SkillBundleReceipt {
  name: string;
  digest: string;
  files: number;
  uncompressedBytes: number;
  changed: boolean;
  source: SkillBundleSource | string;
  assignedTo?: string[];
  warnings: Array<{ code: string; message: string; severity: "warning" }>;
}

export const SKILL_BUNDLE_MAX_FILES = 512;
export const SKILL_BUNDLE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SKILL_BUNDLE_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
export const SKILL_BUNDLE_MAX_PATH_LENGTH = 240;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateSkillName(name: string): string | null {
  return validateAgentSkillName(name);
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
  const foldedPaths = new Map<string, string>();
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
      file.path.includes("\0") ||
      file.path !== file.path.normalize("NFC") ||
      new TextEncoder().encode(file.path).byteLength > SKILL_BUNDLE_MAX_PATH_LENGTH
    ) {
      return `Invalid skill bundle path: ${file.path}`;
    }
    const segments = file.path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      return `Invalid skill bundle path: ${file.path}`;
    }
    if (paths.has(file.path)) return `Duplicate skill bundle path: ${file.path}`;
    paths.add(file.path);
    const folded = file.path.toLocaleLowerCase("en-US");
    const collision = foldedPaths.get(folded);
    if (collision) return `Skill bundle path has a case-insensitive collision: ${collision} and ${file.path}`;
    foldedPaths.set(folded, file.path);

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

/** Compute a stable content digest independent of archive metadata and file order. */
export async function digestSkillBundle(bundle: SkillBundle): Promise<string> {
  const nameError = validateSkillName(bundle.name);
  if (nameError) throw new TypeError(nameError);
  const bundleError = validateSkillBundleFiles(bundle.files);
  if (bundleError) throw new TypeError(bundleError);

  const files = [];
  for (const file of [...bundle.files].sort((left, right) => compareStrings(left.path, right.path))) {
    const bytes = decodeBase64(file.content);
    files.push({
      path: file.path,
      bytes: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    });
  }
  const canonical = new TextEncoder().encode(JSON.stringify({ version: 1, name: bundle.name, files }));
  return `sha256:${await sha256Hex(canonical)}`;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
