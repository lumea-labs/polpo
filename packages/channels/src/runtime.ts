import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import type {
  WhatsAppAdapter,
  WhatsAppTemplateMessage,
} from "@chat-adapter/whatsapp";
import {
  type Adapter,
  Chat,
  ConsoleLogger,
  type ActionEvent,
  type Logger,
  type Message,
  type MessageContext,
  type ModalCloseEvent,
  type ModalResponse,
  type ModalSubmitEvent,
  type OptionsLoadEvent,
  type OptionsLoadResult,
  type Postable,
  type ReactionEvent,
  type SlashCommandEvent,
  type Thread,
} from "chat";
import { createOfficialChannelAdapter } from "./providers.js";
import { segmentChannelText } from "./response.js";
import type {
  ChannelAuthor,
  ChannelDeliveryMessage,
  ChannelDeliveryResult,
  ChannelEventResult,
  ChannelInboundEvent,
  ChannelInboundMessage,
  ChannelInboundTurn,
  ChannelInstallation,
  ChannelProviderId,
  ChannelRuntimeEvent,
  ChannelRuntimeOptions,
  ChannelStateAdapter,
  ChannelTurnResult,
  ChannelWebhookOptions,
} from "./types.js";

type RuntimeEntry = {
  adapter: Adapter;
  chat: Chat<Record<string, never>>;
  installation: ChannelInstallation;
  key: string;
  lastUsedAt: number;
};

type TurnTarget = {
  channelId: string;
  postable: Postable<any, unknown>;
  threadId?: string;
};

const DEFAULT_CONCURRENCY = {
  debounceMs: 1_000,
  maxQueueSize: 20,
  onQueueFull: "drop-oldest" as const,
  queueEntryTtlMs: 120_000,
  strategy: "burst" as const,
};
const DEFAULT_DEDUPE_TTL_MS = 10 * 60_000;
const DEFAULT_OBSERVABILITY_TIMEOUT_MS = 1_000;
const OBSERVABILITY_TIMEOUT_BACKOFF_MS = 30_000;

class ChannelDeliveryFailure extends Error {
  constructor(
    error: unknown,
    readonly deliveredMessages: number,
  ) {
    super(errorMessage(error), { cause: error });
    this.name = "ChannelDeliveryFailure";
  }
}

