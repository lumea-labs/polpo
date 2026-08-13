import { describe, expect, it } from "vitest";
import {
  normalizeChatInteractionSettings,
  resolveChatInteractionCapabilities,
} from "./chat-interactions.js";

describe("normalizeChatInteractionSettings", () => {
  it("preserves the legacy ask-user default and keeps suggestions disabled", () => {
    expect(normalizeChatInteractionSettings(undefined)).toEqual({
      allowUserQuestions: true,
      suggestions: {
        enabled: false,
        maxItems: 3,
      },
    });
  });

  it("normalizes bounded suggestion settings", () => {
    expect(normalizeChatInteractionSettings({
      allowUserQuestions: false,
      suggestions: {
        enabled: true,
        maxItems: 4,
        guidance: "  Prefer concrete next actions.  ",
      },
    })).toEqual({
      allowUserQuestions: false,
      suggestions: {
        enabled: true,
        maxItems: 4,
        guidance: "Prefer concrete next actions.",
      },
    });
  });

  it.each([0, 1, 5, 99, 2.5])("rejects maxItems=%s", (maxItems) => {
    expect(() => normalizeChatInteractionSettings({
      suggestions: { enabled: true, maxItems },
    })).toThrow("maxItems");
  });

  it("rejects oversized guidance", () => {
    expect(() => normalizeChatInteractionSettings({
      suggestions: { enabled: true, guidance: "x".repeat(501) },
    })).toThrow("guidance");
  });
});

describe("resolveChatInteractionCapabilities", () => {
  it("keeps ask-user compatible for API callers when capability is omitted", () => {
    expect(resolveChatInteractionCapabilities({ surface: "api" })).toEqual({
      askUserQuestion: true,
      suggestions: false,
    });
  });

  it("requires an explicit client capability for suggestions", () => {
    expect(resolveChatInteractionCapabilities({
      surface: "api",
      settings: { suggestions: { enabled: true } },
      client: { suggestions: true },
    })).toEqual({
      askUserQuestion: true,
      suggestions: true,
    });
  });

  it("lets either the agent or client disable ask-user", () => {
    expect(resolveChatInteractionCapabilities({
      surface: "api",
      settings: { allowUserQuestions: false },
      client: { ask_user_question: true },
    }).askUserQuestion).toBe(false);
    expect(resolveChatInteractionCapabilities({
      surface: "api",
      client: { ask_user_question: false },
    }).askUserQuestion).toBe(false);
  });

  it("disables interactive chat extensions on channel surfaces", () => {
    expect(resolveChatInteractionCapabilities({
      surface: "channel",
      settings: {
        allowUserQuestions: true,
        suggestions: { enabled: true },
      },
      client: {
        ask_user_question: true,
        suggestions: true,
      },
    })).toEqual({
      askUserQuestion: false,
      suggestions: false,
    });
  });
});
