/**
 * @polpo-ai/tools — Agent tools for Polpo.
 *
 * Core tools (always available):
 *   read, write, edit, bash, glob, grep, ls,
 *   register_outcome, http_fetch, http_download,
 *   vault_get, vault_list
 *
 * Extended tools (opt-in, require optional deps):
 *   browser_*, email_*, excel_*, pdf_*, docx_*,
 *   image_*, audio_*, search_*, memory_*
 */

// Core tool factory
export { createSystemTools, createSystemTools as createCodingTools, createAllTools, matchToolPattern, expandToolWildcards, TOOL_CATALOG } from "./system-tools.js";
export type { ExtendedToolName, CreateAllToolsOptions } from "./system-tools.js";

// Individual tool factories (for custom composition)
export { createOutcomeTools } from "./outcome-tools.js";
export { createSandboxVolumeCheckpointTool } from "./sandbox-volume-tools.js";
export { createHttpTools, ALL_HTTP_TOOL_NAMES } from "./http-tools.js";
export { createVaultToolsCore, createVaultTools, ALL_VAULT_TOOL_NAMES } from "./vault-tools.js";
export { resolveAgentMcpTools } from "./mcp-client.js";
export type { McpServerSpec, ResolvedMcpTools, VaultLookup } from "./mcp-client.js";

// Extended tool factories
export { createBrowserTools, ALL_BROWSER_TOOL_NAMES, cleanupAgentBrowserSession } from "./browser-tools.js";
export { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./email-tools.js";
export { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./excel-tools.js";
export { createPdfTools, ALL_PDF_TOOL_NAMES } from "./pdf-tools.js";
export { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./docx-tools.js";
export { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./image-tools.js";
export { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./audio-tools.js";
export { createSearchTools, ALL_SEARCH_TOOL_NAMES } from "./search-tools.js";
// Phone tools removed — VAPI integration moved out of the
// first-class catalog. Future: MCP-based.
export { createMemoryTools } from "./memory-tools.js";
export {
  ALL_TYPED_MEMORY_TOOL_NAMES,
  createTypedMemoryTools,
} from "./typed-memory-tools.js";
export type {
  CreateTypedMemoryToolsOptions,
  TypedMemoryToolGrants,
  TypedMemoryToolName,
} from "./typed-memory-tools.js";
export {
  ALL_BRAIN_TOOL_NAMES,
  createBrainTools,
} from "./brain-tools.js";
export type { BrainToolName } from "./brain-tools.js";

// Adapters (FileSystem/Shell implementations)
export { NodeFileSystem } from "./adapters/node-filesystem.js";
export { NodeShell } from "./adapters/node-shell.js";

// Security utilities
export { assertPathAllowed, resolveAllowedPaths, isPathAllowed } from "./path-sandbox.js";
export { safeEnv, bashSafeEnv } from "./safe-env.js";
export { assertUrlAllowed } from "./ssrf-guard.js";
export {
  builtInToolRequiresSandbox,
  withBuiltInToolRuntimeRequirements,
  withBuiltInToolsRuntimeRequirements,
} from "./runtime-requirements.js";

// Custom tools (defineTool)
export {
  defineTool,
  getCustomToolErrors,
  isCustomTool,
  normalizeToolResult,
  bindCustomTool,
  extractCustomTool,
  loadCustomToolBundle,
  createJsonSchemaExample,
  createToolInvocationContext,
  CustomToolBindingError,
  emptyCustomToolConnections,
} from "./custom-tools.js";
export type {
  CustomTool,
  CustomToolConnection,
  CustomToolConnections,
  CustomToolSpec,
  CustomToolContext,
  CustomToolBindContext,
  CustomToolExecuteResult,
  CustomToolServerBinding,
  CustomToolServerBindings,
  ToolInvocationContext,
  ToolInvocationContextInput,
  ToolInvocationJsonPrimitive,
  ToolInvocationJsonValue,
  ToolInvocationSurface,
} from "./custom-tools.js";
export {
  CUSTOM_TOOL_NAME_RE,
  createCustomToolsStore,
} from "./custom-tool-store.js";
export type {
  CustomToolMeta,
  CustomToolsStore,
} from "./custom-tool-store.js";
export {
  CUSTOM_TOOL_SOURCE_ARTIFACT_VERSION,
  MAX_CUSTOM_TOOL_SOURCE_BYTES,
  MAX_CUSTOM_TOOL_SOURCE_FILES,
  createSingleFileCustomToolArtifact,
  customToolArtifactEntrySource,
  parseCustomToolSourceArtifact,
} from "./custom-tool-source-artifact.js";
export type { CustomToolSourceArtifact } from "./custom-tool-source-artifact.js";

// Types
export type { ResolvedVault } from "./types.js";
