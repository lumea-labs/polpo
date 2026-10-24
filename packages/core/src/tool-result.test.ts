import { describe, expect, it } from "vitest";
import { normalizeToolOutputText, renderToolResult } from "./tool-result.js";

describe("tool output integrity — production regressions", () => {
  it.each([
    { content: [{ type: "text", text: "Image analysis error: Missing environment variable: ANTHROPIC_API_KEY" }], details: { error: "missing credential" } },
    { content: [{ type: "text", text: "provider unavailable" }], isError: true },
    { content: [], isError: true },
  ])("keeps structured failures recognizable across string executor boundaries", result => {
    expect(renderToolResult(result)).toMatch(/^Error:/);
  });

  it.each([
    "a successful document discussing Error: and failures",
    '{"ok":false,"failures":["typecheck"]}',
    "Image analysis error: quoted in an ordinary document",
  ])("does not infer failure from arbitrary tool content: %s", text => {
    expect(renderToolResult({ content: [{ type: "text", text }], details: {} })).toBe(text);
  });

  it("keeps ordinary text, JSON, emoji and legacy errors unchanged", () => {
    for (const text of ["", "Error: denied", "Caffè € 🐙\n東京", '{"value":"\\u0000"}']) {
      expect(renderToolResult(text)).toBe(text);
    }
  });

  it("renders PostgreSQL-invalid characters explicitly, once, before journal/persistence/model use", () => {
    const html = "<!DOCTYPE html><body>Lagano\u0000</body>";
    expect(normalizeToolOutputText(html)).toBe("<!DOCTYPE html><body>Lagano\\u0000</body>");
    expect(normalizeToolOutputText("x\ud800y\udfffz")).toBe("x\\ud800y\\udfffz");
    expect(normalizeToolOutputText("🐙")).toBe("🐙");
    const once = normalizeToolOutputText(html);
    expect(normalizeToolOutputText(once)).toBe(once);
  });

  it("does not expose credential-bearing error details when rendering public failures", () => {
    expect(renderToolResult({ content: [], details: { error: "postgres://secret@private" } })).toBe("Error: Tool execution failed");
  });

  it("does not collapse content boundaries or stringify arbitrary metadata", () => {
    expect(renderToolResult({ content: [{ type: "text", text: "one" }, { type: "image", data: "secret", mimeType: "image/png" }, { type: "text", text: "two" }], details: { token: "secret" } })).toBe("one\ntwo");
  });

  it("survives 2,000 reproducible adversarial UTF-16 payloads without corrupting valid pairs", () => {
    let seed = 0x5a170023;
    for (let sample = 0; sample < 2000; sample++) {
      let text = "";
      for (let i = 0; i < 64; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += String.fromCharCode(seed & 0xffff);
      }
      const normalized = normalizeToolOutputText(text);
      expect(normalized).not.toContain("\u0000");
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(normalized)).toBe(false);
      expect(normalizeToolOutputText(normalized)).toBe(normalized);
    }
  });
});
