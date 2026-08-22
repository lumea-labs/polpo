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
  type ChannelClientToolExecution,
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
    coordination: {
      grouped: false,
      messageCount: 1,
      messageIds: ["message-1"],
      primaryMessageId: "message-1",
      strategy: "queue",
    },
    credentialRevision: "revision-1",
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

  it("treats an unresolved lazy Route policy as unrestricted", async () => {
    const store = new TestSessionStore();
    const allowedTools = vi.fn(async () => undefined);
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>(async (input) =>
      successfulResult(input.sessionId ?? null));
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      allowedTools,
      executeTurn,
    });

    await expect(handler(turn())).resolves.toMatchObject({
      metadata: { sessionId: "session-1" },
    });
    expect(allowedTools).toHaveBeenCalledOnce();
    expect(executeTurn.mock.calls[0]?.[0].runtime?.toolPolicy).not.toHaveProperty(
      "routeAllowedTools",
    );
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

  it("executes an allowlisted client tool and continues the same Session into a Project Loop", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>()
      .mockResolvedValueOnce({
        ...successfulResult("session-1", ""),
        clientToolCall: {
          id: "call-1",
          name: "apply_site_change",
          arguments: { instruction: "Add booking" },
        },
        sessionVersion: 2,
      })
      .mockResolvedValueOnce({
        ...successfulResult("session-1", "Site updated"),
        sessionVersion: 4,
      });
    const executeClientTool = vi.fn(async () => ({
      result: { accepted: true },
      loop: "leo-change-site",
      allowedTools: ["site_*"],
      trustedMetadata: {
        grant: "rotated-signed-grant",
        workingCopyId: "copy-1",
      },
    }));
    const allowedTools = vi.fn(async () => ["apply_site_change"]);
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "leo",
      allowedTools,
      executeTurn,
      executeClientTool,
      clientTools: [{
        type: "function",
        function: {
          name: "apply_site_change",
          description: "Apply a requested site change",
          parameters: {
            type: "object",
            properties: { instruction: { type: "string" } },
            required: ["instruction"],
            additionalProperties: false,
          },
          strict: true,
        },
      }],
      resolveInvocation: async () => ({
        disposition: "dispatch",
        user: "user-1",
        metadata: { tenantId: "tenant-1", grant: "signed" },
        scope: { key: "site-1", version: "3" },
        allowedTools: ["apply_site_change", "site_*"],
      }),
    });

    await expect(handler(turn())).resolves.toMatchObject({
      text: "Site updated",
      metadata: { sessionId: "session-1" },
    });
    expect(allowedTools).toHaveBeenCalledOnce();
    expect(executeClientTool).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^channel-client-tool:[a-f0-9]{64}$/),
      sessionId: "session-1",
      sessionVersion: 2,
      toolCall: {
        id: "call-1",
        name: "apply_site_change",
        arguments: { instruction: "Add booking" },
      },
      invocation: expect.objectContaining({
        user: "user-1",
        metadata: { tenantId: "tenant-1", grant: "signed" },
        scope: { key: "site-1", version: "3" },
      }),
    }));
    const continuation = executeTurn.mock.calls[1]?.[0];
    expect(executeTurn.mock.calls[0]?.[0].body).toMatchObject({
      tools: [{
        type: "function",
        function: { name: "apply_site_change", strict: true },
      }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(executeTurn.mock.calls[0]?.[0].runtime?.toolPolicy).toEqual({
      routeAllowedTools: ["apply_site_change"],
      grantAllowedTools: ["apply_site_change", "site_*"],
    });
    expect(continuation?.sessionId).toBe("session-1");
    expect(continuation?.body).toMatchObject({
      agent: "leo",
      loop: "leo-change-site",
      stream: true,
      messages: [{
        role: "tool",
        tool_call_id: "call-1",
        content: '{"accepted":true}',
      }],
      polpo: {
        continuation: {
          type: "client_tool",
          tool_call_id: "call-1",
          expected_session_version: 2,
        },
        delivery: { onDisconnect: "continue" },
      },
    });
    expect(continuation?.body).not.toHaveProperty("tools");
    expect(JSON.stringify(continuation?.body)).not.toContain("rotated-signed-grant");
    expect(JSON.stringify(continuation?.body)).not.toContain("copy-1");
    expect(continuation?.continuation).toEqual({
      idempotencyKey: expect.stringMatching(/^channel-client-tool:[a-f0-9]{64}$/),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(continuation?.runtime).toMatchObject({
      source: "channel",
      surface: "channel",
      user: "user-1",
      metadata: {
        tenantId: "tenant-1",
        grant: "rotated-signed-grant",
        workingCopyId: "copy-1",
      },
      scope: { key: "site-1", version: "3" },
      toolPolicy: {
        executionAllowedTools: ["site_*"],
        grantAllowedTools: ["apply_site_change", "site_*"],
      },
    });
    expect(continuation?.runtime?.toolPolicy).not.toHaveProperty("routeAllowedTools");
    expect(Object.isFrozen(continuation?.runtime?.metadata)).toBe(true);
  });

  it("carries trusted handler metadata across direct continuations without exposing it", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>()
      .mockResolvedValueOnce({
        ...successfulResult("session-1", ""),
        clientToolCall: { id: "call-1", name: "first", arguments: {} },
        sessionVersion: 2,
      })
      .mockResolvedValueOnce({
        ...successfulResult("session-1", ""),
        clientToolCall: { id: "call-2", name: "second", arguments: {} },
        sessionVersion: 4,
      })
      .mockResolvedValueOnce({
        ...successfulResult("session-1", "done"),
        sessionVersion: 6,
      });
    const executeClientTool = vi.fn(async ({ toolCall, invocation }): Promise<ChannelClientToolExecution> => {
      if (toolCall.name === "first") {
        return {
          result: { ok: true },
          trustedMetadata: { grant: "grant-2", workingCopyId: "copy-1" },
        };
      }
      return {
        result: { ok: true },
        trustedMetadata: {
          revisionId: "revision-1",
          previousGrant: invocation?.metadata.grant ?? null,
        },
      };
    });
    const clientTools = ["first", "second"].map((name) => ({
      type: "function" as const,
      function: {
        name,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }));
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      clientTools,
      executeTurn,
      executeClientTool,
      resolveInvocation: () => ({
        disposition: "dispatch",
        user: "user-1",
        metadata: { grant: "grant-1", tenantId: "tenant-1" },
      }),
    });

    await expect(handler(turn())).resolves.toMatchObject({ text: "done" });
    expect(executeClientTool.mock.calls[1]?.[0].invocation?.metadata).toEqual({
      grant: "grant-2",
      tenantId: "tenant-1",
      workingCopyId: "copy-1",
    });
    expect(executeTurn.mock.calls[1]?.[0].body).toMatchObject({ tools: clientTools });
    expect(executeTurn.mock.calls[2]?.[0].runtime?.metadata).toEqual({
      grant: "grant-2",
      tenantId: "tenant-1",
      workingCopyId: "copy-1",
      revisionId: "revision-1",
      previousGrant: "grant-2",
    });
    for (const call of executeTurn.mock.calls.slice(1)) {
      expect(JSON.stringify(call[0].body)).not.toContain("grant-2");
      expect(JSON.stringify(call[0].body)).not.toContain("copy-1");
    }
  });

  it("keeps direct client-tool continuations in chat and supports a bounded chain", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>()
      .mockResolvedValueOnce({
        ...successfulResult("session-1", ""),
        clientToolCall: { id: "call-1", name: "first", arguments: {} },
        sessionVersion: 2,
      })
      .mockResolvedValueOnce({
        ...successfulResult("session-1", ""),
        clientToolCall: { id: "call-2", name: "second", arguments: {} },
        sessionVersion: 4,
      })
      .mockResolvedValueOnce({
        ...successfulResult("session-1", "done"),
        sessionVersion: 6,
      });
    const executeClientTool = vi.fn(async ({ toolCall }) => ({
      result: `${toolCall.name}-result`,
    }));
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
      executeClientTool,
    });

    await expect(handler(turn())).resolves.toMatchObject({ text: "done" });
    expect(executeClientTool).toHaveBeenCalledTimes(2);
    expect(executeTurn.mock.calls[1]?.[0].body).not.toHaveProperty("loop");
    expect(executeTurn.mock.calls[2]?.[0].body).not.toHaveProperty("loop");
    expect(executeClientTool.mock.calls[0]?.[0].idempotencyKey)
      .not.toBe(executeClientTool.mock.calls[1]?.[0].idempotencyKey);
  });

  it("fails closed when a Channel receives a client tool without an executor", async () => {
    const store = new TestSessionStore();
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn: async () => ({
        ...successfulResult("session-1", ""),
        clientToolCall: { id: "call-1", name: "configure", arguments: {} },
        sessionVersion: 2,
      }),
    });

    await expect(handler(turn())).rejects.toMatchObject({
      code: "channel_client_tool_executor_required",
    });
  });

  it("stops recursive client-tool continuations at the configured limit", async () => {
    const store = new TestSessionStore();
    let version = 0;
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn: async () => {
        version += 2;
        return {
          ...successfulResult("session-1", ""),
          clientToolCall: {
            id: `call-${version}`,
            name: "again",
            arguments: {},
          },
          sessionVersion: version,
        };
      },
      executeClientTool: async () => ({ result: "again" }),
      maxClientToolContinuations: 1,
    });

    await expect(handler(turn())).rejects.toMatchObject({
      code: "channel_client_tool_limit_exceeded",
    });
  });

  it("resolves trusted identity before agent selection and keeps it out of model arguments", async () => {
    const store = new TestSessionStore();
    const order: string[] = [];
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>(async (input) => {
      order.push("execute");
      return successfulResult(input.sessionId ?? null);
    });
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: async () => {
        order.push("agent");
        return "assistant";
      },
      executeTurn,
      resolveInvocation: async () => {
        order.push("identity");
        return {
          disposition: "dispatch",
          user: "better-auth-user-1",
          metadata: {
            tenantId: "tenant-1",
            siteId: "site-1",
            workingCopyId: "copy-1",
            grant: "ag1.signed",
          },
        };
      },
    });

    await handler(turn());

    expect(order).toEqual(["identity", "agent", "execute"]);
    expect(store.sessions[0]?.user).toBe("better-auth-user-1");
    expect(store.sessions[0]?.metadata).not.toHaveProperty("grant");
    expect(executeTurn.mock.calls[0]?.[0].body.user).toBe("better-auth-user-1");
    expect(executeTurn.mock.calls[0]?.[0].body.metadata).not.toHaveProperty("grant");
    expect(executeTurn.mock.calls[0]?.[0].runtime).toMatchObject({
      user: "better-auth-user-1",
      metadata: {
        tenantId: "tenant-1",
        siteId: "site-1",
        workingCopyId: "copy-1",
        grant: "ag1.signed",
      },
    });
    expect(Object.isFrozen(executeTurn.mock.calls[0]?.[0].runtime?.metadata)).toBe(true);
  });

  it("partitions sessions and history by immutable trusted scope", async () => {
    const store = new TestSessionStore();
    let scope = { key: "personal", version: "1" };
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>(async (input) => {
      const current = input.body.messages.at(-1)!;
      await store.addMessage(input.sessionId!, "user", current.content!);
      await store.addMessage(input.sessionId!, "assistant", `reply-${scope.key}`);
      return successfulResult(input.sessionId ?? null);
    });
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
      resolveInvocation: async () => ({
        disposition: "dispatch",
        user: "stable-user",
        scope,
      }),
    });

    await handler(turn());
    scope = { key: "work", version: "1" };
    await handler(turn({ providerEventId: "event-2" }));
    scope = { key: "personal", version: "1" };
    await handler(turn({ providerEventId: "event-3" }));

    expect(store.sessions).toHaveLength(2);
    expect(executeTurn.mock.calls[0]?.[0].runtime?.scope).toEqual({
      key: "personal",
      version: "1",
    });
    expect(Object.isFrozen(executeTurn.mock.calls[0]?.[0].runtime?.scope)).toBe(true);
    expect(executeTurn.mock.calls[1]?.[0].body.messages).toEqual([
      { content: "hello", role: "user" },
    ]);
    expect(executeTurn.mock.calls[2]?.[0].body.messages).toEqual([
      { content: "hello", role: "user" },
      { content: "reply-personal", role: "assistant" },
      { content: "hello", role: "user" },
    ]);
  });

  it("consumes pairing turns without selecting an agent, creating a session, or invoking a model", async () => {
    const store = new TestSessionStore();
    const agent = vi.fn(async () => "assistant");
    const allowedTools = vi.fn(async () => ["apply_site_change"]);
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>();
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent,
      allowedTools,
      executeTurn,
      resolveInvocation: async () => ({
        disposition: "consume",
        reply: "WhatsApp account paired.",
      }),
    });

    await expect(handler(turn())).resolves.toEqual({
      metadata: { disposition: "consume" },
      text: "WhatsApp account paired.",
    });
    expect(agent).not.toHaveBeenCalled();
    expect(allowedTools).not.toHaveBeenCalled();
    expect(executeTurn).not.toHaveBeenCalled();
    expect(store.sessions).toHaveLength(0);
  });

  it("silently consumes a turn without creating runtime state", async () => {
    const store = new TestSessionStore();
    const agent = vi.fn(async () => "assistant");
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>();
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent,
      executeTurn,
      resolveInvocation: async () => ({ disposition: "consume" }),
    });

    await expect(handler(turn())).resolves.toEqual({
      metadata: { disposition: "consume" },
    });
    expect(agent).not.toHaveBeenCalled();
    expect(executeTurn).not.toHaveBeenCalled();
    expect(store.sessions).toHaveLength(0);
  });

  it("fails closed on malformed trusted identity", async () => {
    const store = new TestSessionStore();
    const executeTurn = vi.fn<ChannelConversationTurnExecutor>();
    const handler = createConversationChannelTurnHandler(deps(store), {
      agent: "assistant",
      executeTurn,
      resolveInvocation: async () => ({
        disposition: "dispatch",
        user: "   ",
        metadata: {},
      }),
    });

    await expect(handler(turn())).rejects.toMatchObject({
      code: "channel_invocation_identity_invalid",
    });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(store.sessions).toHaveLength(0);
  });
});
