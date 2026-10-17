import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";

describe("self-hosted client-tool settlement wiring", () => {
  it("mounts only the settlement resource at /v1/chat behind project API-key auth", async () => {
    const receipt = {
      id: "settlement-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      sourceAssistantMessageId: "assistant-1",
      resultMessageId: "tool-1",
      outcome: "cancelled" as const,
      sessionVersion: 3,
      settledAt: "2026-10-17T10:00:00.000Z",
    };
    const settleClientTool = vi.fn().mockResolvedValue({ status: "settled", receipt });
    const getClientToolResolution = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      toolCallId: "call-1",
      sessionVersion: 3,
      status: "settled",
      continuationAccepted: false,
      receipt,
    });
    const orchestrator = {
      isInitialized: true,
      getSessionStore: () => ({ settleClientTool, getClientToolResolution }),
      getRunStore: () => ({ getRun: vi.fn().mockResolvedValue(undefined) }),
    };
    const app = createApp(orchestrator as never, {} as never, { apiKeys: ["project-key"] });
    const settlementUrl = "/v1/chat/sessions/session-1/tool-calls/call-1/settlement";

    expect((await app.request(settlementUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).status).toBe(401);

    const response = await app.request(settlementUrl, {
      method: "PUT",
      headers: {
        authorization: "Bearer project-key",
        "content-type": "application/json",
        "idempotency-key": "settle-1",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        agent: "support",
        user: "customer-1",
        expectedSessionVersion: 2,
        outcome: "cancelled",
        reason: "browser closed",
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase())
      .toContain("location");
    expect(await response.json()).toEqual({ ok: true, data: { status: "settled", receipt } });
    expect(settleClientTool).toHaveBeenCalledTimes(1);

    const read = await app.request(
      "/v1/chat/sessions/session-1/tool-calls/call-1?agent=support&user=customer-1",
      { headers: { "x-api-key": "project-key" } },
    );
    expect(read.status).toBe(200);
    expect(getClientToolResolution).toHaveBeenCalledTimes(1);

    // Existing control-plane session routes keep their own /api/v1 auth mount.
    expect((await app.request("/api/v1/chat/sessions")).status).toBe(401);

    const noKeyHost = createApp(orchestrator as never, {} as never);
    expect((await noKeyHost.request(settlementUrl, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "settle-without-project-key",
      },
      body: JSON.stringify({
        agent: "support",
        user: "customer-1",
        expectedSessionVersion: 2,
        outcome: "cancelled",
      }),
    })).status).toBe(501);
    expect(settleClientTool).toHaveBeenCalledTimes(1);
  });
});
