import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from "@chat-adapter/tests";
import type { Adapter, ChatInstance, MessageData } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRuntime } from "../runtime.js";
import type {
  ChannelInstallation,
  DiscordChannelInstallation,
  TelegramChannelInstallation,
} from "../types.js";

const runtimes: ChannelRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
});

function installation(
  overrides: Partial<TelegramChannelInstallation> = {},
): TelegramChannelInstallation {
  return {
    concurrency: { strategy: "concurrent" },
    credentialRevision: "revision-1",
    credentials: { botToken: "token", secretToken: "secret" },
    id: "installation-1",
    provider: "telegram",
    ...overrides,
  };
}

function discordInstallation(
  overrides: Partial<DiscordChannelInstallation> = {},
): DiscordChannelInstallation {
  return {
    concurrency: { strategy: "concurrent" },
    credentialRevision: "revision-1",
    credentials: {
      applicationId: "application-1",
      botToken: "token",
      publicKey: "a".repeat(64),
    },
    id: "installation-1",
    provider: "discord",
    ...overrides,
  };
}

function webhookRequest(id: string, text = "hello"): Request {
  return new Request("https://example.test/webhook", {
    body: JSON.stringify({ id, text }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function testAdapter(options: {
  disconnect?: () => Promise<void>;
  startTyping?: () => Promise<void>;
} = {}): Adapter {
  let chat: ChatInstance;
  let adapter: Adapter;
  adapter = createMockAdapter("telegram", {
    ...(options.disconnect ? { disconnect: options.disconnect } : {}),
    handleWebhook: async (request, webhookOptions) => {
      const payload = await request.json() as { id: string; text: string };
      await chat.processMessage(
        adapter,
        "telegram:chat-1:thread-1",
        createTestMessage(payload.id, payload.text, {
          author: {
            fullName: "Ada Lovelace",
            isBot: false,
            userId: "user-1",
            userName: "ada",
          },
          metadata: { dateSent: new Date("2026-08-07T12:00:00Z") },
        } satisfies Partial<MessageData>),
        webhookOptions,
      );
      return new Response("ok");
    },
    initialize: async (instance) => {
      chat = instance;
    },
    isDM: () => true,
    persistThreadHistory: true,
    ...(options.startTyping ? { startTyping: options.startTyping } : {}),
  });
  return adapter;
}

function slashCommandAdapter(): Adapter {
  let chat: ChatInstance;
  let adapter: Adapter;
  adapter = createMockAdapter("discord", {
    handleWebhook: async (request, webhookOptions) => {
      const payload = await request.json() as {
        command: string;
        id: string;
        text: string;
      };
      chat.processSlashCommand({
        adapter,
        channelId: "discord:guild-1:channel-1",
        command: payload.command,
        raw: {
          id: payload.id,
          timestamp: "2026-08-07T12:00:00.000Z",
        },
        text: payload.text,
        user: {
          fullName: "Ada Lovelace",
          isBot: false,
          isMe: false,
          userId: "user-1",
          userName: "ada",
        },
      }, webhookOptions);
      return new Response("ok");
    },
    initialize: async (instance) => {
      chat = instance;
    },
  });
  return adapter;
}

function attachmentAdapter(fetchData: () => Promise<Buffer>): Adapter {
  let chat: ChatInstance;
  let adapter: Adapter;
  adapter = createMockAdapter("telegram", {
    handleWebhook: async (_request, webhookOptions) => {
      await chat.processMessage(
        adapter,
        "telegram:chat-1:thread-1",
        createTestMessage("message-with-file", "inspect this", {
          attachments: [{
            fetchData,
            fetchMetadata: { fileId: "provider-file-1" },
            height: 480,
            mimeType: "image/png",
            name: "diagram.png",
            size: 128,
            type: "image",
            width: 640,
          }],
          metadata: { dateSent: new Date("2026-08-07T12:00:00Z") },
        }),
        webhookOptions,
      );
      return new Response("ok");
    },
    initialize: async (instance) => {
      chat = instance;
    },
    isDM: () => true,
    persistThreadHistory: true,
  });
  return adapter;
}

function createRuntime(options: {
  adapter?: Adapter;
  adapterFactory?: (installation: ChannelInstallation) => Adapter;
  coordinateTurn?: ConstructorParameters<typeof ChannelRuntime>[0]["coordinateTurn"];
  handleTurn?: ConstructorParameters<typeof ChannelRuntime>[0]["handleTurn"];
  onEvent?: ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"];
  shouldStartTyping?: ConstructorParameters<typeof ChannelRuntime>[0]["shouldStartTyping"];
} = {}): ChannelRuntime {
  const adapter = options.adapter ?? testAdapter();
  const runtime = new ChannelRuntime({
    adapterFactory: options.adapterFactory ?? (() => adapter),
    coordinateTurn: options.coordinateTurn,
    handleTurn: options.handleTurn ?? (async () => ({ text: "reply" })),
    onEvent: options.onEvent,
    shouldStartTyping: options.shouldStartTyping,
    stateFactory: () => createMockState(),
  });
  runtimes.push(runtime);
  return runtime;
}

describe("ChannelRuntime", () => {
  it("normalizes an inbound message and posts the turn result", async () => {
    const adapter = testAdapter();
    const handleTurn = vi.fn(async () => ({ text: "Hello from Polpo" }));
    const runtime = createRuntime({ adapter, handleTurn });

    const response = await runtime.handleWebhook(
      installation(),
      webhookRequest("message-1"),
    );

    expect(response.status).toBe(200);
    expect(handleTurn).toHaveBeenCalledOnce();
    expect(handleTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "telegram:chat-1",
      credentialRevision: "revision-1",
      installationId: "installation-1",
      isDirectMessage: true,
      provider: "telegram",
      providerEventId: "message-1",
      threadId: "telegram:chat-1:thread-1",
    }));
    expect(handleTurn.mock.calls[0]?.[0].messages[0]).toMatchObject({
      author: { userId: "user-1", userName: "ada" },
      id: "message-1",
      text: "hello",
    });
    expect(adapter.startTyping).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith(
      "telegram:chat-1:thread-1",
      "Hello from Polpo",
    );
  });

  it("preserves lazy authenticated attachment access in normalized turns", async () => {
    const fetchData = vi.fn(async () => Buffer.from("image-bytes"));
    const adapter = attachmentAdapter(fetchData);
    const handleTurn = vi.fn(async () => ({ text: "received" }));
    const runtime = createRuntime({ adapter, handleTurn });

    await runtime.handleWebhook(
      installation(),
      new Request("https://example.test/webhook", { method: "POST" }),
    );

    const attachment = handleTurn.mock.calls[0]?.[0].messages[0]?.attachments[0];
    expect(attachment).toMatchObject({
      fetchMetadata: { fileId: "provider-file-1" },
      height: 480,
      mimeType: "image/png",
      name: "diagram.png",
      size: 128,
      type: "image",
      width: 640,
    });
    expect(attachment?.fetchData).toBe(fetchData);
    await expect(attachment?.fetchData?.()).resolves.toEqual(Buffer.from("image-bytes"));
    expect(fetchData).toHaveBeenCalledOnce();
  });

  it("delivers typed media and generic files without duplicating either", async () => {
    const adapter = testAdapter();
    const runtime = createRuntime({
      adapter,
      handleTurn: async () => ({
        files: [
          {
            data: Buffer.from("image"),
            filename: "preview.png",
            mimeType: "image/png",
            type: "image",
          },
          {
            data: Buffer.from("document"),
            filename: "report.pdf",
            mimeType: "application/pdf",
          },
        ],
        text: "Artifacts ready",
      }),
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-files"));

    expect(adapter.postMessage).toHaveBeenCalledWith(
      "telegram:chat-1:thread-1",
      expect.objectContaining({
        attachments: [expect.objectContaining({
          mimeType: "image/png",
          name: "preview.png",
          type: "image",
        })],
        files: [expect.objectContaining({
          filename: "report.pdf",
          mimeType: "application/pdf",
        })],
        markdown: "Artifacts ready",
      }),
    );
  });

  it("normalizes a slash command into the same provider-neutral turn", async () => {
    const adapter = slashCommandAdapter();
    const handleTurn = vi.fn(async () => ({ text: "Command completed" }));
    const events: Array<{ messageId?: string; name: string }> = [];
    const runtime = createRuntime({
      adapter,
      handleTurn,
      onEvent: (event) => events.push(event),
    });
    const backgroundTasks: Promise<unknown>[] = [];

    const response = await runtime.handleWebhook(
      discordInstallation(),
      new Request("https://example.test/webhook", {
        body: JSON.stringify({
          command: "/ask",
          id: "interaction-1",
          text: "build a report",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { waitUntil: (task) => backgroundTasks.push(task) },
    );
    await Promise.all(backgroundTasks);

    expect(response.status).toBe(200);
    expect(handleTurn).toHaveBeenCalledOnce();
    expect(handleTurn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "discord:guild-1:channel-1",
      credentialRevision: "revision-1",
      installationId: "installation-1",
      isDirectMessage: false,
      provider: "discord",
      providerEventId: "interaction-1",
      threadId: "discord:guild-1:channel-1",
    }));
    expect(handleTurn.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({
        attachments: [],
        author: expect.objectContaining({ userId: "user-1", userName: "ada" }),
        id: "interaction-1",
        isMention: true,
        text: "/ask build a report",
        timestamp: new Date("2026-08-07T12:00:00.000Z"),
      }),
    ]);
    expect(adapter.startTyping).toHaveBeenCalledWith(
      "discord:guild-1:channel-1",
      undefined,
    );
    expect(adapter.postChannelMessage).toHaveBeenCalledWith(
      "discord:guild-1:channel-1",
      "Command completed",
    );
    expect(events).toContainEqual(expect.objectContaining({
      messageId: "interaction-1",
      name: "delivery.completed",
    }));
  });

  it("deduplicates replayed slash commands before agent execution", async () => {
    const adapter = slashCommandAdapter();
    const handleTurn = vi.fn(async () => ({ text: "Command completed" }));
    const runtime = createRuntime({ adapter, handleTurn });
    const request = () => new Request("https://example.test/webhook", {
      body: JSON.stringify({
        command: "/ask",
        id: "interaction-replayed",
        text: "run once",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const backgroundTasks: Promise<unknown>[] = [];
      await runtime.handleWebhook(
        discordInstallation(),
        request(),
        { waitUntil: (task) => backgroundTasks.push(task) },
      );
      await Promise.all(backgroundTasks);
    }

    expect(handleTurn).toHaveBeenCalledOnce();
    expect(adapter.postChannelMessage).toHaveBeenCalledOnce();
  });

  it("deduplicates a replayed provider message", async () => {
    const handleTurn = vi.fn(async () => ({ text: "reply" }));
    const runtime = createRuntime({ handleTurn });

    await runtime.handleWebhook(installation(), webhookRequest("duplicate"));
    await runtime.handleWebhook(installation(), webhookRequest("duplicate"));

    expect(handleTurn).toHaveBeenCalledOnce();
  });

  it("creates one adapter instance under concurrent first use", async () => {
    const adapter = testAdapter();
    const adapterFactory = vi.fn(() => adapter);
    const runtime = createRuntime({ adapterFactory });

    await Promise.all([
      runtime.handleWebhook(installation(), webhookRequest("message-a")),
      runtime.handleWebhook(installation(), webhookRequest("message-b")),
    ]);

    expect(adapterFactory).toHaveBeenCalledOnce();
    expect(runtime.size).toBe(1);
  });

  it("evicts the old adapter when credentials rotate", async () => {
    const disconnectFirst = vi.fn(async () => {});
    const first = testAdapter({ disconnect: disconnectFirst });
    const second = testAdapter();
    const adapterFactory = vi.fn((value: ChannelInstallation) =>
      value.credentialRevision === "revision-1" ? first : second);
    const runtime = createRuntime({ adapterFactory });

    await runtime.handleWebhook(installation(), webhookRequest("message-1"));
    await runtime.handleWebhook(
      installation({ credentialRevision: "revision-2" }),
      webhookRequest("message-2"),
    );

    expect(adapterFactory).toHaveBeenCalledTimes(2);
    expect(disconnectFirst).toHaveBeenCalledOnce();
    expect(runtime.size).toBe(1);
  });

  it("does not fail the agent turn when typing is unsupported", async () => {
    const events: string[] = [];
    const handleTurn = vi.fn(async () => ({ text: "still replied" }));
    const adapter = testAdapter({
      startTyping: async () => {
        throw new Error("typing unavailable");
      },
    });
    const runtime = createRuntime({
      adapter,
      handleTurn,
      onEvent: (event) => {
        events.push(event.name);
      },
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-1"));

    expect(handleTurn).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(events).toContain("typing.failed");
    expect(events).toContain("turn.completed");
  });

  it("lets the host suppress typing without suppressing the turn", async () => {
    const adapter = testAdapter();
    const handleTurn = vi.fn(async () => ({ text: "shadow-safe" }));
    const runtime = createRuntime({
      adapter,
      handleTurn,
      shouldStartTyping: () => false,
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-1"));

    expect(adapter.startTyping).not.toHaveBeenCalled();
    expect(handleTurn).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledOnce();
  });

  it("correlates delivery events with the inbound message", async () => {
    const events: Array<{ name: string; messageId?: string }> = [];
    const runtime = createRuntime({
      handleTurn: async () => ({ text: "reply" }),
      onEvent: (event) => events.push(event),
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-1"));

    expect(events).toContainEqual(expect.objectContaining({
      messageId: "message-1",
      name: "delivery.completed",
    }));
  });

  it("buffers non-native streams and segments them without truncation", async () => {
    const adapter = testAdapter();
    const runtime = createRuntime({
      adapter,
      handleTurn: async () => ({
        stream: (async function* () {
          yield "a".repeat(3_000);
          yield "b".repeat(3_000);
        })(),
      }),
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-1"));

    const posts = vi.mocked(adapter.postMessage).mock.calls
      .map(([, message]) => typeof message === "string" ? message : "")
      .filter(Boolean);
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((part) => part.length <= 4_096)).toBe(true);
    expect(posts.join("")).toBe(`${"a".repeat(3_000)}${"b".repeat(3_000)}`);
  });

  it("serializes overlapping turns for the same thread by default", async () => {
    let active = 0;
    let maxActive = 0;
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    const handleTurn = vi.fn(async (turn) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (turn.providerEventId === "message-1") {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      active -= 1;
      return { text: turn.providerEventId };
    });
    const runtime = createRuntime({ handleTurn });

    const first = runtime.handleWebhook(
      installation(),
      webhookRequest("message-1"),
    );
    await firstStarted.promise;
    const second = runtime.handleWebhook(
      installation(),
      webhookRequest("message-2"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handleTurn).toHaveBeenCalledOnce();
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(handleTurn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("delegates turn coordination to the host when configured", async () => {
    const order: string[] = [];
    const coordinateTurn = vi.fn(async (turn, execute) => {
      order.push(`before:${turn.providerEventId}`);
      await execute();
      order.push(`after:${turn.providerEventId}`);
    });
    const runtime = createRuntime({ coordinateTurn });

    await runtime.handleWebhook(installation(), webhookRequest("message-1"));

    expect(coordinateTurn).toHaveBeenCalledOnce();
    expect(order).toEqual(["before:message-1", "after:message-1"]);
  });
});
