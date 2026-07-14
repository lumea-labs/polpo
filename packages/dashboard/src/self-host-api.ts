import type { DashboardApi } from "./host.js";

function runtimePath(path: string): string {
  return `/api/polpo/${path.replace(/^\/v1\/?/, "")}`;
}

async function runtimeFetch<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(runtimePath(path), {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Data API error ${response.status}: ${detail}`);
  }
  return response.json() as Promise<T>;
}

export function createSelfHostedDashboardApi(): DashboardApi {
  return {
    fetchDataPlane<T>(_projectId: string, path: string): Promise<T> {
      if (/^\/v1\/loop-runs(?:\?|$)/.test(path)) {
        return Promise.resolve({ ok: true, data: [] } as T);
      }
      return runtimeFetch<T>(path);
    },
    mutateDataPlane<T>(
      _projectId: string,
      path: string,
      init: { method: string; body?: unknown },
    ): Promise<T> {
      return runtimeFetch<T>(path, init);
    },
    async fetchControlPlane<T>(path: string): Promise<T> {
      if (/^\/v1\/projects\/[^/]+$/.test(path)) {
        return { slug: "local", orgId: "local" } as T;
      }
      const tools = path.match(/^\/v1\/projects\/[^/]+\/tools(\/.*)?$/);
      if (tools) {
        return runtimeFetch<T>(`/v1/tools${tools[1] ?? ""}`);
      }
      throw new Error(
        `Control-plane route is unavailable in self-hosted mode: ${path}`,
      );
    },
    async mutateControlPlane<T>(
      path: string,
      init: { method: string; body?: unknown },
    ): Promise<T> {
      const tools = path.match(/^\/v1\/projects\/[^/]+\/tools(\/.*)?$/);
      if (tools) {
        return runtimeFetch<T>(`/v1/tools${tools[1] ?? ""}`, init);
      }
      throw new Error(
        `Control-plane mutation is unavailable in self-hosted mode: ${path}`,
      );
    },
    controlPlaneBaseUrl(): string {
      return "";
    },
    dataPlaneBaseUrl(_projectId: string): string {
      return "/api/polpo";
    },
    runtimeUrl(_projectId: string, path: string): string {
      return runtimePath(path);
    },
  };
}
