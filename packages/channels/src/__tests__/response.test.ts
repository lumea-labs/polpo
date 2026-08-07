import { describe, expect, it } from "vitest";
import {
  channelMessageHardLimit,
  normalizeChannelResponseDeliveryPolicy,
  segmentChannelText,
} from "../response.js";

describe("segmentChannelText", () => {
  it.each(["slack", "telegram", "discord", "whatsapp"] as const)(
    "never exceeds the %s hard limit",
    (provider) => {
      const text = Array.from({ length: 1_200 }, (_, index) =>
        `Paragraph ${index}. This is a complete sentence with unicode è.`,
      ).join("\n\n");
      const segments = segmentChannelText(provider, text);

      expect(segments.length).toBeGreaterThan(1);
      expect(segments.every((part) => part.length <= channelMessageHardLimit(provider))).toBe(true);
      expect(segments.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    },
  );

  it("prefers paragraph and sentence boundaries", () => {
    const text = `${"a".repeat(1_700)}. End.\n\n${"b".repeat(1_700)}. End.`;
    const segments = segmentChannelText("discord", text);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.trimEnd()).toMatch(/End\.$/);
    expect(segments[1]).toMatch(/^b/);
  });

  it("returns no messages for empty output", () => {
    expect(segmentChannelText("telegram", "  \n ")).toEqual([]);
  });

  it("preserves the exact output across message boundaries", () => {
    const text = `  ${"one two.\n\n".repeat(500)}tail  `;
    const segments = segmentChannelText("discord", text);

    expect(segments.join("")).toBe(text);
  });

  it("does not split a unicode surrogate pair at a hard boundary", () => {
    const text = `${"a".repeat(1_999)}😀${"b".repeat(100)}`;
    const segments = segmentChannelText("discord", text);

    expect(segments.join("")).toBe(text);
    expect(segments.every((segment) => !segment.includes("�"))).toBe(true);
    expect(segments[0]?.endsWith("😀")).toBe(false);
    expect(segments[1]?.startsWith("😀")).toBe(true);
  });

  it("keeps short responses in one message by default", () => {
    const text = `${"First sentence. ".repeat(80)}Final sentence.`;

    expect(segmentChannelText("telegram", text)).toEqual([text]);
  });

  it("splits conversational responses on semantic boundaries without losing content", () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `Paragraph ${index}. This thought should stay readable.`,
    ).join("\n\n");
    const segments = segmentChannelText("telegram", text, {
      maxMessages: 6,
      style: "conversational",
      targetCharacters: 240,
    });

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.length).toBeLessThanOrEqual(6);
    expect(segments.slice(0, -1).every((part) => /(?:\.\s|\n\n)$/.test(part))).toBe(true);
    expect(segments.join("")).toBe(text);
  });

  it("honors provider hard limits after the conversational message budget", () => {
    const text = `${"a".repeat(12_000)}😀tail`;
    const segments = segmentChannelText("discord", text, {
      maxMessages: 2,
      style: "conversational",
      targetCharacters: 300,
    });

    expect(segments.every((part) => part.length <= channelMessageHardLimit("discord"))).toBe(true);
    expect(segments.join("")).toBe(text);
    expect(segments.every((part) => !part.includes("�"))).toBe(true);
  });
});

describe("normalizeChannelResponseDeliveryPolicy", () => {
  it("normalizes an explicit conversational policy", () => {
    expect(normalizeChannelResponseDeliveryPolicy({
      maxMessages: 8,
      style: "conversational",
      targetCharacters: 1_000,
    })).toEqual({
      maxMessages: 8,
      style: "conversational",
      targetCharacters: 1_000,
    });
  });

  it("rejects malformed policies instead of silently changing delivery", () => {
    expect(() => normalizeChannelResponseDeliveryPolicy("conversational"))
      .toThrow(/responseDelivery must be an object/);
    expect(() => normalizeChannelResponseDeliveryPolicy({ style: "chatty" }))
      .toThrow(/responseDelivery\.style/);
    expect(() => normalizeChannelResponseDeliveryPolicy({
      style: "conversational",
      targetCharacters: 199,
    })).toThrow(/targetCharacters/);
    expect(() => normalizeChannelResponseDeliveryPolicy({
      maxMessages: 1,
      style: "conversational",
    })).toThrow(/maxMessages/);
    expect(() => normalizeChannelResponseDeliveryPolicy({
      style: "single",
      targetCharacters: 800,
    })).toThrow(/only valid/);
  });
});
