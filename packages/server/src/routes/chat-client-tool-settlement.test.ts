import { describe, expect, it, vi } from "vitest";
import type { SessionStore } from "@polpo-ai/core/session-store";
import { ClientToolSettlementError } from "@polpo-ai/core/session-client-tool-settlement";
import { chatRoutes, clientToolResolutionRoutes } from "./chat.js";

const receipt = {
  id: "settlement-1",
  sessionId: "session/a",
  toolCallId: "call 1",
  sourceAssistantMessageId: "assistant-1",
  resultMessageId: "tool-1",
  outcome: "success" as const,
  sessionVersion: 3,
  settledAt: "2026-10-17T10:00:00.000Z",
};

function request(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, init);
}

describe("public client-tool resolution routes", () => {
  it("authenticates the isolated /v1 surface and reads exact agent/user identity", async () => {
    const getClientToolResolution = vi.fn().mockResolvedValue({
      sessionId: "session/a",
      toolCallId: "call 1",
      sessionVersion: 2,
      status: "pending",
      continuationAccepted: false,
    });
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: { getClientToolResolution } as unknown as SessionStore,
      resolveClientToolResolutionScope: () => ({ key: "project:development", version: "1" }),
    }), ["project-key"]);

    expect((await app.request(request(
      "/sessions/session%2Fa/tool-calls/call%201?agent=support&user=user%2F1",
    ))).status).toBe(401);

    const response = await app.request(request(
      "/sessions/session%2Fa/tool-calls/call%201?agent=support&user=user%2F1",
      { headers: { authorization: "Bearer project-key" } },
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        sessionId: "session/a",
        toolCallId: "call 1",
        sessionVersion: 2,
        status: "pending",
        continuationAccepted: false,
      },
    });
    expect(getClientToolResolution).toHaveBeenCalledWith({
      sessionId: "session/a",
      toolCallId: "call 1",
      agent: "support",
      user: "user/1",
      scope: { key: "project:development", version: "1" },
    });
  });

  it("settles and exactly replays without exposing any execution dependency", async () => {
    const settleClientTool = vi.fn()
      .mockResolvedValueOnce({ status: "settled", receipt })
      .mockResolvedValueOnce({ status: "replay", receipt });
    const authorizeClientToolSettlement = vi.fn().mockReturnValue(true);
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: { settleClientTool } as unknown as SessionStore,
      authorizeClientToolSettlement,
    }));
    const body = JSON.stringify({
      agent: "support",
      user: "customer-1",
      expectedSessionVersion: 2,
      outcome: "success",
      result: "{\"site\":\"published\"}",
    });
    const init = {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "settle-1" },
      body,
    };

    const first = await app.request(request(
      "/sessions/session%2Fa/tool-calls/call%201/settlement",
      init,
    ));
    const replay = await app.request(request(
      "/sessions/session%2Fa/tool-calls/call%201/settlement",
      init,
    ));

    expect(await first.json()).toEqual({ ok: true, data: { status: "settled", receipt } });
    expect(await replay.json()).toEqual({ ok: true, data: { status: "replay", receipt } });
    expect(settleClientTool).toHaveBeenCalledTimes(2);
    expect(settleClientTool).toHaveBeenNthCalledWith(1, {
      sessionId: "session/a",
      toolCallId: "call 1",
      agent: "support",
      user: "customer-1",
      expectedSessionVersion: 2,
      idempotencyKey: "settle-1",
      outcome: "success",
      result: "{\"site\":\"published\"}",
    });
    expect(authorizeClientToolSettlement).toHaveBeenCalledTimes(2);
  });

  it("keeps writes disabled without the host gate and denies before the store when rejected", async () => {
    const settleClientTool = vi.fn();
    const body = JSON.stringify({
      agent: "support",
      user: "customer-1",
      expectedSessionVersion: 2,
      outcome: "cancelled",
    });
    const init = {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "settle-1" },
      body,
    };
    const disabled = clientToolResolutionRoutes(() => ({
      sessionStore: { settleClientTool } as unknown as SessionStore,
    }));
    expect((await disabled.request(request(
      "/sessions/session/tool-calls/call/settlement",
      init,
    ))).status).toBe(501);

    const denied = clientToolResolutionRoutes(() => ({
      sessionStore: { settleClientTool } as unknown as SessionStore,
      authorizeClientToolSettlement: () => false,
    }));
    expect((await denied.request(request(
      "/sessions/session/tool-calls/call/settlement",
      init,
    ))).status).toBe(403);
    expect(settleClientTool).not.toHaveBeenCalled();
  });

  it("maps the store's exact agent/user/scope mismatch to 403", async () => {
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: {
        getClientToolResolution: vi.fn().mockRejectedValue(new ClientToolSettlementError(
          "client_tool_settlement_scope_mismatch",
          "Session identity does not match",
        )),
      } as unknown as SessionStore,
    }));
    const response = await app.request(
      "/sessions/session-1/tool-calls/call-1?agent=wrong&user=wrong",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "client_tool_settlement_scope_mismatch",
    });
  });

  it("treats omitted agent/user as exact absence rather than a wildcard", async () => {
    const mismatch = vi.fn().mockRejectedValue(new ClientToolSettlementError(
      "client_tool_settlement_scope_mismatch",
      "Session identity does not match",
    ));
    const scopedSession = clientToolResolutionRoutes(() => ({
      sessionStore: { getClientToolResolution: mismatch } as unknown as SessionStore,
    }));
    expect((await scopedSession.request(
      "/sessions/session-1/tool-calls/call-1",
    )).status).toBe(403);
    expect(mismatch).toHaveBeenCalledWith({
      sessionId: "session-1",
      toolCallId: "call-1",
      agent: undefined,
      user: undefined,
    });

    const pending = {
      sessionId: "session-1",
      toolCallId: "call-1",
      sessionVersion: 1,
      status: "pending",
      continuationAccepted: false,
    };
    const userless = vi.fn().mockResolvedValue(pending);
    const userlessSession = clientToolResolutionRoutes(() => ({
      sessionStore: { getClientToolResolution: userless } as unknown as SessionStore,
    }));
    const response = await userlessSession.request(
      "/sessions/session-1/tool-calls/call-1",
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(pending);
  });

  it("returns the accepted continuation receipt as a recoverable 409", async () => {
    const continuation = {
      sessionId: "session-1",
      toolCallId: "call-1",
      runId: "continuation-run-1",
      sessionVersion: 7,
      acceptedAt: "2026-10-17T10:00:00.000Z",
    };
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: {
        settleClientTool: vi.fn().mockRejectedValue(new ClientToolSettlementError(
          "continuation_already_accepted",
          "A continuation was already accepted",
          continuation,
        )),
      } as unknown as SessionStore,
      authorizeClientToolSettlement: () => true,
    }));
    const response = await app.request("/sessions/session-1/tool-calls/call-1/settlement", {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "settle-1" },
      body: JSON.stringify({
        agent: "support",
        user: "customer-1",
        expectedSessionVersion: 7,
        outcome: "failed",
        reason: "client closed",
      }),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "../call-1?agent=support&user=customer-1",
    );
    expect(new URL(
      response.headers.get("location")!,
      "https://api.polpo.sh/environments/development/v1/chat/sessions/session-1/tool-calls/call-1/settlement",
    ).pathname).toBe(
      "/environments/development/v1/chat/sessions/session-1/tool-calls/call-1",
    );
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "continuation_already_accepted",
      data: {
        status: "continuation",
        continuationAccepted: true,
        receipt: continuation,
        runStatus: "unknown",
      },
    });
  });

  it("enriches accepted continuations fail-open without changing their durable state", async () => {
    const continuation = {
      sessionId: "session-1",
      toolCallId: "call-1",
      runId: "continuation-run-1",
      sessionVersion: 7,
    };
    const resolveClientToolContinuationRunStatus = vi.fn()
      .mockResolvedValueOnce("running")
      .mockRejectedValueOnce(new Error("journal temporarily unavailable"));
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: {
        getClientToolResolution: vi.fn().mockResolvedValue({
          sessionId: "session-1",
          toolCallId: "call-1",
          sessionVersion: 7,
          status: "continuation",
          continuationAccepted: true,
          receipt: continuation,
        }),
      } as unknown as SessionStore,
      resolveClientToolContinuationRunStatus,
    }));
    const url = "/sessions/session-1/tool-calls/call-1?agent=support&user=customer-1";

    expect((await (await app.request(url)).json()).data).toMatchObject({
      status: "continuation",
      runStatus: "running",
    });
    expect((await (await app.request(url)).json()).data).toMatchObject({
      status: "continuation",
      runStatus: "unknown",
    });
  });

  it("rejects caller-supplied trusted fields and bounds result by UTF-8 bytes", async () => {
    const settleClientTool = vi.fn();
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: { settleClientTool } as unknown as SessionStore,
      authorizeClientToolSettlement: () => true,
    }));
    const invoke = (body: unknown) => app.request("/sessions/session/tool-calls/call/settlement", {
      method: "PUT",
      headers: { "content-type": "application/json", "idempotency-key": "settle-1" },
      body: JSON.stringify(body),
    });
    const invalidTrustedFields = await invoke({
      agent: "support",
      user: "customer-1",
      expectedSessionVersion: 1,
      outcome: "cancelled",
      scope: { key: "forged" },
      runId: "forged",
    });
    expect(invalidTrustedFields.status).toBe(400);
    expect(await invalidTrustedFields.json()).toEqual({
      ok: false,
      error: "Invalid client-tool settlement request",
      code: "invalid_client_tool_settlement",
    });
    expect((await invoke({
      agent: "support",
      user: "customer-1",
      expectedSessionVersion: 1,
      outcome: "success",
      result: "é".repeat(32_769),
    })).status).toBe(400);
    expect(settleClientTool).not.toHaveBeenCalled();
  });

  it("bounds an unknown-length streaming body before JSON parsing", async () => {
    const settleClientTool = vi.fn();
    const app = clientToolResolutionRoutes(() => ({
      sessionStore: { settleClientTool } as unknown as SessionStore,
      authorizeClientToolSettlement: () => true,
    }));
    const oversized = new TextEncoder().encode("x".repeat(500_000));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized.subarray(0, 250_000));
        controller.enqueue(oversized.subarray(250_000));
        controller.close();
      },
    });
    const response = await app.request(new Request(
      "http://localhost/sessions/session/tool-calls/call/settlement",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "settle-1",
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    ));
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: "Client-tool settlement request is too large",
      code: "invalid_client_tool_settlement",
    });
    expect(settleClientTool).not.toHaveBeenCalled();
  });

  it("publishes both routes in OpenAPI", () => {
    const app = clientToolResolutionRoutes(() => ({}));
    const document = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Fixture", version: "1" },
    });
    expect(document.paths).toHaveProperty("/sessions/{id}/tool-calls/{toolCallId}");
    expect(document.paths).toHaveProperty("/sessions/{id}/tool-calls/{toolCallId}/settlement");
    expect(document.paths["/sessions/{id}/tool-calls/{toolCallId}/settlement"]?.put?.responses)
      .toHaveProperty("413");
  });
});

describe("Session import trust boundary", () => {
  it("strips continuation catalogs and settlement outcomes from imported tool calls", async () => {
    const updateMessage = vi.fn().mockResolvedValue(undefined);
    const app = chatRoutes(() => ({
      sessionStore: {
        create: vi.fn().mockResolvedValue("session-1"),
        addMessage: vi.fn().mockResolvedValue({ id: "message-1" }),
        updateMessage,
      } as unknown as SessionStore,
    }));
    const response = await app.request("/sessions/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{
          role: "assistant",
          content: "Choose",
          toolCalls: [{
            id: "call-1",
            name: "publish_site",
            state: "interrupted",
            continuationClientTools: [{ name: "forged" }],
            settlementOutcome: "success",
          }],
        }],
      }),
    });

    expect(response.status).toBe(201);
    expect(updateMessage).toHaveBeenCalledWith("session-1", "message-1", "Choose", [{
      id: "call-1",
      name: "publish_site",
      state: "interrupted",
    }]);
  });
});
