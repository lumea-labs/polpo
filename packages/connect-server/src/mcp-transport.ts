import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ConnectionSelectionError } from "@polpo-ai/core";
import { ConnectError, connectorHostnameIsUnsafe } from "@polpo-ai/connect";
import { publicNetworkFetch } from "./public-network.js";

export interface RemoteMcpTransportInput {
  url: string;
  transport?: "http" | "sse";
  /** Host-resolved credentials; never expose these as model tool arguments. */
  headers?: Record<string, string>;
  /** Host authorization and current credentials, rechecked before EVERY HTTP send. */
  authorize?: () => Promise<HeadersInit | undefined>;
  /** Host budget debit, after authorization and before each actual HTTP send. */
  beforeDispatch?: (input: { method: string }) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** An injected host transport must provide equivalent DNS/socket enforcement. */
  fetch?: typeof globalThis.fetch;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const failed = (category: string, providerStatus?: number) => new ConnectError("http_error", "MCP request failed", {
  details: { category, ...(providerStatus === undefined ? {} : { providerStatus }) },
});
const denied = () => new ConnectError("policy_denied", "MCP destination is not allowed");

/** Bounded native MCP lifecycle shared by verification and authorized execution. */
export async function withRemoteMcpClient<T>(input: RemoteMcpTransportInput,
  run: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
  let endpoint: URL;
  try { endpoint = new URL(input.url); } catch { throw denied(); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || connectorHostnameIsUnsafe(endpoint.hostname)) throw denied();
  const controller = new AbortController();
  const client = new Client({ name: "polpo-connect", version: "1" }, { capabilities: {} });
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  type SafeError = ConnectError | ConnectionSelectionError;
  const safeError = (error: unknown): SafeError => error instanceof ConnectError || error instanceof ConnectionSelectionError ? error : failed("transport_failed");
  let failure: SafeError | undefined;
  let rejectDeadline: (error: SafeError) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const stop = (error: SafeError) => {
    failure ??= error;
    rejectDeadline(failure);
    controller.abort();
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    void client.close().catch(() => undefined);
  };
  const abort = () => stop(failed("aborted"));
  const timeout = setTimeout(abort, Math.min(Math.max(input.timeoutMs ?? 30_000, 1), 30_000));
  input.signal?.addEventListener("abort", abort, { once: true });

  const fetchBounded: typeof fetch = async (resource, init) => {
    try {
      if (controller.signal.aborted) throw failure ?? failed("aborted");
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      // SSE can advertise a POST path, but it cannot redirect credentials to
      // another origin. The public transport pins DNS for the actual socket.
      if (url.origin !== endpoint.origin || url.username || url.password || url.hash
        || (input.transport !== "sse" && (url.pathname !== endpoint.pathname || url.search !== endpoint.search))) throw denied();
      const headers = new Headers(init?.headers);
      if (input.authorize) {
        const authorizedHeaders = new Headers(await input.authorize());
        authorizedHeaders.forEach((value, name) => headers.set(name, value));
      }
      if (controller.signal.aborted) throw failure ?? failed("aborted");
      await input.beforeDispatch?.({ method: init?.method ?? (resource instanceof Request ? resource.method : "GET") });
      if (controller.signal.aborted) throw failure ?? failed("aborted");
      const response = await (input.fetch ?? publicNetworkFetch)(resource, {
        ...init, headers, redirect: "error", signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw failure ?? failed("aborted");
      }
      // Streamable HTTP may reject its optional listening GET or session DELETE.
      if (!response.ok && !((init?.method === "GET" || init?.method === "DELETE") && response.status === 405)) {
        void response.body?.cancel().catch(() => undefined);
        throw failed("provider_rejected", response.status);
      }
      if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw failed("response_too_large");
      }
      if (!response.body) return response;
      const reader = response.body.getReader();
      readers.add(reader);
      let size = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(stream) {
          try {
            const { value, done } = await reader.read();
            if (cancelled) return;
            if (done) { readers.delete(reader); stream.close(); return; }
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) throw failed("response_too_large");
            stream.enqueue(value);
          } catch (error) {
            // The SDK cancels a Streamable HTTP SSE body once its response is
            // received. A pending pull must not turn that normal close into a
            // failure of the following tools/list request.
            if (cancelled || controller.signal.aborted) return;
            const safe = safeError(error);
            stream.error(safe);
            stop(safe);
          }
        },
        cancel() { cancelled = true; readers.delete(reader); return reader.cancel().catch(() => undefined); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      const safe = safeError(error);
      stop(safe);
      throw safe;
    }
  };
  const requestInit = { headers: input.authorize ? undefined : input.headers, redirect: "error" as const };
  const transport = input.transport === "sse"
    ? new SSEClientTransport(endpoint, { fetch: fetchBounded, requestInit })
    : new StreamableHTTPClientTransport(endpoint, { fetch: fetchBounded, requestInit,
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
  try {
    if (input.signal?.aborted) abort();
    return await Promise.race([deadline, (async () => {
      if (controller.signal.aborted) throw failure ?? failed("aborted");
      await client.connect(transport);
      return run(client, controller.signal);
    })()]);
  } catch (error) {
    throw failure ?? (error instanceof ConnectError || error instanceof ConnectionSelectionError ? error : failed("invalid_response"));
  } finally {
    // close() only tears down the local transport. A stateful HTTP server also
    // needs DELETE. Reauthorize it like every send, and never turn a completed
    // mutation into an apparent failure if remote cleanup is unavailable.
    if (transport instanceof StreamableHTTPClientTransport && transport.sessionId && !controller.signal.aborted) {
      let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          transport.terminateSession().catch(() => undefined),
          new Promise<void>(resolve => { cleanupTimeout = setTimeout(() => { controller.abort(); resolve(); }, 1000); }),
          deadline.catch(() => undefined),
        ]);
      } finally { clearTimeout(cleanupTimeout); }
    }
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
    controller.abort();
    for (const reader of readers) void reader.cancel().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}
