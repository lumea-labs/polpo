/**
 * Web search tools — thin wrappers over a SearchProvider.
 *
 * The provider is injected by the shell (OSS today: ExaSearchProvider).
 * The tool layer doesn't know which backend runs; it formats results
 * for the agent and surfaces errors. `search_find_similar` is registered
 * only when the provider implements the optional `findSimilar` method.
 */

import { Type } from "@sinclair/typebox";
import type { PolpoTool as AgentTool, SearchProvider, SearchResult } from "@polpo-ai/core";

const DEFAULT_NUM_RESULTS = 5;

// ─── Helpers ───

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}
function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: true } };
}

function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "(no results)";

  return results.map((r, i) => {
    const parts = [`${i + 1}. **${r.title || r.url}**`, `   ${r.url}`];
    if (r.publishedDate) parts.push(`   Published: ${r.publishedDate}`);
    if (r.text) {
      const text = r.text.length > 1500 ? r.text.slice(0, 1500) + "..." : r.text;
      parts.push(`   ${text}`);
    }
    return parts.join("\n");
  }).join("\n\n");
}

// ─── Tool: search_web ───

const SearchWebSchema = Type.Object({
  query: Type.String({ description: "Natural language search query. Be descriptive — semantic search providers reward intent over keywords." }),
  numResults: Type.Optional(Type.Number({ description: `Number of results to return (default: ${DEFAULT_NUM_RESULTS}, max: 20)` })),
  includeContent: Type.Optional(Type.Boolean({ description: "Include page content/summary in results (default: true). Costs more but saves a follow-up http_fetch." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only return results from these domains (e.g. ['github.com', 'docs.python.org'])" })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains" })),
  startPublishedDate: Type.Optional(Type.String({ description: "Only results published after this date (ISO format, e.g. '2024-01-01')" })),
  endPublishedDate: Type.Optional(Type.String({ description: "Only results published before this date (ISO format)" })),
});

function createSearchWebTool(provider: SearchProvider): AgentTool<typeof SearchWebSchema> {
  return {
    name: "search_web",
    label: "Web Search",
    description:
      `Search the web via ${provider.name}. Returns relevant pages with titles, URLs, and optionally snippet/summary. ` +
      "Use natural language queries. Example: 'how to implement OAuth2 with Better Auth in Next.js'",
    parameters: SearchWebSchema,
    async execute(_id, params, signal) {
      try {
        const results = await provider.search(params.query, {
          numResults: params.numResults,
          includeText: params.includeContent ?? true,
          includeDomains: params.includeDomains,
          excludeDomains: params.excludeDomains,
          startPublishedDate: params.startPublishedDate,
          endPublishedDate: params.endPublishedDate,
          signal,
        });
        const header = `Found ${results.length} result(s) for: "${params.query}"`;
        return ok(`${header}\n\n${formatResults(results)}`, {
          provider: provider.name,
          query: params.query,
          count: results.length,
        });
      } catch (e: any) {
        return err(`Error: web search failed (${provider.name}) — ${e.message}`);
      }
    },
  };
}

// ─── Tool: search_find_similar ───

const FindSimilarSchema = Type.Object({
  url: Type.String({ description: "URL of a page to find similar content for" }),
  numResults: Type.Optional(Type.Number({ description: `Number of results (default: ${DEFAULT_NUM_RESULTS}, max: 20)` })),
  includeContent: Type.Optional(Type.Boolean({ description: "Include page content/summary (default: false)" })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains" })),
});

function createFindSimilarTool(provider: SearchProvider): AgentTool<typeof FindSimilarSchema> {
  return {
    name: "search_find_similar",
    label: "Find Similar Pages",
    description:
      `Find web pages similar to a given URL via ${provider.name}. Useful for finding alternatives, ` +
      "competitors, or related resources. Example: pass a GitHub repo URL to find similar projects.",
    parameters: FindSimilarSchema,
    async execute(_id, params, signal) {
      if (!provider.findSimilar) {
        return err(`Error: provider '${provider.name}' does not support findSimilar`);
      }
      try {
        const results = await provider.findSimilar(params.url, {
          numResults: params.numResults,
          includeText: params.includeContent ?? false,
          excludeDomains: params.excludeDomains,
          signal,
        });
        const header = `Found ${results.length} page(s) similar to: ${params.url}`;
        return ok(`${header}\n\n${formatResults(results)}`, {
          provider: provider.name,
          url: params.url,
          count: results.length,
        });
      } catch (e: any) {
        return err(`Error: find similar failed (${provider.name}) — ${e.message}`);
      }
    },
  };
}

// ─── Factory ───

export type SearchToolName = "search_web" | "search_find_similar";

export const ALL_SEARCH_TOOL_NAMES: readonly SearchToolName[] = ["search_web", "search_find_similar"];

/**
 * Create web search tools backed by a SearchProvider.
 *
 * `search_find_similar` is only registered when the provider supports
 * it (i.e. exposes the optional `findSimilar` method).
 */
export function createSearchTools(
  provider: SearchProvider,
  allowedTools?: string[],
): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [createSearchWebTool(provider)];
  if (provider.findSimilar) {
    tools.push(createFindSimilarTool(provider));
  }

  if (!allowedTools) return tools;
  const allowed = new Set(allowedTools.map(a => a.toLowerCase()));
  return tools.filter(t => allowed.has(t.name));
}
