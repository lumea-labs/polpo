import { describe, expect, it } from "vitest";
import { combineChatSuggestions, normalizeChatSuggestionRequest, resolveChatSuggestionPlan } from "./chat-interactions.js";

const publish = { kind: "action", id: "publish", label: "Publish", action: {
  type: "open_url", url: "https://app.example.test/sites/123?publish",
} } as const;
const billing = { kind: "action", label: "View plan", action: {
  type: "postback", value: "billing:open",
} } as const;

describe("application-provided suggestion actions", () => {
  it("preserves action order and takes an independent validated snapshot", () => {
    const input = { actions: [{ ...publish, label: String(publish.label) }, { ...billing, label: String(billing.label) }] };
    const normalized = normalizeChatSuggestionRequest(input);
    expect(normalized.actions).toEqual([publish, { ...billing, id: "action_2" }]);
    input.actions[0].label = "Changed";
    expect(normalized.actions?.[0].label).toBe("Publish");
  });

  it("reserves the shared count for deterministic actions before model suggestions", () => {
    const plan = resolveChatSuggestionPlan({ maxItems: 5 }, { actions: [publish, billing] });
    expect(plan).toMatchObject({ maxItems: 5, generatedCount: 3,
      actions: [publish, { ...billing, id: "action_2" }], includeKinds: true });
    expect(resolveChatSuggestionPlan({ maxItems: 3 }, true)).toMatchObject({
      maxItems: 3, generatedCount: 3, actions: [], includeKinds: false,
    });
  });

  it.each([
    { actions: [{ ...billing, id: "action_2" }, billing], expected: ["action_2", "action_3"] },
    { actions: [billing, { ...billing, id: "action_1" }], expected: ["action_2", "action_1"] },
  ])("allocates missing IDs without colliding with caller IDs: $expected", ({ actions, expected }) => {
    const input = { actions };
    const first = normalizeChatSuggestionRequest(input);
    expect(first.actions?.map(action => action.id)).toEqual(expected);
    expect(normalizeChatSuggestionRequest(input)).toEqual(first);
  });

  it("preserves opaque postback values exactly", () => {
    const value = "  caller-owned payload  ";
    expect(normalizeChatSuggestionRequest({ actions: [{ ...billing, action: { type: "postback", value } }] })
      .actions?.[0].action).toEqual({ type: "postback", value });
  });

  it("limits the combined result without reordering caller actions", () => {
    const plan = resolveChatSuggestionPlan({ maxItems: 3 }, { maxItems: 2,
      actions: [publish, billing, { ...billing, id: "more", label: "More" }],
    });
    expect(plan.actions.map(item => item.label)).toEqual(["Publish", "View plan"]);
    expect(plan.generatedCount).toBe(0);
  });

  it("combines actions and messages once, preserves legacy message shape and respects opt-out", () => {
    const message = { id: "next", label: "Next", prompt: "What next?" };
    expect(combineChatSuggestions(resolveChatSuggestionPlan({}, { actions: [publish] }), [message])).toEqual([
      publish, { ...message, kind: "message" },
    ]);
    expect(combineChatSuggestions(resolveChatSuggestionPlan({}, true), [message])).toEqual([message]);
    expect(combineChatSuggestions(resolveChatSuggestionPlan({}, false), [message])).toEqual([]);
    expect(combineChatSuggestions(resolveChatSuggestionPlan({}, { actions: [publish] }), [
      { ...message, id: "publish" }, message,
    ])).toHaveLength(2);
  });

  it.each([
    "javascript:alert(1)", "data:text/html,bad", "http://app.example.test", "/relative",
    "https://user:password@app.example.test", "https://app.example.test/\npath",
  ])("rejects unsafe or ambiguous URL %s", url => {
    expect(() => normalizeChatSuggestionRequest({ actions: [{ ...publish, action: { type: "open_url", url } }] })).toThrow();
  });

  it.each([
    [{ ...publish, label: " " }],
    [{ ...publish, id: "invalid id" }],
    [publish, publish],
    [{ ...publish, action: { type: "open_url", url: publish.action.url, trusted: true } }],
    [{ ...publish, action: { type: "postback", value: "" } }],
    [{ ...publish, action: { type: "postback", value: "x".repeat(2001) } }],
    [{ ...publish, action: { type: "execute_tool", name: "publish" } }],
    [{ ...publish, prompt: "Unexpected model input" }],
    Array.from({ length: 6 }, (_, index) => ({ ...publish, id: `action_${index}` })),
  ].map((actions, index) => ({ actions, index })))("rejects malformed action set $index", ({ actions }) => {
    expect(() => normalizeChatSuggestionRequest({ actions })).toThrow();
  });
});
