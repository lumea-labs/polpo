import {
  createMockAdapter,
  createMockState,
  createTestMessage,
} from "@chat-adapter/tests";
import { emoji, type Adapter, type ChatInstance, type MessageData } from "chat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficialChannelAdapter } from "../providers.js";
import { ChannelRuntime } from "../runtime.js";
import type {
  ChannelInstallation,
  DiscordChannelInstallation,
  TelegramChannelInstallation,
} from "../types.js";

const runtimes: ChannelRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  vi.unstubAllGlobals();
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
  stream?: Adapter["stream"];
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
    ...(options.stream ? { stream: options.stream } : {}),
  });
  return adapter;
}

function richEventAdapter(): Adapter {
  let chat: ChatInstance;
  let adapter: Adapter;
  adapter = createMockAdapter("slack", {
    handleWebhook: async (request, webhookOptions) => {
      const payload = await request.json() as { kind: string };
      const user = {
        fullName: "Ada Lovelace",
        isBot: false,
        isMe: false,
        userId: "user-1",
        userName: "ada",
      };
      if (payload.kind === "action") {
        await chat.processAction({
          actionId: "approve",
          adapter,
          messageId: "message-1",
          raw: { id: "action-1" },
          threadId: "slack:channel-1:thread-1",
          user,
          value: "order-42",
        }, webhookOptions);
      } else if (payload.kind === "reaction") {
        chat.processReaction({
          added: true,
          adapter,
          emoji: emoji.thumbs_up,
          messageId: "message-1",
          raw: { id: "reaction-1" },
          rawEmoji: "+1",
          threadId: "slack:channel-1:thread-1",
          user,
        }, webhookOptions);
      } else if (payload.kind === "modal") {
        const result = await chat.processModalSubmit({
          adapter,
          callbackId: "feedback",
          raw: { id: "modal-1" },
          user,
          values: { feedback: "Ship it" },
          viewId: "view-1",
        }, undefined, webhookOptions);
        return Response.json(result ?? null);
      } else if (payload.kind === "modal-close") {
        chat.processModalClose({
          adapter,
          callbackId: "feedback",
          raw: { id: "modal-close-1" },
          user,
          viewId: "view-1",
        }, undefined, webhookOptions);
      } else if (payload.kind === "options") {
        const result = await chat.processOptionsLoad({
          actionId: "assignee",
          adapter,
          query: "ada",
          raw: { id: "options-1" },
          user,
        }, webhookOptions);
        return Response.json(result ?? null);
      }
      return new Response("ok");
    },
    initialize: async (instance) => {
      chat = instance;
    },
    isDM: () => false,
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
  coordinateEvent?: ConstructorParameters<typeof ChannelRuntime>[0]["coordinateEvent"];
  handleEvent?: ConstructorParameters<typeof ChannelRuntime>[0]["handleEvent"];
  handleTurn?: ConstructorParameters<typeof ChannelRuntime>[0]["handleTurn"];
  observabilityTimeoutMs?: ConstructorParameters<typeof ChannelRuntime>[0]["observabilityTimeoutMs"];
  onEvent?: ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"];
  shouldStartTyping?: ConstructorParameters<typeof ChannelRuntime>[0]["shouldStartTyping"];
} = {}): ChannelRuntime {
  const adapter = options.adapter ?? testAdapter();
  const runtime = new ChannelRuntime({
    adapterFactory: options.adapterFactory ?? (() => adapter),
    coordinateTurn: options.coordinateTurn,
    coordinateEvent: options.coordinateEvent,
    handleEvent: options.handleEvent,
    handleTurn: options.handleTurn ?? (async () => ({ text: "reply" })),
    observabilityTimeoutMs: options.observabilityTimeoutMs,
    onEvent: options.onEvent,
    shouldStartTyping: options.shouldStartTyping,
    stateFactory: () => createMockState(),
  });
  runtimes.push(runtime);
  return runtime;
}

describe("ChannelRuntime", () => {
  it("combines a Telegram media group into one ordered Polpo turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      result: { first_name: "Polpo", id: 999, is_bot: true, username: "polpo" },
    })));
    const handleTurn = vi.fn(async () => ({}));
    const runtime = createRuntime({
      adapter: createOfficialChannelAdapter(installation({ typingEnabled: false })),
      handleTurn,
    });
    const backgroundTasks: Promise<unknown>[] = [];
    const mediaGroupRequest = (
      updateId: number,
      messageId: number,
      fileId: string,
      caption?: string,
    ) => new Request("https://example.test/webhook", {
      body: JSON.stringify({
        update_id: updateId,
        message: {
          ...(caption ? { caption } : {}),
          chat: { first_name: "Ada", id: 12345, type: "private" },
          date: 1_786_000_001,
          from: { first_name: "Ada", id: 456, is_bot: false, username: "ada" },
          media_group_id: "album-1",
          message_id: messageId,
          photo: [{
            file_id: fileId,
            file_size: 128,
            file_unique_id: `${fileId}-unique`,
            height: 480,
            width: 640,
          }],
        },
      }),
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "secret",
      },
      method: "POST",
    });

    await Promise.all([
      runtime.handleWebhook(
        installation({ typingEnabled: false }),
        mediaGroupRequest(101, 11, "file-1", "Inspect these images"),
        { waitUntil: (task) => backgroundTasks.push(task) },
      ),
      runtime.handleWebhook(
        installation({ typingEnabled: false }),
        mediaGroupRequest(102, 12, "file-2"),
        { waitUntil: (task) => backgroundTasks.push(task) },
      ),
    ]);
    await Promise.all(backgroundTasks);

    const retryTasks: Promise<unknown>[] = [];
    await runtime.handleWebhook(
      installation({ typingEnabled: false }),
      mediaGroupRequest(101, 11, "file-1", "Inspect these images"),
      { waitUntil: (task) => retryTasks.push(task) },
    );
    await Promise.all(retryTasks);

    expect(handleTurn).toHaveBeenCalledOnce();
    expect(handleTurn.mock.calls[0]?.[0]).toMatchObject({
      coordination: {
        grouped: false,
        messageCount: 1,
        messageIds: ["12345:12"],
        primaryMessageId: "12345:12",
      },
      providerEventId: "telegram:12345:media-group:album-1",
      threadId: "telegram:12345",
    });
    expect(handleTurn.mock.calls[0]?.[0].messages).toHaveLength(1);
    expect(handleTurn.mock.calls[0]?.[0].messages[0]).toMatchObject({
      id: "12345:12",
      text: "Inspect these images",
    });
    expect(handleTurn.mock.calls[0]?.[0].messages[0].attachments).toEqual([
      expect.objectContaining({
        fetchMetadata: expect.objectContaining({ fileId: "file-1" }),
        type: "image",
      }),
      expect.objectContaining({
        fetchMetadata: expect.objectContaining({ fileId: "file-2" }),
        type: "image",
      }),
    ]);
  });

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
      coordination: {
        grouped: false,
        messageCount: 1,
        messageIds: ["message-1"],
        primaryMessageId: "message-1",
        strategy: "concurrent",
      },
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

  it("describes every message collapsed into a burst turn", async () => {
    const handleTurn = vi.fn(async () => ({ text: "One reply" }));
    const events: ConstructorParameters<NonNullable<
      ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"]
    >>[0][] = [];
    const runtime = createRuntime({
      handleTurn,
      onEvent: (event) => events.push(event),
    });
    const burstInstallation = installation({
      concurrency: {
        debounceMs: 25,
        maxQueueSize: 20,
        onQueueFull: "drop-oldest",
        queueEntryTtlMs: 120_000,
        strategy: "burst",
      },
    });

    const first = runtime.handleWebhook(
      burstInstallation,
      webhookRequest("message-1", "first"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = runtime.handleWebhook(
      burstInstallation,
      webhookRequest("message-2", "second"),
    );
    const third = runtime.handleWebhook(
      burstInstallation,
      webhookRequest("message-3", "third"),
    );
    await Promise.all([first, second, third]);

    expect(handleTurn).toHaveBeenCalledOnce();
    expect(handleTurn).toHaveBeenCalledWith(expect.objectContaining({
      coordination: {
        grouped: true,
        messageCount: 3,
        messageIds: ["message-1", "message-2", "message-3"],
        primaryMessageId: "message-3",
        strategy: "burst",
      },
      providerEventId: "message-3",
    }));
    expect(handleTurn.mock.calls[0]?.[0].messages.map((message) => message.text))
      .toEqual(["first", "second", "third"]);
    expect(events).toContainEqual(expect.objectContaining({
      details: { debounceMs: 25 },
      messageId: "message-1",
      name: "transport.message.debouncing",
      threadId: "telegram:chat-1:thread-1",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      details: { queueDepth: 2 },
      messageId: "message-3",
      name: "transport.message.queued",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      details: { skippedCount: 2, totalSinceLastHandler: 3 },
      messageId: "message-3",
      name: "transport.message.dequeued",
    }));
  });

  it("records queue coordination while preserving every skipped message", async () => {
    const activeTurn = deferred<void>();
    const started = deferred<void>();
    const turns: string[][] = [];
    const events: ConstructorParameters<NonNullable<
      ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"]
    >>[0][] = [];
    const runtime = createRuntime({
      handleTurn: async (turn) => {
        turns.push(turn.messages.map((message) => message.text));
        if (turn.providerEventId === "message-1") {
          started.resolve();
          await activeTurn.promise;
        }
        return { text: "done" };
      },
      onEvent: (event) => events.push(event),
    });
    const queuedInstallation = installation({
      concurrency: {
        maxQueueSize: 5,
        onQueueFull: "drop-oldest",
        queueEntryTtlMs: 120_000,
        strategy: "queue",
      },
    });

    const first = runtime.handleWebhook(
      queuedInstallation,
      webhookRequest("message-1", "first"),
    );
    await started.promise;
    const second = runtime.handleWebhook(
      queuedInstallation,
      webhookRequest("message-2", "second"),
    );
    const third = runtime.handleWebhook(
      queuedInstallation,
      webhookRequest("message-3", "third"),
    );
    await Promise.all([second, third]);
    activeTurn.resolve();
    await first;

    expect(turns).toEqual([["first"], ["second", "third"]]);
    expect(events).toContainEqual(expect.objectContaining({
      details: { queueDepth: 1 },
      messageId: "message-3",
      name: "transport.message.queued",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      details: { skippedCount: 1, totalSinceLastHandler: 2 },
      messageId: "message-3",
      name: "transport.message.dequeued",
    }));
    expect(JSON.stringify(events)).not.toContain("lockKey");
    expect(JSON.stringify(events)).not.toContain("token");
  });

  it("records and rejects the newest message when a bounded queue is full", async () => {
    const activeTurn = deferred<void>();
    const started = deferred<void>();
    const turns: string[] = [];
    const events: ConstructorParameters<NonNullable<
      ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"]
    >>[0][] = [];
    const runtime = createRuntime({
      handleTurn: async (turn) => {
        turns.push(turn.providerEventId);
        if (turn.providerEventId === "message-1") {
          started.resolve();
          await activeTurn.promise;
        }
        return { text: "done" };
      },
      onEvent: (event) => events.push(event),
    });
    const boundedInstallation = installation({
      concurrency: {
        maxQueueSize: 1,
        onQueueFull: "drop-newest",
        queueEntryTtlMs: 120_000,
        strategy: "queue",
      },
    });

    const first = runtime.handleWebhook(
      boundedInstallation,
      webhookRequest("message-1"),
    );
    await started.promise;
    await runtime.handleWebhook(boundedInstallation, webhookRequest("message-2"));
    await runtime.handleWebhook(boundedInstallation, webhookRequest("message-3"));
    activeTurn.resolve();
    await first;

    expect(turns).toEqual(["message-1", "message-2"]);
    expect(events).toContainEqual(expect.objectContaining({
      details: { reason: "queue-full" },
      messageId: "message-3",
      name: "transport.message.dropped",
    }));
  });

  it("records a lock-conflicting message dropped by the drop strategy", async () => {
    const activeTurn = deferred<void>();
    const started = deferred<void>();
    const events: ConstructorParameters<NonNullable<
      ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"]
    >>[0][] = [];
    const runtime = createRuntime({
      handleTurn: async (turn) => {
        if (turn.providerEventId === "message-1") {
          started.resolve();
          await activeTurn.promise;
        }
        return { text: "done" };
      },
      onEvent: (event) => events.push(event),
    });
    const dropInstallation = installation({ concurrency: { strategy: "drop" } });

    const first = runtime.handleWebhook(
      dropInstallation,
      webhookRequest("message-1"),
    );
    await started.promise;
    await expect(runtime.handleWebhook(
      dropInstallation,
      webhookRequest("message-2"),
    )).rejects.toThrow(/could not acquire lock/i);
    activeTurn.resolve();
    await first;

    expect(events).toContainEqual(expect.objectContaining({
      details: { reason: "lock-busy" },
      messageId: "message-2",
      name: "transport.message.dropped",
      threadId: "telegram:chat-1:thread-1",
    }));
  });

  it("records queued messages that expire before the active turn completes", async () => {
    const activeTurn = deferred<void>();
    const started = deferred<void>();
    const turns: string[] = [];
    const events: ConstructorParameters<NonNullable<
      ConstructorParameters<typeof ChannelRuntime>[0]["onEvent"]
    >>[0][] = [];
    const runtime = createRuntime({
      handleTurn: async (turn) => {
        turns.push(turn.providerEventId);
        if (turn.providerEventId === "message-1") {
          started.resolve();
          await activeTurn.promise;
        }
        return { text: "done" };
      },
      onEvent: (event) => events.push(event),
    });
    const expiringInstallation = installation({
      concurrency: {
        maxQueueSize: 5,
        onQueueFull: "drop-oldest",
        queueEntryTtlMs: 1,
        strategy: "queue",
      },
    });

    const first = runtime.handleWebhook(
      expiringInstallation,
      webhookRequest("message-1"),
    );
    await started.promise;
    await runtime.handleWebhook(expiringInstallation, webhookRequest("message-2"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeTurn.resolve();
    await first;

    expect(turns).toEqual(["message-1"]);
    expect(events).toContainEqual(expect.objectContaining({
      messageId: "message-2",
      name: "transport.message.expired",
    }));
  });

  it("never lets a failing observability hook break channel processing", async () => {
    const adapter = testAdapter();
    const runtime = createRuntime({
      adapter,
      onEvent: async () => {
        throw new Error("telemetry unavailable");
      },
    });

    await expect(runtime.handleWebhook(
      installation({
        concurrency: {
          debounceMs: 1,
          maxQueueSize: 5,
          onQueueFull: "drop-oldest",
          queueEntryTtlMs: 120_000,
          strategy: "burst",
        },
      }),
      webhookRequest("message-1"),
    )).resolves.toMatchObject({ status: 200 });
    expect(adapter.postMessage).toHaveBeenCalledOnce();
  });

  it("bounds a stalled observability hook and suppresses repeated stalls", async () => {
    const adapter = testAdapter();
    const onEvent = vi.fn(() => new Promise<void>(() => {}));
    const runtime = createRuntime({
      adapter,
      observabilityTimeoutMs: 5,
      onEvent,
    });

    const startedAt = Date.now();
    await expect(runtime.handleWebhook(
      installation(),
      webhookRequest("message-1"),
    )).resolves.toMatchObject({ status: 200 });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledOnce();
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

  it("preserves formatted content, links, and edit metadata", async () => {
    let chat: ChatInstance;
    let adapter: Adapter;
    adapter = createMockAdapter("telegram", {
      handleWebhook: async (_request, webhookOptions) => {
        await chat.processMessage(
          adapter,
          "telegram:chat-1:thread-1",
          createTestMessage("formatted-message", "Read the docs", {
            formatted: {
              type: "root",
              children: [{
                type: "paragraph",
                children: [{ type: "text", value: "Read the docs" }],
              }],
            },
            links: [{ title: "Docs", url: "https://example.test/docs" }],
            metadata: {
              dateSent: new Date("2026-08-07T12:00:00Z"),
              edited: true,
              editedAt: new Date("2026-08-07T12:01:00Z"),
            },
          }),
          webhookOptions,
        );
        return new Response("ok");
      },
      initialize: async (instance) => {
        chat = instance;
      },
      isDM: () => true,
    });
    const handleTurn = vi.fn(async () => ({ text: "received" }));
    const runtime = createRuntime({ adapter, handleTurn });

    await runtime.handleWebhook(
      installation(),
      new Request("https://example.test/webhook", { method: "POST" }),
    );

    expect(handleTurn.mock.calls[0]?.[0].messages[0]).toMatchObject({
      edited: true,
      editedAt: new Date("2026-08-07T12:01:00Z"),
      formatted: { type: "root" },
      links: [{ title: "Docs", url: "https://example.test/docs" }],
    });
  });

  it("dispatches typed action, reaction, and modal events", async () => {
    const adapter = richEventAdapter();
    const handleEvent = vi.fn(async (event) => {
      if (event.type === "modal.submit") {
        return { modalResponse: { action: "errors", errors: { feedback: "Too short" } } };
      }
      if (event.type === "options.load") return { options: [] };
      return { text: `handled:${event.type}` };
    });
    const runtime = createRuntime({ adapter, handleEvent });

    for (const kind of ["action", "reaction"] as const) {
      const backgroundTasks: Promise<unknown>[] = [];
      await runtime.handleWebhook(
        { ...installation(), provider: "slack", credentials: { botToken: "token", signingSecret: "secret" } },
        new Request("https://example.test/webhook", {
          body: JSON.stringify({ kind }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { waitUntil: (task) => backgroundTasks.push(task) },
      );
      await Promise.all(backgroundTasks);
    }
    const modalResponse = await runtime.handleWebhook(
      { ...installation(), provider: "slack", credentials: { botToken: "token", signingSecret: "secret" } },
      new Request("https://example.test/webhook", {
        body: JSON.stringify({ kind: "modal" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const backgroundTasks: Promise<unknown>[] = [];
    await runtime.handleWebhook(
      { ...installation(), provider: "slack", credentials: { botToken: "token", signingSecret: "secret" } },
      new Request("https://example.test/webhook", {
        body: JSON.stringify({ kind: "modal-close" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { waitUntil: (task) => backgroundTasks.push(task) },
    );
    await Promise.all(backgroundTasks);
    const optionsResponse = await runtime.handleWebhook(
      { ...installation(), provider: "slack", credentials: { botToken: "token", signingSecret: "secret" } },
      new Request("https://example.test/webhook", {
        body: JSON.stringify({ kind: "options" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(handleEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "action",
      "reaction",
      "modal.submit",
      "modal.close",
      "options.load",
    ]);
    expect(handleEvent.mock.calls[0]?.[0]).toMatchObject({
      actionId: "approve",
      value: "order-42",
      user: { userId: "user-1" },
    });
    expect(handleEvent.mock.calls[1]?.[0]).toMatchObject({
      added: true,
      emoji: "thumbs_up",
      rawEmoji: "+1",
    });
    await expect(modalResponse.json()).resolves.toEqual({
      action: "errors",
      errors: { feedback: "Too short" },
    });
    await expect(optionsResponse.json()).resolves.toEqual([]);
    expect(adapter.postMessage).toHaveBeenCalledWith(
      "slack:channel-1:thread-1",
      "handled:action",
    );
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

  it("delivers native Chat SDK postables without flattening them", async () => {
    const adapter = testAdapter();
    const runtime = createRuntime({
      adapter,
      handleTurn: async () => ({
        posts: [{ markdown: "**Approved**" }, { raw: "provider-native" }],
      }),
    });

    await runtime.handleWebhook(installation(), webhookRequest("native-postables"));

    expect(adapter.postMessage).toHaveBeenNthCalledWith(
      1,
      "telegram:chat-1:thread-1",
      { markdown: "**Approved**" },
    );
    expect(adapter.postMessage).toHaveBeenNthCalledWith(
      2,
      "telegram:chat-1:thread-1",
      { raw: "provider-native" },
    );
  });

  it("rejects ambiguous native and convenience output before delivery", async () => {
    const adapter = testAdapter();
    const runtime = createRuntime({
      adapter,
    });

    await expect(runtime.post(
      installation(),
      "telegram:chat-1:thread-1",
      { posts: [{ markdown: "native" }], text: "duplicate" },
    )).rejects.toThrow(/native posts cannot be combined/i);
    expect(adapter.postMessage).not.toHaveBeenCalled();
  });

  it("initializes the adapter and returns normalized thread delivery ids", async () => {
    const adapter = testAdapter();
    const initialize = vi.spyOn(adapter, "initialize");
    vi.mocked(adapter.postMessage).mockResolvedValue({
      id: "provider-message-1",
      raw: { ok: true },
      threadId: "telegram:chat-1:thread-1",
    });
    const runtime = createRuntime({ adapter });

    const delivery = await runtime.post(
      installation(),
      "telegram:chat-1:thread-1",
      "Scheduled result",
    );

    expect(initialize).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith(
      "telegram:chat-1:thread-1",
      "Scheduled result",
    );
    expect(delivery).toEqual({
      channelId: "telegram:chat-1",
      messages: [{
        id: "provider-message-1",
        threadId: "telegram:chat-1:thread-1",
      }],
      threadId: "telegram:chat-1:thread-1",
    });
  });

  it("posts outside a webhook through the official channel adapter", async () => {
    const adapter = testAdapter();
    const initialize = vi.spyOn(adapter, "initialize");
    vi.mocked(adapter.postChannelMessage!).mockResolvedValue({
      id: "provider-message-2",
      raw: { ok: true },
      threadId: "telegram:chat-1",
    });
    const runtime = createRuntime({ adapter });

    const delivery = await runtime.postChannel(
      installation(),
      "telegram:chat-1",
      "Proactive update",
    );

    expect(initialize).toHaveBeenCalledOnce();
    expect(adapter.postChannelMessage).toHaveBeenCalledWith(
      "telegram:chat-1",
      "Proactive update",
    );
    expect(delivery).toEqual({
      channelId: "telegram:chat-1",
      messages: [{
        id: "provider-message-2",
        threadId: "telegram:chat-1",
      }],
    });
  });

  it("returns every provider message id from segmented proactive delivery", async () => {
    const adapter = testAdapter();
    vi.mocked(adapter.postMessage)
      .mockResolvedValueOnce({
        id: "provider-segment-1",
        raw: { ok: true },
        threadId: "telegram:chat-1:thread-1",
      })
      .mockResolvedValueOnce({
        id: "provider-segment-2",
        raw: { ok: true },
        threadId: "telegram:chat-1:thread-1",
      });
    const runtime = createRuntime({ adapter });

    const delivery = await runtime.post(
      installation({
        responseDelivery: {
          maxMessages: 2,
          style: "conversational",
          targetCharacters: 200,
        },
      }),
      "telegram:chat-1:thread-1",
      `${"A".repeat(210)}.\n\n${"B".repeat(210)}.`,
    );

    expect(adapter.postMessage).toHaveBeenCalledTimes(2);
    expect(delivery.messages).toEqual([
      {
        id: "provider-segment-1",
        threadId: "telegram:chat-1:thread-1",
      },
      {
        id: "provider-segment-2",
        threadId: "telegram:chat-1:thread-1",
      },
    ]);
  });

  it("emits a correlated failure when proactive delivery fails", async () => {
    const adapter = testAdapter();
    vi.mocked(adapter.postMessage).mockRejectedValue(
      new Error("provider unavailable"),
    );
    const events: Array<{ error?: string; name: string }> = [];
    const runtime = createRuntime({
      adapter,
      onEvent: (event) => events.push(event),
    });

    await expect(runtime.post(
      installation(),
      "telegram:chat-1:thread-1",
      "Scheduled result",
    )).rejects.toThrow("provider unavailable");
    expect(events).toContainEqual(expect.objectContaining({
      error: "provider unavailable",
      name: "delivery.failed",
    }));
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

  it("delegates streams to Chat SDK for every provider", async () => {
    const chunks: string[] = [];
    const stream = vi.fn(async (_threadId: string, values: AsyncIterable<string | { type: string }>) => {
      for await (const chunk of values) {
        if (typeof chunk === "string") chunks.push(chunk);
      }
      return { id: "streamed-1", raw: {}, threadId: "telegram:chat-1:thread-1" };
    });
    const adapter = testAdapter({ stream });
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

    expect(stream).toHaveBeenCalledOnce();
    expect(chunks.join("")).toBe(`${"a".repeat(3_000)}${"b".repeat(3_000)}`);
  });

  it("passes structured stream events through to Chat SDK unchanged", async () => {
    const chunks: unknown[] = [];
    const stream = vi.fn(async (_threadId: string, values: AsyncIterable<unknown>) => {
      for await (const chunk of values) chunks.push(chunk);
      return { id: "streamed-1", raw: {}, threadId: "telegram:chat-1:thread-1" };
    });
    const adapter = testAdapter({ stream });
    const structured = [
      { text: "Working", type: "markdown_text" as const },
      { label: "Build", status: "running", type: "task_update" as const },
    ];
    const runtime = createRuntime({
      adapter,
      handleTurn: async () => ({
        stream: (async function* () {
          yield structured[0];
          yield structured[1];
        })(),
      }),
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-structured"));

    expect(chunks).toEqual(structured);
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

  it("reports explicit event coordinator dispositions without executing", async () => {
    const events: string[] = [];
    const handleEvent = vi.fn(async () => ({ text: "must not run" }));
    const coordinateEvent = vi.fn(async () => "steered" as const);
    const runtime = createRuntime({
      coordinateEvent,
      handleEvent,
      onEvent: (event) => events.push(event.name),
    });

    await runtime.handleWebhook(installation(), webhookRequest("message-steered"));

    expect(coordinateEvent).toHaveBeenCalledOnce();
    expect(handleEvent).not.toHaveBeenCalled();
    expect(events).toContain("event.steered");
  });

  it("rejects an executed disposition when the coordinator skipped execution", async () => {
    const runtime = createRuntime({
      coordinateEvent: async () => "executed",
      handleEvent: async () => ({ text: "must not run" }),
    });

    await expect(runtime.handleWebhook(
      installation(),
      webhookRequest("message-not-executed"),
    )).rejects.toThrow(/returned "executed" without executing/i);
  });

  it("rejects a non-executed disposition after the coordinator executed", async () => {
    const runtime = createRuntime({
      coordinateEvent: async (_event, execute) => {
        await execute();
        return "queued";
      },
      handleEvent: async () => ({ text: "ran" }),
    });

    await expect(runtime.handleWebhook(
      installation(),
      webhookRequest("message-conflicting-disposition"),
    )).rejects.toThrow(/returned "queued" after executing/i);
  });

  it("prevents a coordinator from executing the same event twice", async () => {
    const runtime = createRuntime({
      coordinateEvent: async (_event, execute) => {
        await execute();
        await execute();
        return "executed";
      },
      handleEvent: async () => ({ text: "once" }),
    });

    await expect(runtime.handleWebhook(
      installation(),
      webhookRequest("message-double-execution"),
    )).rejects.toThrow(/more than once/i);
  });
});
