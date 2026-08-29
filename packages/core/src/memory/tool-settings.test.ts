import { describe, expect, it } from "vitest";
import {
  normalizeAgentMemorySettings,
} from "./tool-settings.js";

describe("normalizeAgentMemorySettings", () => {
  it("defaults every typed Memory capability to disabled", () => {
    const normalized = normalizeAgentMemorySettings(undefined);

    expect(normalized).toEqual({
      tools: {
        search: false,
        remember: false,
        update: false,
        forget: false,
        writeScope: "invocation-user",
        writableKinds: [],
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.tools)).toBe(true);
    expect(Object.isFrozen(normalized.tools.writableKinds)).toBe(true);
  });

  it("normalizes and freezes an explicit read/write capability", () => {
    const normalized = normalizeAgentMemorySettings({
      tools: {
        search: true,
        remember: true,
        update: true,
        forget: true,
        writeScope: "invocation-user",
        writableKinds: ["preference", "fact", "preference"],
      },
    });

    expect(normalized).toEqual({
      tools: {
        search: true,
        remember: true,
        update: true,
        forget: true,
        writeScope: "invocation-user",
        writableKinds: ["preference", "fact"],
      },
    });
    expect(Object.isFrozen(normalized.tools.writableKinds)).toBe(true);
  });

  it("allows the advanced agent write scope only when explicitly selected", () => {
    expect(normalizeAgentMemorySettings({
      tools: {
        remember: true,
        writeScope: "agent",
        writableKinds: ["procedure_hint"],
      },
    }).tools.writeScope).toBe("agent");
  });

  it.each([
    null,
    [],
    { unknown: true },
    { tools: null },
    { tools: [] },
    { tools: { unknown: true } },
    { tools: { search: "yes" } },
    { tools: { writeScope: "project" } },
    { tools: { writableKinds: ["secret"] } },
    { tools: { remember: true } },
    { tools: { update: true, writableKinds: [] } },
  ])("rejects malformed or under-authorized settings %#", (value) => {
    expect(() => normalizeAgentMemorySettings(value)).toThrow();
  });
});
