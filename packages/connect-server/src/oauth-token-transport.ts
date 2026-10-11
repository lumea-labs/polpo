import { ConnectError, connectorHostnameIsUnsafe } from "@polpo-ai/connect";
import { toFormBody } from "./oauth.js";

export interface ProviderTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface TokenTransportOptions {
  fetch: typeof fetch;
  resolveHostname: (hostname: string) => Promise<readonly string[]>;
  timeoutMs?: number;
  requireJsonContentType?: boolean;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
function failed(category: string, status?: number): ConnectError {
  return new ConnectError("token_exchange_failed", "OAuth token exchange failed", {
    details: { category, ...(status === undefined ? {} : { providerStatus: status }) },
  });
}

/** The same bounded transport is used for code exchange and refresh. No error contains a provider body. */
export async function requestOAuthToken(
  options: TokenTransportOptions,
  tokenUrl: string,
  body: Record<string, string | undefined>,
): Promise<ProviderTokenResponse> {
  return normalizeResponse(await requestOAuthJson(options, tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: toFormBody(body),
  }, failed));
}

/** Bounded server-to-provider transport shared by token exchange and account identity checks. */
export async function requestOAuthJson(
  options: TokenTransportOptions,
  tokenUrl: string,
  request: Pick<RequestInit, "method" | "headers" | "body">,
  errorFactory: (category: string, status?: number) => ConnectError,
): Promise<unknown> {
  const failed = errorFactory;
  let url: URL;
  try { url = new URL(tokenUrl); } catch { throw failed("invalid_endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || connectorHostnameIsUnsafe(url.hostname)) {
    throw failed("network_denied");
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(failed("timeout"));
    }, options.timeoutMs ?? 10_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const addresses = await options.resolveHostname(url.hostname);
      if (controller.signal.aborted) throw failed("timeout");
      if (!addresses.length || addresses.some(connectorHostnameIsUnsafe)) throw failed("network_denied");
      const response = await options.fetch(url, {
        ...request, redirect: "error", signal: controller.signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw failed("provider_rejected", response.status);
      }
      if (options.requireJsonContentType && response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        void response.body?.cancel().catch(() => undefined);
        throw failed("invalid_response");
      }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw failed("response_too_large");
      }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw failed("timeout");
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) throw failed("timeout");
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw failed("response_too_large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw failed("invalid_response"); }
      return value;
    })()]);
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw failed(controller.signal.aborted ? "timeout" : "transport_failed");
  } finally {
    clearTimeout(timer!);
  }
}

function normalizeResponse(value: unknown): ProviderTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed("invalid_response");
  const input = value as Record<string, unknown>;
  for (const key of ["access_token", "refresh_token"] as const) {
    if (key === "refresh_token" && input[key] === undefined) continue;
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 65_536 || /[\r\n]/.test(input[key])) {
      throw failed("invalid_response");
    }
  }
  if (input.token_type !== undefined && (typeof input.token_type !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(input.token_type))) {
    throw failed("invalid_response");
  }
  if (input.scope !== undefined && (typeof input.scope !== "string" || input.scope.length > 32_768)) throw failed("invalid_response");
  if (input.expires_in !== undefined && (typeof input.expires_in !== "number" || !Number.isSafeInteger(input.expires_in)
    || input.expires_in < 0 || input.expires_in > 1_000_000_000)) throw failed("invalid_response");
  return {
    access_token: input.access_token as string,
    ...(input.refresh_token === undefined ? {} : { refresh_token: input.refresh_token as string }),
    ...(input.token_type === undefined ? {} : { token_type: input.token_type as string }),
    ...(input.scope === undefined ? {} : { scope: input.scope as string }),
    ...(input.expires_in === undefined ? {} : { expires_in: input.expires_in as number }),
  };
}
