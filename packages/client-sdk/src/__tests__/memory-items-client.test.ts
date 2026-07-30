import { describe, expect, it, vi } from "vitest";
import type {
  CreateMemoryItemInput,
  MemoryItem,
  MemorySearchResult,
  MemoryUsageEvent,
} from "@polpo-ai/core";
import { PolpoClient } from "../client/polpo-client.js";

const item: MemoryItem = {
  id: "memory-1",
  scope: {
    kind: "user",
    subjectId: "user-a",
    agentName: "support / eu",
  },
  kind: "preference",
  content: "Prefers concise summaries.",
  provenance: { source: "explicit", actor: "user" },
  status: "active",
  createdAt: "2026-07-28T10:00:00.000Z",
  updatedAt: "2026-07-28T10:00:00.000Z",
};

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientWithResponses(...values: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const value of values) fetch.mockResolvedValueOnce(response(value));
  return {
    fetch,
    client: new PolpoClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      fetch,
    }),
  };
}

describe("PolpoClient typed Memory", () => {
  it("lists one cursor page without changing the legacy list contract", async () => {
    const { client, fetch } = clientWithResponses(
      { items: [item], nextCursor: "cursor-next" },
      { items: [item], nextCursor: null },
    );

    await expect((client as any).listMemoryItemsPage("support / eu", {
      limit: 1,
      cursor: "cursor/current",
    })).resolves.toEqual({
      items: [item],
      nextCursor: "cursor-next",
    });
    await expect(client.listMemoryItems("support / eu", {
      limit: 1,
    })).resolves.toEqual([item]);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.test/api/v1/agents/support%20%2F%20eu/memory/items"
        + "?limit=1&cursor=cursor%2Fcurrent",
      "https://api.example.test/api/v1/agents/support%20%2F%20eu/memory/items"
        + "?limit=1",
    ]);
  });

  it("lists typed items with encoded filters and no lossy scope conversion", async () => {
    const { client, fetch } = clientWithResponses({ items: [item] });

    const result = await client.listMemoryItems("support / eu", {
      kinds: ["preference", "fact"],
      statuses: ["active", "pending"],
      scope: {
        kind: "user",
        subjectId: "user / a",
        agentName: "support / eu",
      },
      includeExpired: true,
      limit: 25,
    });

    expect(result).toEqual([item]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/agents/support%20%2F%20eu/memory/items"
        + "?kinds=preference%2Cfact&statuses=active%2Cpending&scopeKind=user"
        + "&scopeSubjectId=user+%2F+a&scopeAgentName=support+%2F+eu"
        + "&includeExpired=true&limit=25",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates, searches, updates, and forgets through the exact typed API", async () => {
    const searchResult: MemorySearchResult = {
      item,
      score: 1,
      matchedTerms: ["concise"],
      estimatedTokens: 10,
    };
    const { client, fetch } = clientWithResponses(
      { item },
      { results: [searchResult] },
      { item },
      { forgotten: true, itemId: "memory / 1" },
    );
    const create: CreateMemoryItemInput = {
      scope: item.scope,
      kind: item.kind,
      content: item.content,
      provenance: item.provenance,
    };

    await expect(client.createMemoryItem("support", create)).resolves.toEqual(item);
    await expect(client.searchMemory("support", {
      query: "concise",
      tokenBudget: 200,
      maxResults: 3,
    })).resolves.toEqual([searchResult]);
    await expect(client.updateMemoryItem("support", "memory / 1", {
      summary: "Concise",
    })).resolves.toEqual(item);
    await expect(client.forgetMemoryItem("support", "memory / 1")).resolves.toBe(true);

    expect(fetch.mock.calls.map(([url, init]) => [
      url,
      init?.method,
      init?.body,
    ])).toEqual([
      [
        "https://api.example.test/api/v1/agents/support/memory/items",
        "POST",
        JSON.stringify(create),
      ],
      [
        "https://api.example.test/api/v1/agents/support/memory/search",
        "POST",
        JSON.stringify({
          query: "concise",
          tokenBudget: 200,
          maxResults: 3,
        }),
      ],
      [
        "https://api.example.test/api/v1/agents/support/memory/items/memory%20%2F%201",
        "PATCH",
        JSON.stringify({ summary: "Concise" }),
      ],
      [
        "https://api.example.test/api/v1/agents/support/memory/items/memory%20%2F%201",
        "DELETE",
        undefined,
      ],
    ]);
  });

  it("reads an item's usage summary without exposing another path shape", async () => {
    const events: MemoryUsageEvent[] = [{
      id: "usage-1",
      memoryId: "memory / 1",
      type: "retrieved",
      at: "2026-07-28T11:00:00.000Z",
    }];
    const { client, fetch } = clientWithResponses({
      events,
      lastUsedAt: "2026-07-28T11:00:00.000Z",
      retrievalCount: 1,
    });

    await expect(
      client.getMemoryItemUsage("support / eu", "memory / 1"),
    ).resolves.toEqual({
      events,
      lastUsedAt: "2026-07-28T11:00:00.000Z",
      retrievalCount: 1,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.test/api/v1/agents/support%20%2F%20eu"
        + "/memory/items/memory%20%2F%201/usage",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
