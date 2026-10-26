import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { Hono } from "hono";
import { FileSessionStore } from "../packages/file-stores/src/file-session-store.js";
import { completionRoutes, type CompletionRouteDeps } from "../packages/server/src/routes/completions.js";
import { chatRoutes } from "../packages/server/src/routes/chat.js";
import { getSessionTitleRuntime, withSessionTitleStream } from "../packages/server/src/routes/completions/session-titles.js";
import { PolpoClient } from "../packages/client-sdk/src/client/polpo-client.js";
import { resolveSessionTitleSettings } from "../packages/core/src/session-titles.js";
import { runConversationTurn } from "../packages/server/src/routes/completions/conversation-turn.js";

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).reverse().forEach(fn => fn()); });
function fixture(mode: "inline" | "run" = "inline", generate?: () => Promise<string>) {
  const dir = mkdtempSync(join(tmpdir(), "polpo-titles-http-")); dispose.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileSessionStore(dir), emit = vi.fn(), usage = vi.fn();
  const titleCalls: any[] = [];
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Ciao!" }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } } },
    ] as any[]) }),
    doGenerate: async options => {
      titleCalls.push(options);
      return { content: [{ type: "text", text: generate ? await generate() : "Saluto iniziale" }],
        finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 4 }, outputTokens: { total: 3 } }, warnings: [] };
    },
  } as any);
  const deps: CompletionRouteDeps = {
    getAgents: async () => [{ name: "leo", model: "test/main", reasoning: "high" }],
    getConfig: () => ({ settings: { chatExecution: mode } }), getSessionStore: () => store,
    getStore: () => null, getMemoryStore: () => null, emit, onAuxiliaryModelFinished: usage,
    resolveAgentModel: vi.fn(async () => ({ model: { id: "main", provider: "test", aiModel: model, maxTokens: 8192, contextWindow: 10000 } })),
    buildAgentPrompt: () => "Secret agent instructions", resolveAgentTools: async () => ({ tools: [], executor: async () => "ok" }),
    runChatViaRun: async (_input, hooks) => { hooks.onEvent({ type: "text-delta", text: "Ciao!" }); return { status: "completed", result: { exitCode: 0, stdout: "Ciao!", stderr: "" } }; },
  };
  const app = new Hono(); app.route("/v1/chat/completions", completionRoutes(() => deps));
  app.route("/v1/chat", chatRoutes(() => ({ sessionStore: store, emit })));
  const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch: (url, init) => app.fetch(new Request(url, init)) });
  dispose.push(() => getSessionTitleRuntime(deps)?.dispose());
  return { store, app, client, deps, emit, usage, titleCalls };
}

describe.each(["inline", "run"] as const)("automatic titles on %s HTTP chat", mode => {
  it("names even a greeting in a tool-free call using the conversational model without its reasoning or prompt", async () => {
    const f = fixture(mode);
    const response = await f.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "leo", stream: true, messages: [{ role: "user", content: "ciao" }] }) });
    expect(response.status).toBe(200); const body = await response.text();
    expect(body).toContain("Ciao!");
    await vi.waitFor(() => expect(f.usage).toHaveBeenCalledOnce());
    const [session] = await f.store.listSessions();
    await vi.waitFor(async () => expect(await f.store.getSession(session.id)).toMatchObject({ title: "Saluto iniziale", titleSource: "generated", titleRevision: 1 }));
    expect(f.titleCalls).toHaveLength(1); expect(JSON.stringify(f.titleCalls[0].prompt)).not.toContain("Secret agent instructions");
    expect(f.titleCalls[0].tools ?? []).toHaveLength(0);
    expect(f.deps.resolveAgentModel).toHaveBeenLastCalledWith(expect.objectContaining({ model: "test/main", reasoning: "off" }), "off");
    expect(f.usage).toHaveBeenCalledWith(expect.objectContaining({ operation: "session_title", purpose: "session.title", sessionId: session.id }));
    expect(await f.client.getSessionMetadata(session.id)).toMatchObject({ title: "Saluto iniziale" });
    expect((await f.client.getSessionMessages(session.id)).messages).toHaveLength(2);
  });
  it("finishes the main stream before a slow title and exposes the late persisted result through metadata", async () => {
    let finish!: (title: string) => void;
    const f = fixture(mode, () => new Promise(resolve => { finish = resolve; }));
    const response = await f.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "leo", stream: true, messages: [{ role: "user", content: "ciao" }] }) });
    const body = await response.text(); expect(body).toContain("[DONE]");
    await vi.waitFor(() => expect(f.titleCalls).toHaveLength(1));
    const [session] = await f.store.listSessions(); expect(session.titleGenerationStatus).toBe("pending");
    finish("Conversazione iniziale");
    await vi.waitFor(async () => expect(await f.client.getSessionMetadata(session.id)).toMatchObject({ title: "Conversazione iniziale" }));
    expect(body).not.toContain("Conversazione iniziale");
  });
});

