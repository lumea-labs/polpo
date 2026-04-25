import { describe, it, expect } from "vitest";
import { EVENT_CATALOG } from "../events-catalog.js";

/**
 * Drift guard for the public event catalog.
 *
 * The catalog is intentionally narrower than `PolpoEventMap` (which
 * includes types for events the cloud doesn't yet forward). Instead of
 * cross-checking against `PolpoEventMap`, this test pins:
 *
 *  1. Shape — every entry has a non-empty namespace, label, description,
 *     and at least one event with both `key` and `description`.
 *  2. Uniqueness — fully-qualified `${ns}:${key}` names never collide.
 *  3. Stability — the count of fully-qualified keys is asserted; if the
 *     catalog grows or shrinks, this test fails so the change is
 *     intentional and visible in the PR.
 *
 * When you wire a new event through the cloud `cloud:event` bus (or
 * remove one), update both the catalog and the count below in the same
 * PR.
 */
describe("EVENT_CATALOG", () => {
  it("has a well-formed shape for every group", () => {
    expect(EVENT_CATALOG.length).toBeGreaterThan(0);
    for (const group of EVENT_CATALOG) {
      expect(group.ns).toMatch(/^[a-z][a-z_]*$/);
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.description.length).toBeGreaterThan(0);
      expect(group.events.length).toBeGreaterThan(0);
      for (const ev of group.events) {
        expect(ev.key.length).toBeGreaterThan(0);
        expect(ev.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("never duplicates fully-qualified event names", () => {
    const seen = new Set<string>();
    for (const group of EVENT_CATALOG) {
      for (const ev of group.events) {
        const fq = `${group.ns}:${ev.key}`;
        expect(seen.has(fq), `duplicate event ${fq}`).toBe(false);
        seen.add(fq);
      }
    }
  });

  it("publishes a stable, intentional count of events", () => {
    // Pin the total. Bump this number in the same PR that adds/removes
    // events from the catalog so reviewers can spot drift.
    const EXPECTED_TOTAL = 12;
    const actual = EVENT_CATALOG.reduce((sum, g) => sum + g.events.length, 0);
    expect(actual).toBe(EXPECTED_TOTAL);
  });
});
