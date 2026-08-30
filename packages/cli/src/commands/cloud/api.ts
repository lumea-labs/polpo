/**
 * HTTP client for the Polpo Cloud API.
 *
 * Wraps fetch with Authorization header, JSON handling, and a typed
 * network error so callers can surface "Could not reach api.polpo.sh"
 * instead of a raw `TypeError: fetch failed`.
 */
import type { Credentials } from "./config.js";
import { ApiNetworkError } from "../../util/errors.js";

const protectedHeaders = new Set([
  "authorization",
  "content-type",
  "x-project-id",
]);

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

export interface ApiRequestOptions {
  /** Request context only. Authentication and project headers cannot be overridden. */
  headers?: Readonly<Record<string, string>>;
}

export interface ApiClient {
  get<T = unknown>(path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResponse<T>>;
  put<T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<ApiResponse<T>>;
  delete<T = unknown>(path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>>;
}

export function createApiClient(credentials: Credentials, projectId?: string): ApiClient {
  const { apiKey, baseUrl } = credentials;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(projectId ? { "x-project-id": projectId } : {}),
  };

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const contextHeaders = Object.fromEntries(
      Object.entries(options?.headers ?? {}).filter(
        ([name]) => !protectedHeaders.has(name.toLowerCase()),
      ),
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...contextHeaders,
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // fetch() throws on DNS / TCP / TLS / abort failures. Wrap so callers
      // (and friendlyError) can produce a useful "check your network" hint.
      throw new ApiNetworkError(baseUrl, err);
    }

    let data: T;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      data = (await res.json()) as T;
    } else {
      data = (await res.text()) as unknown as T;
    }

    return { status: res.status, data };
  }

  return {
    get: <T = unknown>(path: string, options?: ApiRequestOptions) =>
      request<T>("GET", path, undefined, options),
    post: <T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions) =>
      request<T>("POST", path, body, options),
    put: <T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions) =>
      request<T>("PUT", path, body, options),
    patch: <T = unknown>(path: string, body?: unknown, options?: ApiRequestOptions) =>
      request<T>("PATCH", path, body, options),
    delete: <T = unknown>(path: string, options?: ApiRequestOptions) =>
      request<T>("DELETE", path, undefined, options),
  };
}