export class ChannelRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingEvents = new Set<Promise<void>>();
  private readonly pendingInstallations = new Map<string, Promise<RuntimeEntry>>();
  private readonly pendingTurns = new Map<string, Promise<void>>();
  private observabilitySuppressedUntil = 0;
  private readonly options: Required<
    Pick<ChannelRuntimeOptions, "idleTtlMs" | "maxInstances">
  > & ChannelRuntimeOptions;

  constructor(options: ChannelRuntimeOptions) {
    if (!options.handleEvent && !options.handleTurn) {
      throw new Error("ChannelRuntime requires handleEvent or handleTurn");
    }
    this.options = {
      ...options,
      idleTtlMs: options.idleTtlMs ?? 15 * 60_000,
      maxInstances: options.maxInstances ?? 100,
    };
  }

  async handleWebhook(
    installation: ChannelInstallation,
    request: Request,
    options?: ChannelWebhookOptions,
  ): Promise<Response> {
    await this.emit({
      installationId: installation.id,
      name: "webhook.received",
      provider: installation.provider,
    });
    const entry = await this.getOrCreate(installation);
    entry.lastUsedAt = Date.now();
    const webhook = entry.chat.webhooks[installation.provider] as
      | ((request: Request, options?: ChannelWebhookOptions) => Promise<Response>)
      | undefined;
    if (!webhook) {
      throw new Error(`Missing Chat SDK webhook for ${installation.provider}`);
    }
    const webhookOptions = options?.waitUntil
      ? {
          ...options,
          waitUntil: (task: Promise<unknown>) => {
            options.waitUntil?.(
              Promise.resolve(task).finally(() => this.flushPendingEvents()),
            );
          },
        }
      : options;
    try {
      return await webhook(request, webhookOptions);
    } finally {
      await this.flushPendingEvents();
    }
  }

  async post(
    installation: ChannelInstallation,
    threadId: string,
    result: ChannelTurnResult | string,
  ): Promise<ChannelDeliveryResult> {
    const entry = await this.getOrCreate(installation);
    entry.lastUsedAt = Date.now();
    await entry.chat.initialize();
    const thread = entry.chat.thread(threadId);
    return this.deliver(
      installation,
      {
        channelId: thread.channelId,
        postable: thread,
        threadId: thread.id,
      },
      typeof result === "string" ? { text: result } : result,
    );
  }

  async postChannel(
    installation: ChannelInstallation,
    channelId: string,
    result: ChannelTurnResult | string,
  ): Promise<ChannelDeliveryResult> {
    const entry = await this.getOrCreate(installation);
    entry.lastUsedAt = Date.now();
    await entry.chat.initialize();
    const channel = entry.chat.channel(channelId);
    return this.deliver(
      installation,
      {
        channelId: channel.id,
        postable: channel,
      },
      typeof result === "string" ? { text: result } : result,
    );
  }

  async sendWhatsAppTemplate(
    installation: ChannelInstallation,
    recipient: string,
    template: WhatsAppTemplateMessage,
  ): Promise<ChannelDeliveryResult> {
    if (installation.provider !== "whatsapp") {
      throw new Error("WhatsApp templates require a WhatsApp installation");
    }
    const normalizedRecipient = requiredOutboundText(recipient, "recipient", 100);
    const normalizedTemplate = normalizeWhatsAppTemplate(template);
    const entry = await this.getOrCreate(installation);
    entry.lastUsedAt = Date.now();
    await entry.chat.initialize();
    const threadId = `whatsapp:${installation.credentials.phoneNumberId}:${normalizedRecipient}`;
    try {
      const sent = await (entry.adapter as WhatsAppAdapter).sendTemplate(
        threadId,
        normalizedTemplate,
      );
      await this.emit({
        channelId: `whatsapp:${installation.credentials.phoneNumberId}`,
        installationId: installation.id,
        messageId: sent.id,
        name: "delivery.completed",
        provider: installation.provider,
        threadId,
      });
      return {
        channelId: `whatsapp:${installation.credentials.phoneNumberId}`,
        messages: [{ id: sent.id, threadId: sent.threadId }],
        threadId,
      };
    } catch (error) {
      await this.emit({
        channelId: `whatsapp:${installation.credentials.phoneNumberId}`,
        error: errorMessage(error),
        installationId: installation.id,
        name: "delivery.failed",
        provider: installation.provider,
        threadId,
      });
      throw error;
    }
  }

  async invalidate(installationId: string): Promise<void> {
    const matching = [...this.entries.values()].filter(
      (entry) => entry.installation.id === installationId,
    );
    await Promise.all(matching.map((entry) => this.evict(entry)));
  }

  async shutdown(): Promise<void> {
    const entries = [...this.entries.values()];
    await Promise.all(entries.map((entry) => this.evict(entry)));
    await this.flushPendingEvents();
  }

  get size(): number {
    return this.entries.size;
  }

  private async getOrCreate(
    installation: ChannelInstallation,
  ): Promise<RuntimeEntry> {
    await this.prune();
    const key = runtimeKey(installation, this.options.concurrency);
    const cached = this.entries.get(key);
    if (cached) return cached;

    const pending = this.pendingInstallations.get(installation.id);
    if (pending) {
      await pending;
      return this.getOrCreate(installation);
    }

    const creating = this.createEntry(installation);
    this.pendingInstallations.set(installation.id, creating);
    try {
      return await creating;
    } finally {
      if (this.pendingInstallations.get(installation.id) === creating) {
        this.pendingInstallations.delete(installation.id);
      }
    }
  }

  private async createEntry(
    installation: ChannelInstallation,
  ): Promise<RuntimeEntry> {
    const key = runtimeKey(installation, this.options.concurrency);
    await this.invalidate(installation.id);
    const adapter = (this.options.adapterFactory ?? createOfficialChannelAdapter)(
      installation,
    );
    const state = await (this.options.stateFactory?.(installation)
      ?? Promise.resolve(new MemoryStateAdapter()));
    const chat = new Chat({
      adapters: { [installation.provider]: adapter },
      concurrency: installation.concurrency
        ?? this.options.concurrency
        ?? DEFAULT_CONCURRENCY,
      dedupeTtlMs: this.options.dedupeTtlMs,
      fallbackStreamingPlaceholderText:
        this.options.fallbackStreamingPlaceholderText ?? null,
      logger: createRuntimeLogger(
        installation,
        this.options.logger,
        (event) => this.emitDetached(event),
      ),
      onLockConflict: (threadId, message) => {
        this.emitDetached({
          details: { reason: "lock-busy" },
          installationId: installation.id,
          messageId: message.id,
          name: "transport.message.dropped",
          provider: installation.provider,
          threadId,
        });
        return "drop";
      },
      state,
      streamingUpdateIntervalMs: this.options.streamingUpdateIntervalMs,
      threadHistory: { maxMessages: 30, ttlMs: 24 * 60 * 60_000 },
      userName: installation.userName ?? "polpo",
    });

    const handler = (
      thread: Thread,
      message: Message,
      context?: MessageContext,
    ) => this.handleMessage(
      installation,
      adapter.name,
      state,
      thread,
      message,
      context,
    );
    chat.onDirectMessage((thread, message, _channel, context) =>
      this.handleMessage(
        installation,
        adapter.name,
        state,
        thread,
        message,
        context,
      ));
    chat.onNewMention(handler);
    chat.onNewMessage(/[\s\S]*/, handler);
    chat.onSubscribedMessage(handler);
    chat.onSlashCommand((event) =>
      this.handleSlashCommand(installation, state, event));
    if (this.options.handleEvent) {
      chat.onAction((event) => this.handleAction(installation, state, event));
      chat.onReaction((event) => this.handleReaction(installation, state, event));
      chat.onModalSubmit((event) => this.handleModalSubmit(installation, state, event));
      chat.onModalClose((event) => this.handleModalClose(installation, state, event));
      chat.onOptionsLoad((event) => this.handleOptionsLoad(installation, event));
    }

    const entry: RuntimeEntry = {
      adapter,
      chat: chat as Chat<Record<string, never>>,
      installation,
      key,
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    await this.emit({
      installationId: installation.id,
      name: "runtime.created",
      provider: installation.provider,
    });
    return entry;
  }

  private async handleMessage(
    installation: ChannelInstallation,
    adapterName: string,
    state: ChannelStateAdapter,
    thread: Thread,
    message: Message,
    context?: MessageContext,
  ): Promise<void> {
    const providerEventId = messageProviderEventId(
      installation.provider,
      thread.id,
      message,
    );
    const hasLogicalDedupe = providerEventId !== message.id;
    if (
      hasLogicalDedupe
      && !await this.acceptEvent(state, installation, "message", providerEventId)
    ) {
      return;
    }
    try {
      await thread.subscribe();
      const messages = await Promise.all(
        [...(context?.skipped ?? []), message].map(mapMessage),
      );
      const messageIds = messages.map((item) => item.id);
      const concurrency = installation.concurrency
        ?? this.options.concurrency
        ?? DEFAULT_CONCURRENCY;
      const turn: ChannelInboundTurn = {
        channelId: thread.channelId,
        coordination: {
          grouped: messages.length > 1,
          messageCount: messages.length,
          messageIds,
          primaryMessageId: message.id,
          strategy: concurrency.strategy,
        },
        credentialRevision: installation.credentialRevision,
        installationId: installation.id,
        isDirectMessage: thread.isDM,
        messages,
        provider: installation.provider,
        providerEventId,
        threadId: thread.id,
      };
      await this.executeTurn(installation, {
        channelId: thread.channelId,
        postable: thread,
        threadId: thread.id,
      }, turn);
    } catch (error) {
      if (!(error instanceof ChannelDeliveryFailure && error.deliveredMessages > 0)) {
        await Promise.all([
          state.delete(`dedupe:${adapterName}:${message.id}`),
          hasLogicalDedupe
            ? state.delete(
                `polpo:event:${installation.provider}:${installation.id}:message:${providerEventId}`,
              )
            : Promise.resolve(),
        ]).catch(() => undefined);
      }
      throw error;
    }
  }

  private async handleSlashCommand(
    installation: ChannelInstallation,
    state: ChannelStateAdapter,
    event: SlashCommandEvent,
  ): Promise<void> {
    const providerEventId = providerEventIdFor(event.raw, [
      event.command,
      event.text,
      event.channel.id,
      event.user.userId,
    ]);
    const accepted = await state.setIfNotExists(
      `polpo:slash-command:${installation.provider}:${installation.id}:${providerEventId}`,
      true,
      this.options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS,
    );
    if (!accepted) return;
    if (this.options.handleEvent) {
      const normalized: ChannelInboundEvent = {
        channelId: event.channel.id,
        command: event.command,
        credentialRevision: installation.credentialRevision,
        installationId: installation.id,
        openModal: event.openModal,
        provider: installation.provider,
        providerEventId,
        raw: event.raw,
        text: event.text,
        threadId: event.channel.id,
        type: "slash_command",
        user: mapAuthor(event.user),
      };
      await this.executeEvent(installation, {
        channelId: event.channel.id,
        postable: event.channel,
        threadId: event.channel.id,
      }, normalized);
      return;
    }
    const text = [event.command, event.text].filter(Boolean).join(" ").trim();
    const concurrency = installation.concurrency
      ?? this.options.concurrency
      ?? DEFAULT_CONCURRENCY;
    const turn: ChannelInboundTurn = {
      channelId: event.channel.id,
      coordination: {
        grouped: false,
        messageCount: 1,
        messageIds: [providerEventId],
        primaryMessageId: providerEventId,
        strategy: concurrency.strategy,
      },
      credentialRevision: installation.credentialRevision,
      installationId: installation.id,
      isDirectMessage: event.channel.isDM,
      messages: [{
        attachments: [],
        author: mapAuthor(event.user),
        edited: false,
        formatted: markdownAst(text),
        id: providerEventId,
        isMention: true,
        links: [],
        raw: event.raw,
        text,
        timestamp: providerTimestamp(event.raw),
      }],
      provider: installation.provider,
      providerEventId,
      threadId: event.channel.id,
    };
    await this.executeTurn(installation, {
      channelId: event.channel.id,
      postable: event.channel,
      threadId: event.channel.id,
    }, turn);
  }

  private async handleAction(
    installation: ChannelInstallation,
    state: ChannelStateAdapter,
    event: ActionEvent,
  ): Promise<void> {
    const providerEventId = providerEventIdFor(event.raw, [
      event.actionId,
      event.messageId,
      event.threadId,
      event.user.userId,
      event.value ?? "",
    ]);
    if (!await this.acceptEvent(state, installation, "action", providerEventId)) return;
    await this.executeEvent(
      installation,
      event.thread
        ? { channelId: event.thread.channelId, postable: event.thread, threadId: event.thread.id }
        : undefined,
      {
        actionId: event.actionId,
        channelId: event.thread?.channelId,
        credentialRevision: installation.credentialRevision,
        installationId: installation.id,
        messageId: event.messageId,
        openModal: event.openModal,
        provider: installation.provider,
        providerEventId,
        raw: event.raw,
        threadId: event.threadId,
        triggerId: event.triggerId,
        type: "action",
        user: mapAuthor(event.user),
        value: event.value,
      },
    );
  }

  private async handleReaction(
    installation: ChannelInstallation,
    state: ChannelStateAdapter,
    event: ReactionEvent,
  ): Promise<void> {
    const providerEventId = providerEventIdFor(event.raw, [
      event.messageId,
      event.threadId,
      event.user.userId,
      event.emoji.name,
      String(event.added),
    ]);
    if (!await this.acceptEvent(state, installation, "reaction", providerEventId)) return;
    await this.executeEvent(installation, {
      channelId: event.thread.channelId,
      postable: event.thread,
      threadId: event.thread.id,
    }, {
      added: event.added,
      channelId: event.thread.channelId,
      credentialRevision: installation.credentialRevision,
      emoji: event.emoji.name,
      installationId: installation.id,
      messageId: event.messageId,
      provider: installation.provider,
      providerEventId,
      raw: event.raw,
      rawEmoji: event.rawEmoji,
      threadId: event.threadId,
      type: "reaction",
      user: mapAuthor(event.user),
    });
  }

  private async handleModalSubmit(
    installation: ChannelInstallation,
    state: ChannelStateAdapter,
    event: ModalSubmitEvent,
  ): Promise<ModalResponse | undefined> {
    const providerEventId = providerEventIdFor(event.raw, [
      event.callbackId,
      event.viewId,
      event.user.userId,
      JSON.stringify(event.values),
    ]);
    if (!await this.acceptEvent(state, installation, "modal.submit", providerEventId)) {
      return undefined;
    }
    const result = await this.executeEvent(
      installation,
      eventTarget(event.relatedThread, event.relatedChannel),
      {
        callbackId: event.callbackId,
        channelId: event.relatedThread?.channelId ?? event.relatedChannel?.id,
        credentialRevision: installation.credentialRevision,
        installationId: installation.id,
        messageId: event.relatedMessage?.id,
        privateMetadata: event.privateMetadata,
        provider: installation.provider,
        providerEventId,
        raw: event.raw,
        threadId: event.relatedThread?.id,
        type: "modal.submit",
        user: mapAuthor(event.user),
        values: event.values,
        viewId: event.viewId,
      },
      false,
    );
    return result?.modalResponse;
  }

  private async handleModalClose(
    installation: ChannelInstallation,
    state: ChannelStateAdapter,
    event: ModalCloseEvent,
  ): Promise<void> {
    const providerEventId = providerEventIdFor(event.raw, [
      event.callbackId,
      event.viewId,
      event.user.userId,
    ]);
    if (!await this.acceptEvent(state, installation, "modal.close", providerEventId)) return;
    await this.executeEvent(
      installation,
      eventTarget(event.relatedThread, event.relatedChannel),
      {
        callbackId: event.callbackId,
        channelId: event.relatedThread?.channelId ?? event.relatedChannel?.id,
        credentialRevision: installation.credentialRevision,
        installationId: installation.id,
        messageId: event.relatedMessage?.id,
        privateMetadata: event.privateMetadata,
        provider: installation.provider,
        providerEventId,
        raw: event.raw,
        threadId: event.relatedThread?.id,
        type: "modal.close",
        user: mapAuthor(event.user),
        viewId: event.viewId,
      },
      false,
    );
  }

  private async handleOptionsLoad(
    installation: ChannelInstallation,
    event: OptionsLoadEvent,
  ): Promise<OptionsLoadResult | undefined> {
    const result = await this.options.handleEvent?.({
      actionId: event.actionId,
      credentialRevision: installation.credentialRevision,
      installationId: installation.id,
      provider: installation.provider,
      providerEventId: providerEventIdFor(event.raw, [
        event.actionId,
        event.user.userId,
        event.query,
      ]),
      query: event.query,
      raw: event.raw,
      type: "options.load",
      user: mapAuthor(event.user),
    });
    return result?.options;
  }

  private async acceptEvent(
    state: ChannelStateAdapter,
    installation: ChannelInstallation,
    type: string,
    providerEventId: string,
  ): Promise<boolean> {
    return state.setIfNotExists(
      `polpo:event:${installation.provider}:${installation.id}:${type}:${providerEventId}`,
      true,
      this.options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS,
    );
  }

  private async executeTurn(
    installation: ChannelInstallation,
    target: TurnTarget,
    turn: ChannelInboundTurn,
  ): Promise<void> {
    const messageId = turn.providerEventId;
    const event: ChannelInboundEvent = { ...turn, type: "message" };
    const execute = async () => {
      await this.emit({
        channelId: target.channelId,
        installationId: installation.id,
        messageId,
        name: "turn.started",
        provider: installation.provider,
        threadId: target.threadId,
      });

      try {
        if (
          installation.typingEnabled !== false
          && await (this.options.shouldStartTyping?.(turn) ?? true)
        ) {
          try {
            await target.postable.startTyping();
          } catch (error) {
            await this.emit({
              channelId: target.channelId,
              error: errorMessage(error),
              installationId: installation.id,
              messageId,
              name: "typing.failed",
              provider: installation.provider,
              threadId: target.threadId,
            });
          }
        }
        const result = this.options.handleEvent
          ? await this.options.handleEvent(event)
          : await this.options.handleTurn!(turn);
        if (result) await this.deliver(installation, target, result, messageId);
        await this.emit({
          channelId: target.channelId,
          installationId: installation.id,
          messageId,
          name: "turn.completed",
          provider: installation.provider,
          threadId: target.threadId,
        });
      } catch (error) {
        await this.emit({
          channelId: target.channelId,
          error: errorMessage(error),
          installationId: installation.id,
          messageId,
          name: "turn.failed",
          provider: installation.provider,
          threadId: target.threadId,
        });
        throw error;
      }
    };

    if (this.options.handleEvent && this.options.coordinateEvent) {
      const disposition = await coordinateWithDisposition(
        this.options.coordinateEvent,
        event,
        execute,
      );
      if (disposition && disposition !== "executed") {
        await this.emit({
          channelId: turn.channelId,
          installationId: installation.id,
          messageId,
          name: `event.${disposition}`,
          provider: installation.provider,
          threadId: turn.threadId,
        });
      }
      return;
    }
    if (this.options.coordinateTurn) {
      await this.options.coordinateTurn(turn, execute);
      return;
    }
    await this.coordinateLocally(turn, execute);
  }

  private async executeEvent(
    installation: ChannelInstallation,
    target: TurnTarget | undefined,
    event: ChannelInboundEvent,
    coordinate = true,
  ): Promise<ChannelEventResult | void> {
    if (!this.options.handleEvent) {
      await this.emit({
        channelId: event.channelId,
        installationId: installation.id,
        messageId: event.providerEventId,
        name: "event.unhandled",
        provider: installation.provider,
        threadId: event.threadId,
      });
      return;
    }

    let result: ChannelEventResult | void = undefined;
    const execute = async () => {
      await this.emit({
        channelId: event.channelId,
        installationId: installation.id,
        messageId: event.providerEventId,
        name: "turn.started",
        provider: installation.provider,
        threadId: event.threadId,
      });
      try {
        result = await this.options.handleEvent!(event);
        if (result && target && hasDeliverableOutput(result)) {
          await this.deliver(installation, target, result, event.providerEventId);
        }
        await this.emit({
          channelId: event.channelId,
          installationId: installation.id,
          messageId: event.providerEventId,
          name: "turn.completed",
          provider: installation.provider,
          threadId: event.threadId,
        });
      } catch (error) {
        await this.emit({
          channelId: event.channelId,
          error: errorMessage(error),
          installationId: installation.id,
          messageId: event.providerEventId,
          name: "turn.failed",
          provider: installation.provider,
          threadId: event.threadId,
        });
        throw error;
      }
    };

    if (coordinate && this.options.coordinateEvent) {
      const disposition = await coordinateWithDisposition(
        this.options.coordinateEvent,
        event,
        execute,
      );
      if (disposition && disposition !== "executed") {
        await this.emit({
          channelId: event.channelId,
          installationId: installation.id,
          messageId: event.providerEventId,
          name: `event.${disposition}`,
          provider: installation.provider,
          threadId: event.threadId,
        });
      }
    } else if (coordinate) {
      await this.coordinateEventLocally(event, execute);
    } else {
      await execute();
    }
    return result;
  }

  private async coordinateEventLocally(
    event: ChannelInboundEvent,
    execute: () => Promise<void>,
  ): Promise<void> {
    const key = `${event.provider}:${event.installationId}:${event.threadId ?? event.providerEventId}`;
    const previous = this.pendingTurns.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(execute);
    this.pendingTurns.set(key, current);
    try {
      await current;
    } finally {
      if (this.pendingTurns.get(key) === current) this.pendingTurns.delete(key);
    }
  }

  private async coordinateLocally(
    turn: ChannelInboundTurn,
    execute: () => Promise<void>,
  ): Promise<void> {
    const key = `${turn.provider}:${turn.installationId}:${turn.threadId}`;
    const previous = this.pendingTurns.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(execute);
    this.pendingTurns.set(key, current);
    try {
      await current;
    } finally {
      if (this.pendingTurns.get(key) === current) {
        this.pendingTurns.delete(key);
      }
    }
  }

  private async deliver(
    installation: ChannelInstallation,
    target: TurnTarget,
    result: ChannelTurnResult,
    sourceMessageId?: string,
  ): Promise<ChannelDeliveryResult> {
    const messages: ChannelDeliveryMessage[] = [];
    let deliveredPosts = 0;
    const post = async (message: unknown) => {
      const sent = await target.postable.post(message as any);
      deliveredPosts += 1;
      const normalized = deliveryMessage(sent);
      if (normalized) messages.push(normalized);
    };
    try {
      validateTurnResult(result);
      if (result.posts?.length) {
        for (const nativePost of result.posts) await post(nativePost);
      } else if (result.stream && !result.files?.length && !result.text) {
        await post(result.stream as any);
      } else {
        const streamedText = result.stream
          ? await collectText(result.stream)
          : "";
        const segments = segmentChannelText(
          installation.provider,
          [result.text, streamedText].filter(Boolean).join(""),
          installation.responseDelivery,
        );
        const files = result.files?.map((file) => ({
          data: file.data,
          filename: file.filename,
          mimeType: file.mimeType,
        }));
        const attachments = result.files
          ?.filter((file) => file.type)
          .map((file) => ({
            data: file.data instanceof ArrayBuffer
              ? new Blob([file.data])
              : file.data,
            mimeType: file.mimeType,
            name: file.filename,
            type: file.type!,
          }));
        const genericFiles = files?.filter(
          (_file, index) => !result.files?.[index]?.type,
        );
        const textSegments = segments.length > 0 ? segments : [""];
        const [firstText = "", ...remainingText] = textSegments;

        if (files?.length) {
          if (installation.provider === "slack") {
            if (firstText) await post({ markdown: firstText });
            for (const file of files) {
              await post({ files: [file], markdown: "" });
            }
          } else if (installation.provider === "discord") {
            await post({ files, markdown: firstText });
          } else if (installation.provider === "telegram") {
            if (attachments?.length) {
              await post({ attachments, markdown: firstText });
            }
            if (genericFiles?.length) {
              await post({
                files: genericFiles,
                markdown: attachments?.length ? "" : firstText,
              });
            }
          } else {
            if (firstText) await post({ markdown: firstText });
            for (const [index, outputFile] of (result.files ?? []).entries()) {
              const file = files[index]!;
              if (outputFile.type) {
                await post({
                  attachments: [{
                    data: outputFile.data instanceof ArrayBuffer
                      ? new Blob([outputFile.data])
                      : outputFile.data,
                    mimeType: outputFile.mimeType,
                    name: outputFile.filename,
                    type: outputFile.type,
                  }],
                  markdown: "",
                });
              } else {
                await post({ files: [file], markdown: "" });
              }
            }
          }
        } else if (segments.length > 0) {
          await post({ markdown: firstText });
        }

        for (const text of remainingText) {
          await post({ markdown: text });
        }
      }
      await this.emit({
        channelId: target.channelId,
        installationId: installation.id,
        messageId: sourceMessageId,
        name: "delivery.completed",
        provider: installation.provider,
        threadId: target.threadId,
      });
      return {
        channelId: target.channelId,
        messages,
        ...(target.threadId ? { threadId: target.threadId } : {}),
      };
    } catch (error) {
      await this.emit({
        channelId: target.channelId,
        details: { deliveredMessages: deliveredPosts },
        error: errorMessage(error),
        installationId: installation.id,
        messageId: sourceMessageId,
        name: "delivery.failed",
        provider: installation.provider,
        threadId: target.threadId,
      });
      throw new ChannelDeliveryFailure(error, deliveredPosts);
    }
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    const expired = [...this.entries.values()].filter(
      (entry) => now - entry.lastUsedAt >= this.options.idleTtlMs,
    );
    await Promise.all(expired.map((entry) => this.evict(entry)));

    const overflow = this.entries.size - this.options.maxInstances + 1;
    if (overflow > 0) {
      const oldest = [...this.entries.values()]
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        .slice(0, overflow);
      await Promise.all(oldest.map((entry) => this.evict(entry)));
    }
  }

  private async evict(entry: RuntimeEntry): Promise<void> {
    if (!this.entries.delete(entry.key)) return;
    await entry.chat.shutdown();
    await this.emit({
      installationId: entry.installation.id,
      name: "runtime.evicted",
      provider: entry.installation.provider,
    });
  }

  private async emit(event: ChannelRuntimeEvent): Promise<void> {
    const onEvent = this.options.onEvent;
    if (!onEvent || Date.now() < this.observabilitySuppressedUntil) return;
    const timeoutMs = this.options.observabilityTimeoutMs
      ?? DEFAULT_OBSERVABILITY_TIMEOUT_MS;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const hook = Promise.resolve()
      .then(() => onEvent(event))
      .then(() => "settled" as const)
      .catch(() => "settled" as const);
    try {
      const outcome = timeoutMs > 0
        ? await Promise.race([
            hook,
            new Promise<"timeout">((resolve) => {
              timeout = setTimeout(() => resolve("timeout"), timeoutMs);
            }),
          ])
        : await hook;
      if (outcome === "timeout") {
        this.observabilitySuppressedUntil = Date.now()
          + OBSERVABILITY_TIMEOUT_BACKOFF_MS;
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private emitDetached(event: ChannelRuntimeEvent): void {
    let task: Promise<void>;
    task = this.emit(event).finally(() => this.pendingEvents.delete(task));
    this.pendingEvents.add(task);
  }

  private async flushPendingEvents(): Promise<void> {
    while (this.pendingEvents.size > 0) {
      await Promise.all([...this.pendingEvents]);
    }
  }
}

function requiredOutboundText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\u0000")) {
    throw new Error(`${name} must contain between 1 and ${max} characters`);
  }
  return normalized;
}

function normalizeWhatsAppTemplate(
  value: WhatsAppTemplateMessage,
): WhatsAppTemplateMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WhatsApp template must be an object");
  }
  const name = requiredOutboundText(value.name, "template.name", 512);
  const language = requiredOutboundText(value.language, "template.language", 35);
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("template.name must use lowercase letters, numbers, and underscores");
  }
  if (!/^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/.test(language)) {
    throw new Error("template.language must be a valid WhatsApp language code");
  }
  if (value.components !== undefined && !Array.isArray(value.components)) {
    throw new Error("template.components must be an array");
  }
  return {
    name,
    language,
    ...(value.components === undefined
      ? {}
      : { components: structuredClone(value.components) }),
  };
}

