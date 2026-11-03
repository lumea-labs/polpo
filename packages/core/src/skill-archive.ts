import { unzipSync, zipSync, type Zippable } from "fflate";
import {
  SKILL_BUNDLE_MAX_FILES,
  SKILL_BUNDLE_MAX_FILE_BYTES,
  SKILL_BUNDLE_MAX_PATH_LENGTH,
  SKILL_BUNDLE_MAX_TOTAL_BYTES,
  decodeBase64,
  digestSkillBundle,
  encodeBase64,
  validateSkillBundleFiles,
  type SkillBundle,
  type SkillBundleFile,
} from "./skill-bundle.js";
import { parseSkillManifest, type SkillDiagnostic, type SkillManifest } from "./skill-manifest.js";

export const SKILL_ARCHIVE_MAX_COMPRESSED_BYTES = 30 * 1024 * 1024;
export const SKILL_ARCHIVE_MAX_COMPRESSION_RATIO = 200;

export type SkillArchiveErrorCode =
  | "invalid_archive"
  | "encrypted_entry"
  | "unsupported_entry"
  | "archive_limit_exceeded"
  | "ambiguous_root"
  | "invalid_bundle"
  | "invalid_manifest";

export class SkillArchiveError extends Error {
  constructor(readonly code: SkillArchiveErrorCode, message: string) {
    super(message);
    this.name = "SkillArchiveError";
  }
}

export interface UnpackedSkillArchive {
  bundle: SkillBundle;
  manifest: SkillManifest;
  diagnostics: SkillDiagnostic[];
  digest: string;
  uncompressedBytes: number;
}

interface CentralEntry {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory: boolean;
}

export async function unpackSkillArchive(input: Uint8Array): Promise<UnpackedSkillArchive> {
  if (input.byteLength === 0 || input.byteLength > SKILL_ARCHIVE_MAX_COMPRESSED_BYTES) {
    throw new SkillArchiveError("archive_limit_exceeded", "Skill archive compressed size is outside the supported limit");
  }
  const inventory = inspectCentralDirectory(input);
  const files = inventory.filter((entry) => !entry.directory);
  if (files.length === 0 || files.length > SKILL_BUNDLE_MAX_FILES) {
    throw new SkillArchiveError("archive_limit_exceeded", `Skill archive must contain 1 to ${SKILL_BUNDLE_MAX_FILES} files`);
  }
  let totalBytes = 0;
  for (const entry of files) {
    if (entry.uncompressedBytes > SKILL_BUNDLE_MAX_FILE_BYTES) {
      throw new SkillArchiveError("archive_limit_exceeded", `Skill archive file is too large: ${entry.path}`);
    }
    if (entry.compressedBytes === 0 && entry.uncompressedBytes > 0) {
      throw new SkillArchiveError("archive_limit_exceeded", `Skill archive entry has an invalid compression ratio: ${entry.path}`);
    }
    if (entry.compressedBytes > 0 && entry.uncompressedBytes / entry.compressedBytes > SKILL_ARCHIVE_MAX_COMPRESSION_RATIO) {
      throw new SkillArchiveError("archive_limit_exceeded", `Skill archive entry exceeds the compression-ratio limit: ${entry.path}`);
    }
    totalBytes += entry.uncompressedBytes;
    if (totalBytes > SKILL_BUNDLE_MAX_TOTAL_BYTES) {
      throw new SkillArchiveError("archive_limit_exceeded", "Skill archive exceeds the uncompressed size limit");
    }
  }

  const root = resolveArchiveRoot(files.map((entry) => entry.path));
  let expanded: Record<string, Uint8Array>;
  try {
    expanded = unzipSync(input);
  } catch (error) {
    throw new SkillArchiveError("invalid_archive", `Skill archive could not be decompressed: ${errorMessage(error)}`);
  }
  const bundleFiles: SkillBundleFile[] = [];
  for (const entry of files) {
    const bytes = expanded[entry.path];
    if (!bytes || bytes.byteLength !== entry.uncompressedBytes) {
      throw new SkillArchiveError("invalid_archive", `Skill archive entry is missing or has an invalid size: ${entry.path}`);
    }
    const path = root ? entry.path.slice(root.length + 1) : entry.path;
    bundleFiles.push({ path, content: encodeBase64(bytes), encoding: "base64" });
  }
  bundleFiles.sort((left, right) => compareStrings(left.path, right.path));
  const skillFile = bundleFiles.find((file) => file.path === "SKILL.md");
  if (!skillFile) throw new SkillArchiveError("ambiguous_root", "Skill archive must contain one root SKILL.md");

  let parsed;
  try {
    const candidate = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(skillFile.content));
    parsed = parseSkillManifest(candidate, { mode: "strict", directoryName: root || undefined });
  } catch (error) {
    throw new SkillArchiveError("invalid_manifest", errorMessage(error));
  }
  const bundle: SkillBundle = { name: parsed.manifest.name, files: bundleFiles };
  const validationError = validateSkillBundleFiles(bundle.files);
  if (validationError) throw new SkillArchiveError("invalid_bundle", validationError);

  return {
    bundle,
    manifest: parsed.manifest,
    diagnostics: parsed.diagnostics,
    digest: await digestSkillBundle(bundle),
    uncompressedBytes: totalBytes,
  };
}

