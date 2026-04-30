/**
 * ExaSearchProvider — SearchProvider adapter backed by the Exa REST API.
 *
 * Direct fetch to api.exa.ai. Implements both `search` and the optional
 * `findSimilar` (Exa is currently the only provider that supports
 * URL-similarity in our catalog). Credentials resolved from the agent
 * vault (service "exa", key "key") with EXA_API_KEY env var fallback.
 *
 * Cancellation: we wire `signal` into a per-call AbortController so a
 * 15s timeout fires alongside the caller's own abort.
 */

import type { SearchProvider, SearchResult, SearchOptions } from "@polpo-ai/core";

const EXA_BASE = "https://api.exa.ai";
const DEFAULT_TIMEOUT_MS = 15_000;

interface ExaRawResult {
  title?: string;
  url: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaResponse {
  results?: ExaRawResult[];
}

export interface ExaSearchProviderOptions {
  apiKey: string;
  /** Override the base URL (e.g. for a local proxy). Defaults to https://api.exa.ai */
  baseUrl?: string;
}

export class ExaSearchProvider implements SearchProvider {
  readonly name = "exa" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: ExaSearchProviderOptions) {
    if (!opts.apiKey) {
      throw new Error("ExaSearchProvider: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? EXA_BASE;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      query,
      numResults: Math.min(options.numResults ?? 5, 20),
      type: "auto",
    };
    if (options.includeText !== false) {
      // Default-on content extraction matches the old tool behavior;
      // callers that don't want bytes pass `includeText: false`.
      body.contents = {
        text: { maxCharacters: 2000 },
        highlights: { numSentences: 3 },
        summary: { query },
      };
    }
    if (options.includeDomains?.length) body.includeDomains = options.includeDomains;
    if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;
    if (options.startPublishedDate) body.startPublishedDate = options.startPublishedDate;
    if (options.endPublishedDate) body.endPublishedDate = options.endPublishedDate;

    const data = await this.post<ExaResponse>("/search", body, options.signal);
    return (data.results ?? []).map(toSearchResult);
  }

  async findSimilar(url: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const body: Record<string, unknown> = {
      url,
      numResults: Math.min(options.numResults ?? 5, 20),
    };
    if (options.includeText) {
      body.contents = {
        text: { maxCharacters: 2000 },
        highlights: { numSentences: 3 },
      };
    }
    if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;

    const data = await this.post<ExaResponse>("/findSimilar", body, options.signal);
    return (data.results ?? []).map(toSearchResult);
  }

  private async post<T>(path: string, body: unknown, callerSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    if (callerSignal) {
      callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Exa API ${response.status}: ${errText}`);
      }
      return (await response.json()) as T;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("Exa request aborted (timeout or caller cancelled)");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toSearchResult(r: ExaRawResult): SearchResult {
  return {
    title: r.title ?? "",
    url: r.url,
    text: r.summary || r.text || (r.highlights ?? []).join(" • ") || undefined,
    publishedDate: r.publishedDate,
    score: r.score,
  };
}
