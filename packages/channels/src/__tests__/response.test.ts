import { describe, expect, it } from "vitest";
import { channelMessageHardLimit, segmentChannelText } from "../response.js";

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
});