const TRANSPORT_LOG_EVENTS = {
  "message-queued": "transport.message.queued",
  "message-dequeued": "transport.message.dequeued",
  "message-dropped": "transport.message.dropped",
  "message-expired": "transport.message.expired",
  "message-superseded": "transport.message.superseded",
  "message-debouncing": "transport.message.debouncing",
  "message-debounce-reset": "transport.message.debounce_reset",
} as const satisfies Record<string, ChannelRuntimeEvent["name"]>;

const TRANSPORT_DETAIL_KEYS = [
  "debounceMs",
  "droppedId",
  "queueDepth",
  "reason",
  "skippedCount",
  "totalSinceLastHandler",
] as const;

function createRuntimeLogger(
  installation: ChannelInstallation,
  configured: ChannelRuntimeOptions["logger"],
  emit: (event: ChannelRuntimeEvent) => void,
): Logger {
  const base = typeof configured === "string"
    ? new ConsoleLogger(configured)
    : configured ?? new ConsoleLogger("warn");
  return new RuntimeLogger(base, (message, args) => {
    const name = TRANSPORT_LOG_EVENTS[message as keyof typeof TRANSPORT_LOG_EVENTS];
    if (!name) return;
    const data = recordValue(args[0]);
    const threadId = stringValue(data.threadId);
    const messageId = stringValue(data.messageId) ?? stringValue(data.droppedId);
    const details: Record<string, string | number | boolean | null> = {};
    for (const key of TRANSPORT_DETAIL_KEYS) {
      const value = data[key];
      if (
        typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean"
        || value === null
      ) {
        details[key] = value;
      }
    }
    emit({
      ...(Object.keys(details).length > 0 ? { details } : {}),
      installationId: installation.id,
      ...(messageId ? { messageId } : {}),
      name,
      provider: installation.provider,
      ...(threadId ? { threadId } : {}),
    });
  });
}