export async function packSkillArchive(bundle: SkillBundle): Promise<Uint8Array> {
  const validationError = validateSkillBundleFiles(bundle.files);
  if (validationError) throw new SkillArchiveError("invalid_bundle", validationError);
  const skillFile = bundle.files.find((file) => file.path === "SKILL.md")!;
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64(skillFile.content));
    parseSkillManifest(content, { mode: "strict", directoryName: bundle.name });
  } catch (error) {
    throw new SkillArchiveError("invalid_manifest", errorMessage(error));
  }

  const archive: Zippable = {};
  for (const file of [...bundle.files].sort((left, right) => compareStrings(left.path, right.path))) {
    archive[`${bundle.name}/${file.path}`] = [decodeBase64(file.content), {
      level: 6,
      // fflate writes DOS timestamps through local Date getters. Constructing
      // local midnight keeps the archive bytes stable across host timezones.
      mtime: new Date(1980, 0, 1, 0, 0, 0),
      os: 3,
      attrs: 0o100644 << 16,
    }];
  }
  return zipSync(archive, { level: 6 });
}

function resolveArchiveRoot(paths: readonly string[]): string {
  if (paths.includes("SKILL.md")) {
    if (paths.some((path) => path !== "SKILL.md" && !path.includes("/"))) {
      throw new SkillArchiveError("ambiguous_root", "Root-layout skill archives cannot contain unrelated root files");
    }
    return "";
  }
  const roots = new Set(paths.map((path) => path.split("/", 1)[0]));
  if (roots.size !== 1) throw new SkillArchiveError("ambiguous_root", "Skill archive must contain exactly one skill root");
  const root = [...roots][0];
  if (!paths.includes(`${root}/SKILL.md`)) {
    throw new SkillArchiveError("ambiguous_root", "Skill archive must contain SKILL.md at its root");
  }
  return root;
}

function inspectCentralDirectory(input: Uint8Array): CentralEntry[] {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new SkillArchiveError("unsupported_entry", "Multi-disk ZIP archives are not supported");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new SkillArchiveError("unsupported_entry", "ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > eocd || totalEntries > SKILL_BUNDLE_MAX_FILES * 2) {
    throw new SkillArchiveError("invalid_archive", "ZIP central directory is outside the archive bounds");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new SkillArchiveError("invalid_archive", "ZIP central directory entry is invalid");
    }
    const madeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) throw new SkillArchiveError("invalid_archive", "ZIP entry metadata is truncated");
    if ((flags & 1) !== 0) throw new SkillArchiveError("encrypted_entry", "Encrypted skill archive entries are not supported");
    if (method !== 0 && method !== 8) throw new SkillArchiveError("unsupported_entry", `Unsupported ZIP compression method: ${method}`);
    if (diskStart !== 0 || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) {
      throw new SkillArchiveError("unsupported_entry", "ZIP64 or multi-disk entries are not supported");
    }

    let path: string;
    try {
      path = decoder.decode(input.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new SkillArchiveError("invalid_archive", "ZIP entry names must be valid UTF-8");
    }
    const directory = path.endsWith("/");
    const normalized = directory ? path.slice(0, -1) : path;
    validateArchivePath(normalized);
    const host = madeBy >>> 8;
    const unixMode = host === 3 ? externalAttributes >>> 16 : 0;
    const kind = unixMode & 0o170000;
    if (kind !== 0 && kind !== 0o100000 && !(directory && kind === 0o040000)) {
      throw new SkillArchiveError("unsupported_entry", `Skill archive contains a non-regular entry: ${path}`);
    }
    if (!directory) {
      if (paths.has(normalized)) throw new SkillArchiveError("invalid_archive", `Duplicate ZIP entry: ${normalized}`);
      const folded = normalized.toLocaleLowerCase("en-US");
      if (foldedPaths.has(folded)) throw new SkillArchiveError("invalid_archive", `Case-colliding ZIP entry: ${normalized}`);
      paths.add(normalized);
      foldedPaths.add(folded);
    }
    entries.push({ path, compressedBytes, uncompressedBytes, directory });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw new SkillArchiveError("invalid_archive", "ZIP central directory size does not match its entries");
  }
  return entries;
}

function validateArchivePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || path !== path.normalize("NFC")) {
    throw new SkillArchiveError("invalid_archive", `Invalid skill archive path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new SkillArchiveError("invalid_archive", `Invalid skill archive path: ${path}`);
  }
  if (new TextEncoder().encode(path).byteLength > SKILL_BUNDLE_MAX_PATH_LENGTH + 65) {
    throw new SkillArchiveError("archive_limit_exceeded", `Skill archive path is too long: ${path}`);
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) return offset;
    }
  }
  throw new SkillArchiveError("invalid_archive", "ZIP end-of-central-directory record was not found");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
