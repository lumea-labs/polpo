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
 *   image_*, audio_*, search_*, phone_*, memory_*
 */

// Core tool factory
export { createSystemTools, createSystemTools as createCodingTools, createAllTools, matchToolPattern, expandToolWildcards, ALL_EXTENDED_TOOL_NAMES } from "./system-tools.js";
export type { ExtendedToolName, CreateAllToolsOptions } from "./system-tools.js";

// Individual tool factories (for custom composition)
export { createOutcomeTools } from "./outcome-tools.js";
export { createHttpTools, ALL_HTTP_TOOL_NAMES } from "./http-tools.js";
export { createVaultToolsCore, createVaultTools, ALL_VAULT_TOOL_NAMES } from "./vault-tools.js";

// Extended tool factories
export { createBrowserTools, ALL_BROWSER_TOOL_NAMES, cleanupAgentBrowserSession } from "./browser-tools.js";
export { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "./email-tools.js";
export { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "./excel-tools.js";
export { createPdfTools, ALL_PDF_TOOL_NAMES } from "./pdf-tools.js";
export { createDocxTools, ALL_DOCX_TOOL_NAMES } from "./docx-tools.js";
export { createImageTools, ALL_IMAGE_TOOL_NAMES } from "./image-tools.js";
export { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "./audio-tools.js";
export { createSearchTools, ALL_SEARCH_TOOL_NAMES } from "./search-tools.js";
export { createPhoneTools, ALL_PHONE_TOOL_NAMES } from "./phone-tools.js";
export { createMemoryTools } from "./memory-tools.js";

// Adapters (FileSystem/Shell implementations)
export { NodeFileSystem } from "./adapters/node-filesystem.js";
export { NodeShell } from "./adapters/node-shell.js";

// Security utilities
export { assertPathAllowed, resolveAllowedPaths, isPathAllowed } from "./path-sandbox.js";
export { safeEnv, bashSafeEnv } from "./safe-env.js";
export { assertUrlAllowed } from "./ssrf-guard.js";

// Types
export type { ResolvedVault } from "./types.js";
