import { describe, expect, it, vi } from "vitest";
import { chatRoutes } from "./chat.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function session(id = "session-1") {
  return {
    agent: "agent-1",
    createdAt: "2026-08-28T00:00:00.000Z",
    id,
    messageCount: 1,
    updatedAt: "2026-08-28T00:00:00.000Z",
    version: 1,
  };
}

function message(sessionId = "session-1") {
  return {
    content: "hello",
    id: "message-1",
    role: "user" as const,
    sessionId,
    ts: "2026-08-28T00:00:00.000Z",
  };
}

function transientTimeout(): Error {
  const error = new Error("Failed query");
  error.cause = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  return error;
}

describe("chatRoutes session history", () => {
  it("coalesces concurrent reads for the same session without caching the result", async () => {
    const sessionRead = deferred<ReturnType<typeof session>>();
    const messagesRead = deferred<ReturnType<typeof message>[]>();
    const getSession = vi.fn(() => sessionRead.promise);
    const getMessages = vi.fn(() => messagesRead.promise);
    const sessionStore = { getMessages, getSession } as any;
    const app = chatRoutes(() => ({
      sessionStore,
    }));

    const requests = Array.from({ length: 10 }, () =>
      app.request("/sessions/session-1/messages"));
    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalledOnce();
      expect(getMessages).toHaveBeenCalledOnce();
    });

    sessionRead.resolve(session());
    messagesRead.resolve([message()]);
    const responses = await Promise.all(requests);

    expect(responses.every((response) => response.status === 200)).toBe(true);
    await app.request("/sessions/session-1/messages");
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("retries one transient session-store timeout", async () => {
    const getSession = vi.fn()
      .mockRejectedValueOnce(transientTimeout())
      .mockResolvedValue(session());
    const getMessages = vi.fn().mockResolvedValue([message()]);
    const app = chatRoutes(() => ({
      sessionStore: { getMessages, getSession } as any,
    }));

    const response = await app.request("/sessions/session-1/messages");

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(getMessages).toHaveBeenCalledTimes(2);
  });

  it("never coalesces identical session IDs across different stores", async () => {
    const firstSession = deferred<ReturnType<typeof session>>();
    const firstMessages = deferred<ReturnType<typeof message>[]>();
    const firstStore = {
      getMessages: vi.fn(() => firstMessages.promise),
      getSession: vi.fn(() => firstSession.promise),
    };
    const secondStore = {
      getMessages: vi.fn().mockResolvedValue([message()]),
      getSession: vi.fn().mockResolvedValue({ ...session(), agent: "agent-2" }),
    };
    let activeStore: any = firstStore;
    const app = chatRoutes(() => ({ sessionStore: activeStore }));

    const first = app.request("/sessions/session-1/messages");
    await vi.waitFor(() => expect(firstStore.getSession).toHaveBeenCalledOnce());
    activeStore = secondStore;
    const second = app.request("/sessions/session-1/messages");
    const secondResponse = await second;
    firstSession.resolve(session());
    firstMessages.resolve([message()]);
    const firstResponse = await first;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(firstStore.getSession).toHaveBeenCalledOnce();
    expect(secondStore.getSession).toHaveBeenCalledOnce();
    expect((await secondResponse.json()).data.session.agent).toBe("agent-2");
  });

  it("shares an in-flight history read with the session activity endpoint", async () => {
    const sessionRead = deferred<ReturnType<typeof session>>();
    const messagesRead = deferred<ReturnType<typeof message>[]>();
    const getSession = vi.fn(() => sessionRead.promise);
    const getMessages = vi.fn(() => messagesRead.promise);
    const getRunsBySessionId = vi.fn().mockResolvedValue([]);
    const sessionStore = { getMessages, getSession } as any;
    const app = chatRoutes(() => ({
      runStore: { getRunsBySessionId } as any,
      sessionStore,
    }));

    const messagesResponse = app.request("/sessions/session-1/messages");
    const activityResponse = app.request("/sessions/session-1/activity");
    await vi.waitFor(() => {
      expect(getSession).toHaveBeenCalledOnce();
      expect(getMessages).toHaveBeenCalledOnce();
    });
    sessionRead.resolve(session());
    messagesRead.resolve([message()]);

    expect((await messagesResponse).status).toBe(200);
    expect((await activityResponse).status).toBe(200);
    expect(getRunsBySessionId).toHaveBeenCalledOnce();
  });

  it("does not retry non-transient store failures", async () => {
    const getSession = vi.fn().mockRejectedValue(new Error("invalid row mapping"));
    const app = chatRoutes(() => ({
      sessionStore: {
        getMessages: vi.fn().mockResolvedValue([message()]),
        getSession,
      } as any,
    }));

    const response = await app.request("/sessions/session-1/messages");

    expect(response.status).toBe(500);
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("returns a retryable 503 after repeated transient failures", async () => {
    const getSession = vi.fn().mockRejectedValue(transientTimeout());
    const getMessages = vi.fn().mockResolvedValue([message()]);
    const app = chatRoutes(() => ({
      sessionStore: { getMessages, getSession } as any,
    }));

    const response = await app.request("/sessions/session-1/messages");

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({
      code: "SESSION_STORE_TEMPORARILY_UNAVAILABLE",
      error: "Session history is temporarily unavailable",
      ok: false,
    });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("releases a failed in-flight read so the next request can recover", async () => {
    const getSession = vi.fn()
      .mockRejectedValueOnce(transientTimeout())
      .mockRejectedValueOnce(transientTimeout())
      .mockResolvedValue(session());
    const getMessages = vi.fn().mockResolvedValue([message()]);
    const app = chatRoutes(() => ({
      sessionStore: { getMessages, getSession } as any,
    }));

    const failed = await app.request("/sessions/session-1/messages");
    const recovered = await app.request("/sessions/session-1/messages");

    expect(failed.status).toBe(503);
    expect(recovered.status).toBe(200);
    expect(getSession).toHaveBeenCalledTimes(3);
  });
});
