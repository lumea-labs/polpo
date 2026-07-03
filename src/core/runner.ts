#!/usr/bin/env node
/**
 * Detached subprocess runner — historical entry path.
 *
 * The cloud sandbox executes `node_modules/polpo-ai/dist/core/runner.js`
 * directly, so this path must keep working: the actual runner (which
 * self-executes on import) lives in @polpo-ai/node.
 */
import "@polpo-ai/node/runner";
