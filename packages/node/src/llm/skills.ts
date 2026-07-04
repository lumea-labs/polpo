/**
 * Polpo Skills System — barrel.
 *
 * Split into two modules:
 *   - skills/discovery.ts   — parsing, discovery, per-agent loading, assignment,
 *                             installation (agent + orchestrator pools)
 *   - skills/index-store.ts — CRUD for the on-disk index (.polpo/skills-index.json)
 *
 * This file re-exports everything so existing `./skills.js` importers keep working.
 */

export * from "./skills/discovery.js";
export * from "./skills/index-store.js";