it("manual rename exposes a revision receipt, rejects stale writes, and survives reload", async () => {
  const f = fixture(); const id = await f.store.create({ title: "ciao", titleSource: "provisional" });
  const receipt = await f.client.renameSession(id, "My conversation", 0);
  expect(receipt.session).toMatchObject({ id, titleSource: "manual", titleRevision: 1 });
  await expect(f.client.renameSession(id, "Stale", 0)).rejects.toMatchObject({ status: 409, code: "SESSION_TITLE_REVISION_CONFLICT" });
  expect(await f.client.getSessionMetadata(id)).toMatchObject({ title: "My conversation", titleRevision: 1 });
});

it("names the outer Session of a deterministic Project Loop without naming its steps", async () => {
  const f = fixture();
  f.deps.getAgents = async () => [{ name: "leo", model: "test/main", assignedLoops: ["build"] }];
  f.deps.getProjectLoop = async () => ({ name: "build", start: "work", steps: { work: { type: "tool", tool: "work", next: "end" } } });
  f.deps.resolveAgentTools = async () => ({ tools: [{ name: "work", description: "Work", parameters: { type: "object", properties: {} } }], executor: async () => "Site ready" });
  const response = await f.app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "leo", loop: "build", stream: true, messages: [{ role: "user", content: "Create a site" }] }) });
  expect(response.status).toBe(200); expect(await response.text()).toContain("[DONE]");
  const [session] = await f.store.listSessions();
  await vi.waitFor(async () => expect(await f.store.getSession(session.id)).toMatchObject({ titleSource: "generated" }));
  expect(f.titleCalls).toHaveLength(1); expect(await f.store.listSessions()).toHaveLength(1);
});

it("names Channel conversations but leaves internal agent invocations alone", async () => {
  const f = fixture("run");
  const body = { agent: "leo", stream: false, messages: [{ role: "user" as const, content: "ciao" }] };
  const channel = await runConversationTurn(f.deps, { body, signal: new AbortController().signal, runtime: { surface: "channel", source: "channel" } });
  await vi.waitFor(async () => expect(await f.store.getSession(channel.sessionId!)).toMatchObject({ titleSource: "generated" }));
  const internal = await runConversationTurn(f.deps, { body, signal: new AbortController().signal, runtime: { surface: "agent", source: "internal" } });
  expect(await f.store.getSession(internal.sessionId!)).toMatchObject({ titleSource: "manual", titleGenerationStatus: "skipped" });
  expect(f.titleCalls).toHaveLength(1);
});

it("uses an explicit title model and turns invalid naming configuration into a skipped title", async () => {
  const f = fixture();
  f.deps.getConfig = () => ({ settings: { sessionTitles: { model: "test/small", language: "it" } } });
  const result = await runConversationTurn(f.deps, { body: { agent: "leo", stream: false, messages: [{ role: "user", content: "ciao" }] }, signal: new AbortController().signal });
  await vi.waitFor(async () => expect(await f.store.getSession(result.sessionId!)).toMatchObject({ titleSource: "generated" }));
  expect(f.deps.resolveAgentModel).toHaveBeenCalledWith(expect.objectContaining({ model: "test/small", reasoning: "off" }), "off");
  f.deps.getConfig = () => ({ settings: { sessionTitles: { model: { profile: "missing" } } } });
  const other = await runConversationTurn(f.deps, { body: { agent: "leo", stream: false, messages: [{ role: "user", content: "ciao" }] }, signal: new AbortController().signal });
  expect(await f.store.getSession(other.sessionId!)).toMatchObject({ titleGenerationStatus: "skipped" });
});

it("serializes metadata before DONE and drops updates after close without changing assistant text", async () => {
  const f = fixture(); const id = await f.store.create({ title: "ciao", titleSource: "provisional" });
  await f.store.addMessage(id, "user", "ciao", { sessionTitle: { policy: resolveSessionTitleSettings({}, {}, {}, "test/main"), agentName: "leo" } });
  const frames: string[] = [];
  const runtime = getSessionTitleRuntime(f.deps)!;
  await withSessionTitleStream({ write: async () => {}, writeSSE: async frame => { frames.push(frame.data); } }, { deps: f.deps, sessionId: id, completionId: "completion" }, async writer => {
    await writer.writeSSE({ data: JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }) });
    await runtime.coordinator.run(id);
    await writer.writeSSE({ data: "[DONE]" });
    await f.store.renameSession(id, "Later"); await runtime.coordinator.run(id);
  });
  expect(frames.at(-1)).toBe("[DONE]");
  const titles = frames.filter(frame => frame.includes('"polpo"')).map(frame => JSON.parse(frame));
  expect(titles.at(-1).polpo.session.title).toBe("Saluto iniziale");
  expect(titles.every(frame => Object.keys(frame.choices[0].delta).length === 0)).toBe(true);
  expect(frames.join("\n")).not.toContain("Later");
});
