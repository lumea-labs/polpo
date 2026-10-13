import { createHmac } from "node:crypto";
import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRuntime } from "../runtime.js";
import type { ChannelInboundTurn, WhatsAppChannelInstallation } from "../types.js";

const install: WhatsAppChannelInstallation = { provider: "whatsapp", id: "install", credentialRevision: "rev",
  activity: { typing: "off", readReceipt: "off" }, concurrency: { strategy: "queue" },
  credentials: { accessToken: "test", appSecret: "test-secret", phoneNumberId: "phone", verifyToken: "test" } };
const runtimes: ChannelRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.shutdown())); vi.unstubAllGlobals(); });

describe("signed WhatsApp suggestion roundtrip (provider HTTP simulated)", () => {
  it.each([3, 5])("validates the %s-choice callback and sends the stored prompt once", async count => {
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ messages: [{ id: `out-${sent.length}` }] }), { status: 200 });
    }));
    const turns: ChannelInboundTurn[] = [];
    const runtime = new ChannelRuntime({ suggestions: true, stateFactory: () => new MemoryStateAdapter(),
      handleTurn: async turn => {
        turns.push(turn);
        return turn.suggestionSelection ? { text: "Selected" } : { text: "Complete main answer", suggestions: {
          source: { sessionId: "session", assistantMessageId: "assistant", agent: "leo", user: "user" },
          items: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `Choice ${i}`, prompt: `Canonical prompt ${i}` })),
        } };
      } });
    runtimes.push(runtime);
    const webhook = async (message: Record<string, unknown>, valid = true) => {
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "business", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "phone" }, contacts: [{ wa_id: "recipient", profile: { name: "Ada" } }],
        messages: [{ from: "recipient", timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
      } }] }] });
      const signature = valid ? createHmac("sha256", "test-secret").update(body).digest("hex") : "0".repeat(64);
      const pending: Promise<unknown>[] = [];
      const response = await runtime.handleWebhook(install, new Request("https://local.test", { method: "POST", body,
        headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` } }), { waitUntil: task => { pending.push(task); } });
      await Promise.all(pending);
      return response;
    };
    await webhook({ id: "incoming", type: "text", text: { body: "Hello" } });
    expect(sent[0].text.body).toBe("Complete main answer");
    const controls = sent[1].interactive;
    const id = count === 3 ? controls.action.buttons[0].reply.id : controls.action.sections[0].rows[0].id;
    const replyType = count === 3 ? "button_reply" : "list_reply";
    const selection = { id: "click", type: "interactive", context: { id: "out-2" },
      interactive: { type: replyType, [replyType]: { id, title: "UNTRUSTED TITLE" } } };
    expect((await webhook(selection, false)).status).toBe(401);
    expect(turns).toHaveLength(1);
    await webhook({ ...selection, id: "wrong-source", context: { id: "not-the-controls" } });
    expect(turns).toHaveLength(1);
    await webhook(selection);
    expect(turns).toHaveLength(2);
    expect(turns[1].messages[0].text).toBe("Canonical prompt 0");
    expect(turns[1].messages[0].id).toBe("click");
    await webhook({ ...selection, id: "another-click" });
    expect(turns).toHaveLength(2);
    expect(sent.at(-1).text.body).toBe("Selected");
  });
});
