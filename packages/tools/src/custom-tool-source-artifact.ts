export const CUSTOM_TOOL_SOURCE_ARTIFACT_VERSION = 1 as const;
export const MAX_CUSTOM_TOOL_SOURCE_FILES = 128;
export const MAX_CUSTOM_TOOL_SOURCE_BYTES = 2 * 1024 * 1024;

const MAX_SOURCE_PATH_LENGTH = 240;
const MAX_SOURCE_PATH_DEPTH = 16;
const SUPPORTED_SOURCE_EXTENSION_RE = /\.(?:[cm]?[jt]sx?|json)$/;
const CUSTOM_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface CustomToolSourceArtifact {
  readonly version: typeof CUSTOM_TOOL_SOURCE_ARTIFACT_VERSION;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
}

export function createSingleFileCustomToolArtifact(
  name: string,
  source: string,
): CustomToolSourceArtifact {
  if (!CUSTOM_TOOL_NAME_RE.test(name)) {
    throw new Error(`Invalid custom tool name: ${name}`);
  }
  return parseCustomToolSourceArtifact({
    version: CUSTOM_TOOL_SOURCE_ARTIFACT_VERSION,
    entry: `${name}.ts`,
    files: { [`${name}.ts`]: source },
  });
}

export function parseCustomToolSourceArtifact(
  value: unknown,
): CustomToolSourceArtifact {
  if (!isPlainRecord(value)) {
    throw new Error("Custom tool source artifact must be an object");
  }

  const supportedFields = new Set(["version", "entry", "files"]);
  const unsupportedFields = Object.keys(value).filter(
    (field) => !supportedFields.has(field),
  );
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Unsupported custom tool source artifact fields: ${unsupportedFields.join(", ")}`,
    );
  }
  if (value.version !== CUSTOM_TOOL_SOURCE_ARTIFACT_VERSION) {
    throw new Error(
      `Unsupported custom tool source artifact version: ${String(value.version)}`,
    );
  }
  if (typeof value.entry !== "string") {
    throw new Error("Custom tool source artifact entry must be a string");
  }
  if (!isPlainRecord(value.files)) {
    throw new Error("Custom tool source artifact files must be an object");
  }

  const fileEntries = Object.entries(value.files);
  if (fileEntries.length === 0) {
    throw new Error("Custom tool source artifact must contain at least one file");
  }
  if (fileEntries.length > MAX_CUSTOM_TOOL_SOURCE_FILES) {
    throw new Error(
      `Custom tool source artifact cannot contain more than ${MAX_CUSTOM_TOOL_SOURCE_FILES} files`,
    );
  }

  const normalizedEntry = validateSourcePath(value.entry);
  const caseInsensitivePaths = new Set<string>();
  let totalBytes = 0;
  const files: Record<string, string> = {};

  for (const [rawPath, source] of fileEntries.sort(([left], [right]) =>
    left.localeCompare(right, "en"))) {
    const path = validateSourcePath(rawPath);
    const caseInsensitivePath = path.toLocaleLowerCase("en-US");
    if (caseInsensitivePaths.has(caseInsensitivePath)) {
      throw new Error(`Custom tool source artifact path collision: ${path}`);
    }
    caseInsensitivePaths.add(caseInsensitivePath);

    if (typeof source !== "string") {
      throw new Error(`Custom tool source for ${path} must be a string`);
    }
    totalBytes += Buffer.byteLength(source, "utf8");
    if (totalBytes > MAX_CUSTOM_TOOL_SOURCE_BYTES) {
      throw new Error(
        `Custom tool source artifact exceeds ${MAX_CUSTOM_TOOL_SOURCE_BYTES} bytes`,
      );
    }
    files[path] = source;
  }

  if (!(normalizedEntry in files)) {
    throw new Error(
      `Custom tool source artifact entry does not exist: ${normalizedEntry}`,
    );
  }

  return Object.freeze({
    version: CUSTOM_TOOL_SOURCE_ARTIFACT_VERSION,
    entry: normalizedEntry,
    files: Object.freeze(files),
  });
}

export function customToolArtifactEntrySource(
  artifact: CustomToolSourceArtifact,
): string {
  const source = artifact.files[artifact.entry];
  if (typeof source !== "string") {
    throw new Error(`Custom tool source artifact entry is missing: ${artifact.entry}`);
  }
  return source;
}

function validateSourcePath(path: string): string {
  if (
    path.length === 0
    || path.length > MAX_SOURCE_PATH_LENGTH
    || path.includes("\\")
    || path.includes("\0")
    || path !== path.normalize("NFC")
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || !SUPPORTED_SOURCE_EXTENSION_RE.test(path)
  ) {
    throw new Error(`Unsafe or unsupported custom tool source path: ${path}`);
  }

  const segments = path.split("/");
  if (
    segments.length > MAX_SOURCE_PATH_DEPTH
    || segments.some((segment) =>
      segment.length === 0
      || segment === "."
      || segment === ".."
      || segment.toLocaleLowerCase("en-US") === "node_modules")
  ) {
    throw new Error(`Unsafe custom tool source path: ${path}`);
  }
  return path;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
