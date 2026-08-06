import type {
  ChannelInboundTurn,
  ChannelTurnResult,
} from "@polpo-ai/channels";
import type {
  Message,
  MessageRole,
  Session,
  SessionContentPart,
  SessionCreateOptions,
  SessionListFilter,
  SessionStore,
} from "@polpo-ai/core/session-store";
import { describe, expect, it, vi } from "vitest";
import type { CompletionRouteDeps } from "../routes/completions.js";
import {
  ChannelConversationError,
  createConversationChannelTurnHandler,
  type ChannelConversationTurnExecutor,
} from "./conversation-bridge.js";

class TestSessionStore implements SessionStore {
  readonly sessions: Session[] = [];
  readonly messages = new Map<string, Message[]>();

  async create(options: SessionCreateOptions = {}): Promise<string> {
    const id = `session-${this.sessions.length + 1}`;
    this.sessions.unshift({
      agent: options.agent,
      createdAt: "2026-08-07T12:00:00.000Z",
      id,
      messageCount: 0,
      metadata: options.metadata,
      title: options.title,
      updatedAt: "2026-08-07T12:00:00.000Z",
      user: options.user,
    });
    this.messages.set(id, []);
    return id;
  }

  async addMessage(
    sessionId: string,
    role: MessageRole,
    content: string | SessionContentPart[],
  ): Promise<Message> {
    const message = {
      content,
      id: `message-${this.messages.get(sessionId)?.length ?? 0}`,
      role,
      ts: new Date().toISOString(),
    };
    this.messages.get(sessionId)?.push(message);
    return message;
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    return (this.messages.get(sessionId) ?? []).slice(-limit);
  }

  async listSessions(filter?: SessionListFilter): Promise<Session[]> {
    return this.sessions.filter((session) => {
      if (filter?.user && session.user !== filter.user) return false;
      return Object.entries(filter?.metadata ?? {}).every(
        ([key, value]) => session.metadata?.[key] === value,
      );
    });
  }

  async getMessages(sessionId: string) { return this.messages.get(sessionId) ?? []; }
  async getSession(sessionId: string) { return this.sessions.find((item) => item.id === sessionId); }
  async getLatestSession() { return this.sessions[0]; }
  async renameSession() { return true; }
  async deleteSession() { return true; }
  async prune() { return 0; }
  async updateMessage() { return true; }
  close() {}
}

function turn(overrides: Partial<ChannelInboundTurn> = {}): ChannelInboundTurn {
  return {
    channelId: "telegram:chat-1",
    installationId: "installation-1",
    isDirectMessage: true,
    messages: [{
      attachments: [],
      author: {
        fullName: "Ada Lovelace",
        isBot: false,
        userId: "user-1",
        userName: "ada",
      },
      id: "message-1",
      isMention: false,
      raw: {},
      text: "hello",
      timestamp: new Date("2026-08-07T12:00:00.000Z"),
    }],
    provider: "telegram",
    providerEventId: "event-1",
    threadId: "telegram:chat-1:thread-1",
    ...overrides,
  };
}

function deps(store: SessionStore): CompletionRouteDeps {
  return { getSessionStore: () => store } as CompletionRouteDeps;
}

function successfulResult(sessionId: string | null, text = "reply") {
  return {
    completionId: "completion-1",
    runResult: { exitCode: 0, stderr: "", stdout: text },
    runStatus: "completed",
    sessionId,
    text,
    toolCalls: [],
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  };
}

describe("createConversationChannelTurnHandler", () => {
  it("creates one stable Session and reloads history on the next turn", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>(async (input) => {
      const current = input.body.messages.at(-1)!;
      await store.addMessage(input.sessionId!, "user", current.content!);
      await store.addMessage(input.sessionId!, "assistant", "reply");
      return successfulResult(input.sessionId ?? null);
    });
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
    });

    await handler(turn());
    await handler(turn({
      messages: [{ ...turn().messages[0]!, id: "message-2", text: "follow up" }],
      providerEventId: "event-2",
    }));

    expect(store.sessions).toHaveLength(1);
    expect(executeTurn).toHaveBeenCalledTimes(2);
    expect(executeTurn.mock.calls[1]?.[0].sessionId).toBe("session-1");
    expect(executeTurn.mock.calls[1]?.[0].body.messages).toEqual([
      expect.objectContaining({ role: "user" }),
      { content: "reply", role: "assistant" },
      { content: "follow up", role: "user" },
    ]);
  });

  it("does not share sessions across external users", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>(async (input) =>
      successfulResult(input.sessionId ?? null));
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
    });

    await handler(turn());
    await handler(turn({
      messages: [{
        ...turn().messages[0]!,
        author: { ...turn().messages[0]!.author, userId: "user-2" },
        id: "message-2",
      }],
    }));

    expect(store.sessions).toHaveLength(2);
    expect(store.sessions.map((session) => session.user).sort()).toEqual([
      "telegram:installation-1:user-1",
      "telegram:installation-1:user-2",
    ]);
  });

  it("preserves burst order and inlines authenticated image data", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>(async (input) =>
      successfulResult(input.sessionId ?? null));
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
    });
    const first = turn().messages[0]!;

    await handler(turn({
      messages: [
        { ...first, id: "message-1", text: "first" },
        {
          ...first,
          attachments: [{
            fetchData: async () => Buffer.from([1, 2, 3]),
            mimeType: "image/png",
            name: "photo.png",
            type: "image",
          }],
          id: "message-2",
          text: "second",
        },
      ],
    }));

    expect(executeTurn.mock.calls[0]?.[0].body.messages.at(-1)?.content)
      .toEqual([
        { type: "text", text: "[Message 1 from Ada Lovelace]\nfirst" },
        { type: "text", text: "[Message 2 from Ada Lovelace]\nsecond" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AQID" },
        },
      ]);
  });

  it("fails before model execution when an inline image is too large", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>();
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
      maxInlineAttachmentBytes: 2,
    });
    const message = turn().messages[0]!;

    await expect(handler(turn({
      messages: [{
        ...message,
        attachments: [{
          data: Buffer.from([1, 2, 3]),
          mimeType: "image/png",
          name: "large.png",
          type: "image",
        }],
      }],
    }))).rejects.toMatchObject({ code: "channel_attachment_too_large" });
    expect(executeTurn).not.toHaveBeenCalled();
  });

  it("turns model failures into typed Channel errors", async () => {
    const store = new TestSessionStore();
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn: async (input) => ({
        ...successfulResult(input.sessionId ?? null, ""),
        error: {
          code: "guardrail_blocked",
          message: "blocked",
          type: "guardrail_error",
        },
      }),
    });

    const error = await handler(turn()).catch((caught) => caught);
    expect(error).toBeInstanceOf(ChannelConversationError);
    expect(error).toMatchObject({ code: "guardrail_blocked", message: "blocked" });
  });
});
