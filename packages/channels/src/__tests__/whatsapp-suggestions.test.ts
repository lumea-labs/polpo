import { describe, expect, it, vi, afterEach } from "vitest";
import { createOfficialChannelAdapter } from "../providers.js";
import type { ChannelSuggestionAdapter } from "../types.js";

afterEach(() => vi.unstubAllGlobals());
describe("WhatsApp suggestion transport (simulated Graph HTTP)", () => {
  it.each(["e\u0301", "👩‍👩‍👧‍👦", "👍🏽"])("never cuts grapheme %s while respecting the provider count", async grapheme => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "outbound" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = createOfficialChannelAdapter({ provider: "whatsapp", id: "install", credentialRevision: "rev",
      credentials: { accessToken: "test", appSecret: "test", phoneNumberId: "phone", verifyToken: "test" } }) as ChannelSuggestionAdapter;
    const prefix = "x".repeat(19);
    await adapter.postSuggestionChoices("whatsapp:phone:recipient", [{ id: "one", label: prefix + grapheme + "tail" }]);
    const title = JSON.parse(fetch.mock.calls[0][1].body).interactive.action.buttons[0].reply.title;
    expect(title).toBe(prefix);
    expect([...title].length).toBeLessThanOrEqual(20);
  });
  it("does not collide with a label that already resembles a disambiguation suffix", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "outbound" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = createOfficialChannelAdapter({ provider: "whatsapp", id: "install", credentialRevision: "rev",
      credentials: { accessToken: "test", appSecret: "test", phoneNumberId: "phone", verifyToken: "test" } }) as ChannelSuggestionAdapter;
    await adapter.postSuggestionChoices("whatsapp:phone:recipient", ["abcdefghijklmnopqrstZ", "abcdefghijklmnopqrstQ", "abcdefghijklmnop (1)"].map((label, i) => ({ id: String(i), label })));
    const rows = JSON.parse(fetch.mock.calls[0][1].body).interactive.action.buttons;
    expect(new Set(rows.map((row: any) => row.reply.title)).size).toBe(3);
  });
  it.each([1, 3, 4, 5, 10])("sends all %s choices with distinct Unicode-safe titles", async count => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "outbound" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const adapter = createOfficialChannelAdapter({ provider: "whatsapp", id: "install", credentialRevision: "rev",
      credentials: { accessToken: "test", appSecret: "test", phoneNumberId: "phone", verifyToken: "test" } }) as ChannelSuggestionAdapter;
    const choices = Array.from({ length: count }, (_, i) => ({ id: `opaque-${i}`, label: "😀".repeat(30) }));
    const result = await adapter.postSuggestionChoices("whatsapp:phone:recipient", choices);
    expect(result.id).toBe("outbound");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.to).toBe("recipient");
    expect(body.interactive.type).toBe(count <= 3 ? "button" : "list");
    const rows = count <= 3 ? body.interactive.action.buttons.map((b: any) => b.reply) : body.interactive.action.sections[0].rows;
    expect(rows.map((row: any) => row.id)).toEqual(choices.map(choice => choice.id));
    expect(new Set(rows.map((row: any) => row.title)).size).toBe(count);
    expect(rows.every((row: any) => [...row.title].length <= (count <= 3 ? 20 : 24))).toBe(true);
    expect(rows.every((row: any) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row.title))).toBe(true);
  });
  it.each([0, 11])("rejects %s choices without a network call", async count => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const adapter = createOfficialChannelAdapter({ provider: "whatsapp", id: "install", credentialRevision: "rev",
      credentials: { accessToken: "test", appSecret: "test", phoneNumberId: "phone", verifyToken: "test" } }) as ChannelSuggestionAdapter;
    await expect(adapter.postSuggestionChoices("whatsapp:phone:recipient", Array.from({ length: count }, (_, i) => ({ id: String(i), label: "Next" })))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
