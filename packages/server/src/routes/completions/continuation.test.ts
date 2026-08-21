import { describe, expect, it } from "vitest";
import { continuationFingerprint } from "./continuation.js";

describe("continuationFingerprint", () => {
  it("is stable across nested JSON key ordering", () => {
    const base = {
      sessionId: "session-1",
      agent: "leo",
      loop: "build",
      toolCallId: "call-1",
      expectedSessionVersion: 2,
    };
    expect(continuationFingerprint({
      ...base,
      result: { site: { id: "1", mode: "edit" }, accepted: true },
    })).toBe(continuationFingerprint({
      ...base,
      result: { accepted: true, site: { mode: "edit", id: "1" } },
    }));
  });

  it("changes for a different session boundary or result", () => {
    const base = {
      sessionId: "session-1",
      agent: "leo",
      loop: "build",
      toolCallId: "call-1",
      expectedSessionVersion: 2,
      result: "ok",
    };
    expect(continuationFingerprint(base)).not.toBe(continuationFingerprint({
      ...base,
      sessionId: "session-2",
    }));
    expect(continuationFingerprint(base)).not.toBe(continuationFingerprint({
      ...base,
      result: "different",
    }));
  });

  it("separates direct-chat continuation from a Project Loop handoff", () => {
    const direct = {
      sessionId: "session-1",
      agent: "leo",
      toolCallId: "call-1",
      expectedSessionVersion: 2,
      result: '{"cancelled":true}',
    };

    expect(continuationFingerprint(direct)).not.toBe(continuationFingerprint({
      ...direct,
      loop: "build",
    }));
  });
});
