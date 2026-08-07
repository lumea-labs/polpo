import { MemoryStateAdapter } from "@chat-adapter/state-memory";
import {
  Chat,
  type Message,
  type MessageContext,
  type Thread,
} from "chat";
import { createOfficialChannelAdapter } from "./providers.js";
import { segmentChannelText } from "./response.js";
import type {
  ChannelInboundMessage,
  ChannelInboundTurn,
  ChannelInstallation,
  ChannelRuntimeEvent,
  ChannelRuntimeOptions,
  ChannelTurnResult,
  ChannelWebhookOptions,
} from "./types.js";

type RuntimeEntry = {
  chat: Chat<Record<string, never>>;
  installation: ChannelInstallation;
  key: string;
  lastUsedAt: number;
};

const DEFAULT_CONCURRENCY = {
  debounceMs: 1_000,
  maxQueueSize: 20,
  onQueueFull: "drop-oldest" as const,
  queueEntryTtlMs: 120_000,
  strategy: "burst" as const,
};

export class ChannelRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly pendingInstallations = new Map<string, Promise<RuntimeEntry>>();
  private readonly pendingTurns = new Map<string, Promise<void>>();
  private readonly options: Required<
    Pick<ChannelRuntimeOptions, "idleTtlMs" | "maxInstances">
  > & ChannelRuntimeOptions;

  constructor(options: ChannelRuntimeOptions) {
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
    return webhook(request, options);
  }

  async post(
    installation: ChannelInstallation,
    threadId: string,
    result: ChannelTurnResult | string,
  ): Promise<void> {
    const entry = await this.getOrCreate(installation);
    entry.lastUsedAt = Date.now();
    await this.deliver(installation, entry.chat.thread(threadId),
      typeof result === "string" ? { text: result } : result);
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
  }

  get size(): number {
    return this.entries.size;
  }

  private async getOrCreate(
    installation: ChannelInstallation,
  ): Promise<RuntimeEntry> {
    await this.prune();
    const key = runtimeKey(installation);
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
    const key = runtimeKey(installation);
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
      state,
      streamingUpdateIntervalMs: this.options.streamingUpdateIntervalMs,
      threadHistory: { maxMessages: 30, ttlMs: 24 * 60 * 60_000 },
      userName: installation.userName ?? "polpo",
    });

    const handler = (
      thread: Thread,
      message: Message,
      context?: MessageContext,
    ) => this.handleMessage(installation, thread, message, context);
    chat.onDirectMessage((thread, message, _channel, context) =>
      this.handleMessage(installation, thread, message, context));
    chat.onNewMention(handler);
    chat.onNewMessage(/[\s\S]*/, handler);
    chat.onSubscribedMessage(handler);

    const entry: RuntimeEntry = {
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
    thread: Thread,
    message: Message,
    context?: MessageContext,
  ): Promise<void> {
    await thread.subscribe();
    const messages = [...(context?.skipped ?? []), message].map(mapMessage);
    const turn: ChannelInboundTurn = {
      channelId: thread.channelId,
      credentialRevision: installation.credentialRevision,
      installationId: installation.id,
      isDirectMessage: thread.isDM,
      messages,
      provider: installation.provider,
      providerEventId: message.id,
      threadId: thread.id,
    };
    const execute = async () => {
      await this.emit({
        channelId: thread.channelId,
        installationId: installation.id,
        messageId: message.id,
        name: "turn.started",
        provider: installation.provider,
        threadId: thread.id,
      });

      try {
        if (
          installation.typingEnabled !== false
          && await (this.options.shouldStartTyping?.(turn) ?? true)
        ) {
          try {
            await thread.startTyping();
          } catch (error) {
            await this.emit({
              channelId: thread.channelId,
              error: errorMessage(error),
              installationId: installation.id,
              messageId: message.id,
              name: "typing.failed",
              provider: installation.provider,
              threadId: thread.id,
            });
          }
        }
        const result = await this.options.handleTurn(turn);
        if (result) await this.deliver(installation, thread, result, message.id);
        await this.emit({
          channelId: thread.channelId,
          installationId: installation.id,
          messageId: message.id,
          name: "turn.completed",
          provider: installation.provider,
          threadId: thread.id,
        });
      } catch (error) {
        await this.emit({
          channelId: thread.channelId,
          error: errorMessage(error),
          installationId: installation.id,
          messageId: message.id,
          name: "turn.failed",
          provider: installation.provider,
          threadId: thread.id,
        });
        throw error;
      }
    };

    if (this.options.coordinateTurn) {
      await this.options.coordinateTurn(turn, execute);
      return;
    }
    await this.coordinateLocally(turn, execute);
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
    thread: Thread,
    result: ChannelTurnResult,
    sourceMessageId?: string,
  ): Promise<void> {
    try {
      if (
        result.stream
        && installation.provider === "slack"
        && !result.files?.length
      ) {
        await thread.post(result.stream);
      } else {
        const streamedText = result.stream
          ? await collectText(result.stream)
          : "";
        const segments = segmentChannelText(
          installation.provider,
          [result.text, streamedText].filter(Boolean).join(""),
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
        const genericFiles = result.files?.some((file) => file.type)
          ? files?.filter((_file, index) => !result.files?.[index]?.type)
          : files;
        if (segments.length === 0 && files?.length) {
          await thread.post({ attachments, files: genericFiles, markdown: "" });
        } else {
          for (const [index, text] of segments.entries()) {
            if (index === 0 && files?.length) {
              await thread.post({
                attachments,
                files: genericFiles,
                markdown: text,
              });
            } else {
              await thread.post(text);
            }
          }
        }
      }
      await this.emit({
        channelId: thread.channelId,
        installationId: installation.id,
        messageId: sourceMessageId,
        name: "delivery.completed",
        provider: installation.provider,
        threadId: thread.id,
      });
    } catch (error) {
      await this.emit({
        channelId: thread.channelId,
        error: errorMessage(error),
        installationId: installation.id,
        messageId: sourceMessageId,
        name: "delivery.failed",
        provider: installation.provider,
        threadId: thread.id,
      });
      throw error;
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
    await this.options.onEvent?.(event);
  }
}

function runtimeKey(installation: ChannelInstallation): string {
  const typing = installation.typingEnabled === false ? "silent" : "typing";
  return `${installation.provider}:${installation.id}:${installation.credentialRevision}:${typing}`;
}

function mapMessage(message: Message): ChannelInboundMessage {
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
    author: {
      email: message.author.email,
      fullName: message.author.fullName,
      isBot: message.author.isBot,
      userId: message.author.userId,
      userName: message.author.userName,
    },
    id: message.id,
    isMention: message.isMention ?? false,
    raw: message.raw,
    text: message.text,
    timestamp: message.metadata.dateSent,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectText(stream: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}
