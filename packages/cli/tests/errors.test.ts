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

  describe("passthrough", () => {
    it("returns the original message when no pattern matches", () => {
      expect(friendlyError("connect ECONNREFUSED")).toBe("connect ECONNREFUSED");
    });

    it("returns empty string unchanged", () => {
      expect(friendlyError("")).toBe("");
    });

    it("returns unrelated 4xx/5xx untouched", () => {
      expect(friendlyError("HTTP 404 not found")).toBe("HTTP 404 not found");
      expect(friendlyError("HTTP 500 internal")).toBe("HTTP 500 internal");
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
});
