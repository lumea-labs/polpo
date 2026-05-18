import { describe, it, expect } from "vitest";
import { friendlyError } from "../src/util/errors.js";

describe("friendlyError", () => {
  it("maps 'Multiple projects found' to a projects-set hint", () => {
    expect(friendlyError("Multiple projects found for org foo")).toBe(
      "Multiple projects found. Run: polpo projects set",
    );
  });

  describe("401 variants", () => {
    it("maps 'HTTP 401' to login hint", () => {
      expect(friendlyError("HTTP 401")).toBe(
        "Session expired or invalid. Run: polpo login",
      );
    });

    it("maps 'Unauthorized' to login hint", () => {
      expect(friendlyError("Unauthorized")).toBe(
        "Session expired or invalid. Run: polpo login",
      );
    });

    it("maps mixed-case 'unauthorized' to login hint", () => {
      expect(friendlyError("unauthorized")).toBe(
        "Session expired or invalid. Run: polpo login",
      );
    });

    it("maps 'HTTP 401 Unauthorized' (both markers) to login hint", () => {
      expect(friendlyError("HTTP 401 Unauthorized: stale token")).toBe(
        "Session expired or invalid. Run: polpo login",
      );
    });
  });

  describe("403 variants", () => {
    it("maps 'HTTP 403' to access-denied hint", () => {
      expect(friendlyError("HTTP 403")).toBe(
        "Access denied. Check your credentials or project permissions.",
      );
    });

    it("maps 'Forbidden' to access-denied hint", () => {
      expect(friendlyError("Forbidden")).toBe(
        "Access denied. Check your credentials or project permissions.",
      );
    });

    it("maps mixed-case 'forbidden' to access-denied hint", () => {
      expect(friendlyError("forbidden access")).toBe(
        "Access denied. Check your credentials or project permissions.",
      );
    });
  });

  describe("network errors", () => {
    it("maps ECONNREFUSED to a network hint", () => {
      expect(friendlyError("connect ECONNREFUSED")).toMatch(/Could not reach the Polpo API/);
    });

    it("maps fetch failed to the same hint", () => {
      expect(friendlyError("fetch failed")).toMatch(/Could not reach the Polpo API/);
    });

    it("maps DNS errors (ENOTFOUND, EAI_AGAIN) to the same hint", () => {
      expect(friendlyError("getaddrinfo ENOTFOUND api.polpo.sh")).toMatch(/Could not reach/);
      expect(friendlyError("getaddrinfo EAI_AGAIN")).toMatch(/Could not reach/);
    });
  });

  describe("HTTP status mapping", () => {
    it("maps 404 to a friendly message", () => {
      expect(friendlyError("HTTP 404 not found")).toBe("Resource not found.");
    });

    it("maps 5xx to a service-status hint", () => {
      expect(friendlyError("HTTP 500 internal")).toMatch(/status\.polpo\.sh/);
    });

    it("maps 429 to a rate-limit hint", () => {
      expect(friendlyError("HTTP 429 rate limit exceeded")).toMatch(/Rate limited/);
    });

    it("maps 409 to a conflict hint", () => {
      expect(friendlyError("HTTP 409 Conflict")).toMatch(/already exists/);
    });
  });

  describe("passthrough", () => {
    it("returns empty string unchanged", () => {
      expect(friendlyError("")).toBe("");
    });

    it("returns unrelated free-form messages untouched", () => {
      expect(friendlyError("Something weird happened")).toBe("Something weird happened");
    });
  });

  describe("precedence", () => {
    it("when both 'Multiple projects' and 401 appear, 'Multiple projects' wins (first rule)", () => {
      expect(
        friendlyError("HTTP 401 — Multiple projects found"),
      ).toBe("Multiple projects found. Run: polpo projects set");
    });

    it("when both 401 and 403 appear, 401 wins (evaluated first)", () => {
      expect(friendlyError("HTTP 401 Forbidden")).toBe(
        "Session expired or invalid. Run: polpo login",
      );
    });
  });

  // ── Defensive normalization ─────────────────────────────────────
  //
  // Regression: deploy.ts feeds res.data.error straight into friendlyError,
  // and that field can be an object (Zod issue list), an array, undefined,
  // or null when the server returns a 4xx body that doesn't match the
  // happy-path { error: "…" } shape. Calling `.includes` on a non-string
  // crashed the entire deploy with `TypeError: msg.includes is not a function`.

  describe("accepts non-string inputs without crashing", () => {
    it("undefined → empty string passes through", () => {
      expect(friendlyError(undefined)).toBe("");
    });

    it("null → empty string passes through", () => {
      expect(friendlyError(null)).toBe("");
    });

    it("a Zod-style error object gets JSON-stringified", () => {
      const out = friendlyError({ code: "ValidationError", issues: [{ path: "name", message: "required" }] });
      expect(out).toContain("ValidationError");
      expect(out).toContain("required");
    });

    it("an array of error strings gets JSON-stringified", () => {
      const out = friendlyError(["bad name", "bad model"]);
      expect(out).toContain("bad name");
      expect(out).toContain("bad model");
    });

    it("an Error instance uses its .message", () => {
      const out = friendlyError(new Error("boom"));
      expect(out).toBe("boom");
    });

    it("a number gets coerced safely", () => {
      const out = friendlyError(42);
      expect(out).toBe("42");
    });

    it("an object whose string form matches a pattern still maps to its hint", () => {
      // JSON.stringify of { http: 401 } produces '{"http":401}' — doesn't trigger 401 rule on its own.
      // But if the stringified body contains 'Unauthorized' we should still recognize it.
      const out = friendlyError({ message: "Unauthorized: stale token" });
      expect(out).toBe("Session expired or invalid. Run: polpo login");
    });
  });
});
