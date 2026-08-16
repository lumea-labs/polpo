/**
 * Read projectId from the current project configuration.
 */
import { readPolpoConfig } from "../../util/polpo-config.js";

export function loadProjectId(dir = "."): string | undefined {
  return readPolpoConfig(dir)?.projectId;
}
