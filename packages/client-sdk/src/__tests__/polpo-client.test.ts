import { describe, expect, it, vi } from "vitest";
import { PolpoClient } from "../client/polpo-client.js";

describe("PolpoClient approvals", () => {
  it("lists pending approvals through the status filter supported by the server", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new PolpoClient({
      baseUrl: "http://localhost:3890",
      apiKey: "test-key",
      fetch,
    });

    await client.getPendingApprovals();

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/approvals?status=pending",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });
});

describe("PolpoClient skill bundles", () => {
  it("gets and atomically puts complete binary-safe bundles", async () => {
    const bundle = {
      name: "frontend-design",
      files: [
        { path: "SKILL.md", content: "IyBTa2lsbA==", encoding: "base64" as const },
        { path: "assets/logo.bin", content: "AAEC/w==", encoding: "base64" as const },
      ],
    };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: bundle }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { name: bundle.name, files: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });

    await expect(client.getSkillBundle("frontend/design")).resolves.toEqual(bundle);
    await expect(client.putSkillBundle(bundle)).resolves.toEqual({ name: bundle.name, files: 2 });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/skills/frontend%2Fdesign/bundle",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/skills/frontend-design/bundle",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ files: bundle.files }) }),
    );
  });
});

describe("PolpoClient conversation Channels", () => {
  it("keeps management endpoints distinct from legacy notification Channels", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });

    await client.listChannels();
    await client.listConversationChannels({
      provider: "whatsapp",
      status: "active",
      connectionId: "connection/a",
    });

    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.polpo.sh/v1/config/channels");
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.polpo.sh/v1/channels?provider=whatsapp&status=active&connectionId=connection%2Fa",
    );
  });

  it("encodes Channel and Route ids and sends typed bodies", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(
      JSON.stringify({ ok: true, data: { removed: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });

    await client.configureConversationChannel({
      provider: "telegram",
      agentName: "assistant",
      idempotencyKey: "setup-1",
    });
    await client.removeConversationChannelRoute("channel/a", "route b");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/channels/configure",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "telegram",
          agentName: "assistant",
          idempotencyKey: "setup-1",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/channels/channel%2Fa/routes/route%20b",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("PolpoClient run steering", () => {
  it("captures namespaced chat suggestions without requiring a kind", async () => {
    const suggestion = {
      id: "suggestion_tests",
      label: "Add tests",
      prompt: "Add tests for this change.",
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      [
        `data: ${JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "polpo",
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          polpo: { suggestions: [suggestion] },
        })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const stream = client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
    });

    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks[0]?.polpo?.suggestions).toEqual([suggestion]);
    expect(stream.suggestions).toEqual([suggestion]);
    expect(stream.suggestions[0]).not.toHaveProperty("kind");
  });

  it("sends typed steering and abort commands to encoded active run paths", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { runId: "chatcmpl/a", id: "msg-1", accepted: true, duplicate: false },
      }), { status: 202, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { runId: "chatcmpl/a", aborted: true },
      }), { status: 202, headers: { "content-type": "application/json" } }));
    const client = new PolpoClient({
      baseUrl: "https://api.polpo.sh",
      apiKey: "test-key",
      fetch,
    });

    await client.steerRun("chatcmpl/a", {
      id: "msg-1",
      mode: "follow_up",
      content: { text: "Then summarize" },
    });
    await client.abortRun("chatcmpl/a", "user cancelled");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/runs/chatcmpl%2Fa/steering",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
        body: JSON.stringify({
          id: "msg-1",
          mode: "follow_up",
          content: { text: "Then summarize" },
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/runs/chatcmpl%2Fa/abort",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "user cancelled" }),
      }),
    );
  });

  it("exposes the active run id when a chat stream starts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      "data: [DONE]\n\n",
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-session-id": "session-1",
          "x-polpo-run-id": "chatcmpl-1",
        },
      },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const stream = client.chatCompletionsStream({
      agent: "assistant",
      messages: [{ role: "user", content: "start" }],
    });

    await stream.start();

    expect(stream.sessionId).toBe("session-1");
    expect(stream.runId).toBe("chatcmpl-1");
  });

  it("reconnects a durable chat from the last complete SSE cursor without recreating it", async () => {
    const chunk = (content: string) => ({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "polpo",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
    const event = (sequence: number, type: string, data: Record<string, unknown>) => ({
      id: String(sequence),
      runId: "chatcmpl-1",
      sequence,
      schemaVersion: 1,
      type,
      data,
      createdAt: "2026-08-19T00:00:00.000Z",
    });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify(chunk("before "))}\nid: 1\n\n`,
        { status: 200, headers: { "x-polpo-run-id": "chatcmpl-1" } },
      ))
      .mockResolvedValueOnce(new Response([
        `data: ${JSON.stringify(event(2, "response.chunk", { data: JSON.stringify(chunk("after")) }))}`,
        "id: 2",
        "",
        `data: ${JSON.stringify(event(3, "response.done", { data: "[DONE]" }))}`,
        "id: 3",
        "",
        "",
      ].join("\n"), { status: 200 }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", apiKey: "key", fetch });
    const stream = client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
      polpo: { delivery: { onDisconnect: "continue" } },
    });
    const states: string[] = [];
    stream.subscribeConnectionState((state) => states.push(state));

    const received = [];
    for await (const item of stream) received.push(item);

    expect(received.map((item) => item.choices[0]?.delta.content)).toEqual(["before ", "after"]);
    expect(stream.lastEventId).toBe("3");
    expect(states).toEqual(["streaming", "reconnecting", "streaming", "closed"]);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/runs/chatcmpl-1/events?cursor=1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer key",
          "Last-Event-ID": "1",
        }),
      }),
    );
  });

  it("distinguishes local detach from explicit durable cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("data: [DONE]\nid: 1\n\n", {
        status: 200,
        headers: { "x-polpo-run-id": "chatcmpl/a" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { runId: "chatcmpl/a", accepted: true },
      }), { status: 202 }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const detached = client.chatCompletionsStream({ messages: [{ role: "user", content: "start" }] });
    await detached.start();
    detached.detach();
    expect(fetch).toHaveBeenCalledTimes(1);

    const cancellable = client.chatCompletionsStream({ messages: [{ role: "user", content: "start" }] });
    cancellable.runId = "chatcmpl/a";
    await cancellable.cancel("stop");
    expect(fetch).toHaveBeenLastCalledWith(
      "https://api.polpo.sh/v1/runs/chatcmpl%2Fa/cancel",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ reason: "stop" }) }),
    );
  });

  it("streams typed canonical run events from an explicit cursor", async () => {
    const event = {
      id: "event-2",
      runId: "run/a",
      sequence: 2,
      schemaVersion: 1,
      type: "run.completed",
      data: {},
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      `event: run.event\ndata: ${JSON.stringify(event)}\nid: 2\n\n`,
      { status: 200 },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const received = [];
    for await (const item of client.streamRunEvents("run/a", { after: "1" })) received.push(item);

    expect(received).toEqual([event]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.polpo.sh/v1/runs/run%2Fa/events?cursor=1",
      expect.objectContaining({
        headers: expect.objectContaining({ "Last-Event-ID": "1" }),
      }),
    );
  });

  it("parses CRLF event boundaries split across transport chunks", async () => {
    const chunk = {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "polpo",
      choices: [{ index: 0, delta: { content: "split" }, finish_reason: null }],
    };
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\r`));
        controller.enqueue(encoder.encode("\n\r"));
        controller.enqueue(encoder.encode("\ndata: [DONE]\r\n\r"));
        controller.enqueue(encoder.encode("\n"));
        controller.close();
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "x-polpo-run-id": "chatcmpl-1" },
    }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const received = [];

    for await (const item of client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
    })) received.push(item);

    expect(received).toEqual([chunk]);
  });

  it("surfaces a persisted terminal failure without reconnecting", async () => {
    const failed = {
      id: "run.failed",
      runId: "run-1",
      sequence: 2,
      schemaVersion: 1,
      type: "run.failed",
      data: { message: "provider unavailable" },
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      `id: 2\nevent: run.event\ndata: ${JSON.stringify(failed)}\n\n`,
      { status: 200 },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const stream = client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
      polpo: { delivery: { onDisconnect: "continue" } },
    });
    stream.runId = "run-1";
    stream.resume({ after: "1" });

    await expect(async () => {
      for await (const _item of stream) { /* consume */ }
    }).rejects.toThrow("provider unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed durable response chunks instead of reconnecting forever", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      "id: 1\ndata: {not-json}\n\n",
      { status: 200, headers: { "x-polpo-run-id": "run-1" } },
    ));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const stream = client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
      polpo: { delivery: { onDisconnect: "continue" } },
    });

    await expect(async () => {
      for await (const _item of stream) { /* consume */ }
    }).rejects.toThrow("malformed response chunk");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect when the resume endpoint confirms the terminal cursor", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("", {
      status: 200,
      headers: { "x-polpo-run-terminal": "true" },
    }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const stream = client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
      polpo: { delivery: { onDisconnect: "continue" } },
    });
    stream.runId = "run-1";
    stream.resume({ after: "4" });
    const received = [];

    for await (const item of stream) received.push(item);

    expect(received).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a stream detached during reconnect backoff", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("", {
      status: 200,
      headers: { "x-polpo-run-id": "run-1" },
    }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const stream = client.chatCompletionsStream({
      messages: [{ role: "user", content: "start" }],
      polpo: { delivery: { onDisconnect: "continue" } },
    });
    stream.subscribeConnectionState((state) => {
      if (state === "reconnecting") stream.detach();
    });

    for await (const _item of stream) { /* consume */ }

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("PolpoClient structured outputs", () => {
  it("forwards response_format in non-streaming and streaming requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new PolpoClient({ baseUrl: "https://api.polpo.sh", fetch });
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: {
        name: "result",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    };

    await client.chatCompletions({
      agent: "assistant",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: responseFormat,
    });
    await client.chatCompletionsStream({
      agent: "assistant",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: responseFormat,
    }).start();

    expect(JSON.parse((fetch.mock.calls[0]?.[1] as RequestInit).body as string)).toMatchObject({
      response_format: responseFormat,
      stream: false,
    });
    expect(JSON.parse((fetch.mock.calls[1]?.[1] as RequestInit).body as string)).toMatchObject({
      response_format: responseFormat,
      stream: true,
    });
  });
});

describe("PolpoClient schedules v2", () => {
  function clientWith(responseData: unknown = {}) {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () => new Response(
        JSON.stringify({ ok: true, data: responseData }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new PolpoClient({
      baseUrl: "http://localhost:3890",
      apiKey: "test-key",
      fetch,
    });
    return { client, fetch };
  }

  it("lists schedules with bounded typed filters", async () => {
    const { client, fetch } = clientWith([]);

    await client.listSchedules({
      status: "active",
      surface: "agent",
      includeDeleted: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/schedules?status=active&surface=agent&includeDeleted=true",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("sends optimistic revisions for mutations", async () => {
    const { client, fetch } = clientWith({ id: "daily" });

    await client.updateScheduleV2(
      "daily",
      { name: "Updated" },
      { expectedRevision: 7 },
    );
    await client.pauseSchedule("daily", { expectedRevision: 8 });
    await client.resumeSchedule("daily", { expectedRevision: 9 });
    await client.deleteScheduleV2("daily", { expectedRevision: 10 });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3890/api/v1/schedules/daily",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({ "If-Match": "\"7\"" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:3890/api/v1/schedules/daily/pause",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "If-Match": "\"8\"" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "http://localhost:3890/api/v1/schedules/daily/resume",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "If-Match": "\"9\"" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "http://localhost:3890/api/v1/schedules/daily",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ "If-Match": "\"10\"" }),
      }),
    );
  });

  it("creates manual runs with a caller idempotency key", async () => {
    const { client, fetch } = clientWith({ id: "run-1" });

    await client.triggerSchedule("daily", {
      idempotencyKey: "manual-2026-07-28",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/schedules/daily/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "manual-2026-07-28" }),
      }),
    );
  });

  it("lists run history with deterministic query serialization", async () => {
    const { client, fetch } = clientWith([]);

    await client.listScheduleRuns("daily", {
      status: "failed",
      order: "asc",
      limit: 25,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3890/api/v1/schedules/daily/runs?status=failed&limit=25&order=asc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects invalid client-side revision and run limits before fetch", async () => {
    const { client, fetch } = clientWith([]);

    await expect(client.pauseSchedule("daily", {
      expectedRevision: 0,
    })).rejects.toThrow(/revision/i);
    await expect(client.listScheduleRuns("daily", {
      limit: 1001,
    })).rejects.toThrow(/limit/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("PolpoClient Brain", () => {
  function setup() {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () => new Response(
        JSON.stringify({ ok: true, data: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new PolpoClient({
      baseUrl: "https://api.polpo.sh",
      apiKey: "test-key",
      fetch,
    });
    return { client, fetch };
  }

  it("encodes list filters and exact scopes", async () => {
    const { client, fetch } = setup();

    await client.listBrainSources({
      scope: { kind: "project", subjectId: "project/a" },
      statuses: ["indexed", "failed"],
      types: ["paste", "url"],
      limit: 25,
      cursor: "next page",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.polpo.sh/v1/brain/sources?scopeKind=project&scopeId=project%2Fa&status=indexed%2Cfailed&type=paste%2Curl&limit=25&cursor=next+page",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses typed request bodies for create, update, reindex, and search", async () => {
    const { client, fetch } = setup();
    const scope = { kind: "project", subjectId: "project-a" } as const;

    await client.createBrainSource({
      scope,
      label: "Runbook",
      trust: "user_provided",
      content: { kind: "paste", text: "Support policy." },
    });
    await client.updateBrainSource(
      "source/1",
      { label: "Updated" },
      scope,
    );
    await client.reindexBrainSource(
      "source/1",
      { content: { kind: "url", url: "https://example.com/runbook" } },
      scope,
    );
    await client.searchBrain({
      query: "refund",
      scopes: [scope],
      limit: 3,
      tokenBudget: 500,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/brain/sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope,
          label: "Runbook",
          trust: "user_provided",
          content: { kind: "paste", text: "Support policy." },
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/brain/sources/source%2F1?scopeKind=project&scopeId=project-a",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ label: "Updated" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://api.polpo.sh/v1/brain/sources/source%2F1/reindex?scopeKind=project&scopeId=project-a",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          content: { kind: "url", url: "https://example.com/runbook" },
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "https://api.polpo.sh/v1/brain/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "refund",
          scopes: [scope],
          limit: 3,
          tokenBudget: 500,
        }),
      }),
    );
  });

  it("uses exact source paths for get and delete", async () => {
    const { client, fetch } = setup();

    await client.getBrainSource("source 1");
    await client.deleteBrainSource("source 1", {
      kind: "org",
      subjectId: "org-1",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/brain/sources/source%201",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/brain/sources/source%201?scopeKind=org&scopeId=org-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("lists versions and reads bounded chunks using encoded source paths", async () => {
    const { client, fetch } = setup();
    const scope = { kind: "project", subjectId: "project/a" } as const;

    await client.listBrainSourceVersions("source/1", scope);
    await client.readBrainSource("source/1", {
      scope,
      version: "v 2",
      offset: 3,
      limit: 8,
      tokenBudget: 1200,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.polpo.sh/v1/brain/sources/source%2F1/versions?scopeKind=project&scopeId=project%2Fa",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.polpo.sh/v1/brain/sources/source%2F1/read?scopeKind=project&scopeId=project%2Fa&version=v+2&offset=3&limit=8&tokenBudget=1200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects invalid Brain read pagination without making a request", async () => {
    const { client, fetch } = setup();

    expect(() => client.readBrainSource("source-1", {
      offset: -1,
    })).toThrow(/offset/i);
    expect(() => client.readBrainSource("source-1", {
      limit: 101,
    })).toThrow(/limit/i);
    expect(() => client.readBrainSource("source-1", {
      tokenBudget: 0,
    })).toThrow(/tokenBudget/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
