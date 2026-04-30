/**
 * SearchProvider — port for web-search tool backends.
 *
 * Same Ports & Adapters pattern as `FileSystem` and `Shell`:
 * `@polpo-ai/core` defines the interface, concrete adapters live in
 * `@polpo-ai/tools` (Exa today; Tavily / Perplexity / SearXNG / etc as
 * the catalog grows). The `search_web` and `search_find_similar` tools
 * are agnostic — they receive a SearchProvider and call its methods.
 *
 * The cloud shell can swap in a Gateway-routed adapter without
 * touching the tool layer.
 */

export interface SearchResult {
  /** Page title (best-effort — providers vary). */
  title: string;
  /** Canonical URL. */
  url: string;
  /** Snippet / excerpt of the page content. */
  text?: string;
  /** ISO date string (YYYY-MM-DD or full ISO) when available. */
  publishedDate?: string;
  /** Provider-specific relevance score, normalized 0-1 when possible. */
  score?: number;
}

export interface SearchOptions {
  /** Number of results to return. Provider may clamp. */
  numResults?: number;
  /** Restrict results to these domains. */
  includeDomains?: string[];
  /** Exclude results from these domains. */
  excludeDomains?: string[];
  /** Only return results published after this ISO date. */
  startPublishedDate?: string;
  /** Only return results published before this ISO date. */
  endPublishedDate?: string;
  /** Whether to include extracted text content in each result. */
  includeText?: boolean;
  /** Cancel the in-flight request. */
  signal?: AbortSignal;
}

export interface SearchProvider {
  /** Provider name, used for logging and result attribution. */
  readonly name: string;

  /** Run a free-text web search. */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;

  /**
   * Find pages semantically similar to a given URL. Optional — only
   * some providers support this (today: only Exa). Tools register
   * `search_find_similar` only when this method is present.
   */
  findSimilar?(url: string, options?: SearchOptions): Promise<SearchResult[]>;
}
