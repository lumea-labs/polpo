import { describe, expect, it } from "vitest";

import {
  ConnectionSelectionError,
  getConnectionSlotSpecErrors,
  normalizeConnectionSlotSpecs,
} from "./connection-capability.js";

describe("connection capability contracts", () => {
  it("normalizes and freezes logical slot declarations", () => {
    const slots = normalizeConnectionSlotSpecs({
      siteApi: {
        provider: " sitoinchat ",
        scopes: ["site:read", "site:write", "site:read"],
        description: " Site operations ",
      },
    });

    expect(slots).toEqual({
      siteApi: {
        provider: "sitoinchat",
        scopes: ["site:read", "site:write"],
        description: "Site operations",
      },
    });
    expect(Object.isFrozen(slots)).toBe(true);
    expect(Object.isFrozen(slots.siteApi)).toBe(true);
    expect(Object.isFrozen(slots.siteApi.scopes)).toBe(true);
  });

  it("rejects malformed, unsafe, and unbounded declarations", () => {
    for (const slots of [
      null,
      [],
      { __proto__: { scopes: ["read"] } },
      { constructor: { scopes: ["read"] } },
      { "bad-slot": { scopes: ["read"] } },
      { siteApi: null },
      { siteApi: { scopes: [] } },
      { siteApi: { scopes: [""] } },
      { siteApi: { scopes: ["read"], provider: "UPPER CASE" } },
      { siteApi: { scopes: ["read"], unknown: true } },
    ]) {
      expect(getConnectionSlotSpecErrors(slots).length).toBeGreaterThan(0);
      expect(() => normalizeConnectionSlotSpecs(slots)).toThrow(ConnectionSelectionError);
    }
  });

  it("uses stable public error codes and statuses", () => {
    expect(new ConnectionSelectionError(
      "connection_scope_denied",
      "denied",
      { slot: "siteApi" },
    )).toMatchObject({ status: 403, slot: "siteApi" });
    expect(new ConnectionSelectionError(
      "connection_not_found_for_scope",
      "missing",
    ).status).toBe(404);
    expect(new ConnectionSelectionError(
      "connection_selection_ambiguous",
      "ambiguous",
    ).status).toBe(409);
    expect(new ConnectionSelectionError(
      "connection_slot_invalid",
      "invalid",
    ).status).toBe(422);
    expect(new ConnectionSelectionError(
      "connection_resolver_unavailable",
      "unavailable",
    ).status).toBe(503);
  });
});
