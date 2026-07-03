/**
 * Shared constants — single source of truth for default values
 * used across CLI and server.
 */

/** Default port for the Polpo HTTP server. */
export const DEFAULT_SERVER_PORT = 3890;

/** Default host for the Polpo HTTP server. */
export const DEFAULT_SERVER_HOST = "127.0.0.1";

// .polpo directory layout helpers — canonical home is @polpo-ai/file-stores
export { POLPO_DIR_NAME, getPolpoDir, getGlobalPolpoDir } from "@polpo-ai/file-stores";
