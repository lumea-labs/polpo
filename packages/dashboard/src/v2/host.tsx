"use client";

import {
  useMemo,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import { usePolpo } from "@polpo-ai/react";
import { ProviderIcon } from "@lobehub/icons";
import { useQueryClient as useTanStackQueryClient } from "@tanstack/react-query";
import { useDashboardHost } from "../host.js";
export { PolpoChat } from "./agents/self-host-run-chat.js";

export {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
export { ProviderIcon };
export {
  BASELINE_TOOLS,
  CATALOG_TOOL_NAMES,
  TOOL_CATALOG,
  countEnabledTools,
  isToolEnabled,
  type CatalogGroup,
  type CatalogTool,
} from "./support/tool-catalog.js";
export {
  TYPE_FIELDS,
  TYPE_OPTIONS,
  buildCredentials,
  typeLabel,
  type VaultType,
} from "./support/vault-fields.js";
export {
  CALL_LANGS,
  buildCallSnippets,
  tenantBase,
  type CallLang,
} from "./support/agent-call-snippets.js";

export const DASHBOARD_API_URL = "";

export const AGENT_TAB_TO_SUB: Record<string, string> = {
  models: "models",
  prompt: "instructions",
  instructions: "instructions",
  tools: "tools",
  skills: "skills",
  memory: "memory",
  vault: "permissions",
  permissions: "permissions",
  loops: "loops",
  settings: "settings",
};

export const V2_FLAGS = {
  showTeams: false,
  showAvatars: false,
  showConnections: false,
} as const;

export function usePolpoClient(_projectId?: string) {
  return usePolpo().client;
}

export function Link({
  href,
  onClick,
  children,
  ...props
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ReactNode;
}) {
  const host = useDashboardHost();
  const resolved = host.href?.(href) ?? href;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      props.target === "_blank"
    ) {
      return;
    }
    event.preventDefault();
    host.navigate(href);
  };
  return (
    <a {...props} href={resolved} onClick={handleClick}>
      {children}
    </a>
  );
}

export function useRouter() {
  const host = useDashboardHost();
  const queryClient = useTanStackQueryClient();
  return useMemo(
    () => ({
      push: (href: string) => host.navigate(href),
      replace: (href: string) => {
        const resolved = host.href?.(href) ?? href;
        window.history.replaceState(null, "", resolved);
        window.dispatchEvent(new PopStateEvent("popstate"));
      },
      refresh: () => {
        void queryClient.invalidateQueries();
      },
      back: () => window.history.back(),
      forward: () => window.history.forward(),
    }),
    [host, queryClient],
  );
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(
    typeof window === "undefined" ? "" : window.location.search,
  );
}

export function useParams<T extends Record<string, string>>(): T {
  const host = useDashboardHost();
  const path = typeof window === "undefined" ? "" : window.location.pathname;
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const detailIndex = parts.findIndex(
    (part) => part === "agents" || part === "skills",
  );
  return {
    id: host.project.id,
    name: detailIndex >= 0 ? parts[detailIndex + 1] ?? "" : "",
  } as unknown as T;
}

export function announceNavigationStart(_label: string, _href: string): void {}

export function Markdown({ content }: { content: string }) {
  return <ReactMarkdown>{content}</ReactMarkdown>;
}

export function useCopilot() {
  const host = useDashboardHost();
  return {
    openChat: ({
      name,
      prompt,
    }: {
      kind?: string;
      name?: string;
      prompt?: string;
    }) => {
      if (prompt) {
        try {
          window.sessionStorage.setItem("polpo:playground-seed", prompt);
        } catch {}
      }
      const query = name ? `?agent=${encodeURIComponent(name)}` : "";
      host.navigate(`/projects/${host.project.id}/playground${query}`);
    },
  };
}

function runtimePath(path: string): string {
  return `/api/polpo/${path.replace(/^\/v1\/?/, "")}`;
}

export function runtimeUrl(path: string): string {
  return runtimePath(path);
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

export function fetchDataPlane<T>(_projectId: string, path: string): Promise<T> {
  if (/^\/v1\/loop-runs(?:\?|$)/.test(path)) {
    return Promise.resolve({ ok: true, data: [] } as T);
  }
  return runtimeFetch<T>(path);
}

export function mutateDataPlane<T>(
  _projectId: string,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  return runtimeFetch<T>(path, init);
}

export async function fetchControlPlane<T>(path: string): Promise<T> {
  if (/^\/v1\/projects\/[^/]+$/.test(path)) {
    return { slug: "local", orgId: "local" } as T;
  }
  const tools = path.match(/^\/v1\/projects\/[^/]+\/tools(\/.*)?$/);
  if (tools) {
    return runtimeFetch<T>(`/v1/tools${tools[1] ?? ""}`);
  }
  throw new Error(`Control-plane route is unavailable in self-hosted mode: ${path}`);
}

export async function mutateControlPlane<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const tools = path.match(/^\/v1\/projects\/[^/]+\/tools(\/.*)?$/);
  if (tools) {
    return runtimeFetch<T>(`/v1/tools${tools[1] ?? ""}`, init);
  }
  throw new Error(`Control-plane mutation is unavailable in self-hosted mode: ${path}`);
}

export function decodeTextEntities(value: string): string {
  if (!value.includes("&")) return value;
  let decoded = value;
  for (let index = 0; index < 2; index += 1) {
    const next = decoded
      .replace(/&#(\d+);/g, (match, code: string) =>
        charFromCodePoint(Number(code), match),
      )
      .replace(/&#x([0-9a-f]+);/gi, (match, code: string) =>
        charFromCodePoint(Number.parseInt(code, 16), match),
      )
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function charFromCodePoint(codePoint: number, fallback: string): string {
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff
  ) {
    return fallback;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}
