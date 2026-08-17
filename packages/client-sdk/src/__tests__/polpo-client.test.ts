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
