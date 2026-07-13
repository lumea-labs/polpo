import "server-only";

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:3890";
const REQUEST_HEADERS = ["accept", "content-type", "x-session-id", "x-request-id"] as const;
const RESPONSE_HEADERS = ["content-type", "cache-control", "x-session-id", "x-request-id"] as const;

function runtimeUrl() {
  return (process.env.POLPO_API_URL || DEFAULT_RUNTIME_URL).replace(/\/$/, "");
}

export async function proxyRuntime(request: Request, runtimePath: string) {
  const url = new URL(runtimePath, `${runtimeUrl()}/`);
  url.search = new URL(request.url).search;
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (process.env.POLPO_API_KEY) headers.set("authorization", `Bearer ${process.env.POLPO_API_KEY}`);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : request.body;

  try {
    const upstream = await fetch(url, {
      method,
      headers,
      body,
      duplex: body ? "half" : undefined,
      cache: "no-store",
      signal: request.signal,
    } as RequestInit & { duplex?: "half" });
    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Runtime unavailable";
    return Response.json({ ok: false, error: `Could not reach the Polpo runtime: ${message}` }, { status: 502 });
  }
}