class RuntimeLogger implements Logger {
  constructor(
    private readonly base: Logger,
    private readonly observeInfo: (message: string, args: unknown[]) => void,
  ) {}

  child(prefix: string): Logger {
    return new RuntimeLogger(this.base.child(prefix), this.observeInfo);
  }

  debug(message: string, ...args: unknown[]): void {
    this.base.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.observeInfo(message, args);
    this.base.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.base.warn(message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.base.error(message, ...args);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runtimeKey(
  installation: ChannelInstallation,
  defaultConcurrency?: ChannelRuntimeOptions["concurrency"],
): string {
  const typing = installation.typingEnabled === false ? "silent" : "typing";
  const concurrency = JSON.stringify(
    installation.concurrency ?? defaultConcurrency ?? DEFAULT_CONCURRENCY,
  );
  const responseDelivery = JSON.stringify(installation.responseDelivery ?? null);
  return `${installation.provider}:${installation.id}:${installation.credentialRevision}:${typing}:${concurrency}:${responseDelivery}`;
}

async function coordinateWithDisposition(
  coordinator: NonNullable<ChannelRuntimeOptions["coordinateEvent"]>,
  event: ChannelInboundEvent,
  execute: () => Promise<void>,
): Promise<"executed" | "queued" | "steered" | "rejected" | void> {
  let executions = 0;
  const executeOnce = async () => {
    executions += 1;
    if (executions > 1) {
      throw new Error("Channel event coordinator attempted to execute an event more than once");
    }
    await execute();
  };
  const disposition = await coordinator(event, executeOnce);
  if (disposition === "executed" && executions !== 1) {
    throw new Error('Channel event coordinator returned "executed" without executing the event');
  }
  if (
    disposition
    && disposition !== "executed"
    && executions !== 0
  ) {
    throw new Error(
      `Channel event coordinator returned "${disposition}" after executing the event`,
    );
  }
  if (!disposition && executions === 0) {
    throw new Error("Channel event coordinator returned no disposition and did not execute the event");
  }
  return disposition;
}

async function mapMessage(message: Message): Promise<ChannelInboundMessage> {
  const subject = await message.subject.catch(() => null);
  return {
    attachments: message.attachments.map((attachment) => ({
      data: attachment.data,
      fetchData: attachment.fetchData,
      fetchMetadata: attachment.fetchMetadata,
      height: attachment.height,
      mimeType: attachment.mimeType,
      name: attachment.name,
      size: attachment.size,
      type: attachment.type,
      url: attachment.url,
      width: attachment.width,
    })),
    author: mapAuthor(message.author),
    edited: message.metadata.edited,
    editedAt: message.metadata.editedAt,
    formatted: message.formatted,
    id: message.id,
    isMention: message.isMention ?? false,
    links: message.links,
    raw: message.raw,
    subject: subject ?? undefined,
    text: message.text,
    timestamp: message.metadata.dateSent,
  };
}

function messageProviderEventId(
  provider: ChannelProviderId,
  threadId: string,
  message: Message,
): string {
  if (provider !== "telegram") return message.id;
  const mediaGroupId = asRecord(message.raw)?.media_group_id;
  if (
    (typeof mediaGroupId === "string" && mediaGroupId.trim())
    || (typeof mediaGroupId === "number" && Number.isFinite(mediaGroupId))
  ) {
    return `${threadId}:media-group:${String(mediaGroupId)}`;
  }
  return message.id;
}

function providerEventIdFor(raw: unknown, fallback: string[]): string {
  const record = asRecord(raw);
  for (const key of ["id", "event_id", "trigger_id"] as const) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return `derived-${stableHash(`${stableSerialize(raw)}|${fallback.join("|")}`)}`;
}

function providerTimestamp(raw: unknown): Date {
  const record = asRecord(raw);
  for (const key of ["timestamp", "event_ts", "event_time"] as const) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.getTime())) return date;
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      const date = Number.isFinite(numeric)
        ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
        : new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return new Date();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function deliveryMessage(value: unknown): ChannelDeliveryMessage | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.threadId !== "string") {
    return null;
  }
  return { id: record.id, threadId: record.threadId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectText(
  stream: NonNullable<ChannelTurnResult["stream"]>,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      text += chunk;
    } else if (chunk.type === "text-delta" && "textDelta" in chunk) {
      text += chunk.textDelta;
    } else if (chunk.type === "markdown_text" && "text" in chunk) {
      text += chunk.text;
    } else if (chunk.type === "finish-step") {
      text += "\n\n";
    }
  }
  return text;
}

function mapAuthor(author: {
  email?: string;
  fullName: string;
  isBot: boolean | "unknown";
  userId: string;
  userName: string;
}): ChannelAuthor {
  return {
    email: author.email,
    fullName: author.fullName,
    isBot: author.isBot,
    userId: author.userId,
    userName: author.userName,
  };
}

function markdownAst(text: string): NonNullable<ChannelInboundMessage["formatted"]> {
  return {
    type: "root",
    children: [{
      type: "paragraph",
      children: [{ type: "text", value: text }],
    }],
  };
}

function eventTarget(
  thread: Thread | undefined,
  channel: Postable<any, unknown> | undefined,
): TurnTarget | undefined {
  const postable = thread ?? channel;
  if (!postable) return undefined;
  return {
    channelId: thread?.channelId ?? postable.id,
    postable,
    threadId: thread?.id ?? postable.id,
  };
}

function hasDeliverableOutput(result: ChannelEventResult): boolean {
  return Boolean(result.posts?.length || result.stream || result.files?.length || result.text);
}

function validateTurnResult(result: ChannelTurnResult): void {
  if (result.posts?.length && (result.text || result.stream || result.files?.length)) {
    throw new Error("Native posts cannot be combined with text, stream, or files");
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
