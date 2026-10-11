import { ConnectError, connectorHostnameIsUnsafe } from "@polpo-ai/connect";

/** Browser callback only. Resource/metadata/provider endpoints keep their own
 * HTTPS and network policies. The host still owns and allowlists this URI. */
export function normalizeMcpOAuthRedirect(value: string): string {
  const invalid = () => new ConnectError("invalid_request", "MCP OAuth callback must use public HTTPS or a loopback address, without credentials or fragments");
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const loopback = url.hostname === "localhost" || url.hostname.endsWith(".localhost")
    || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.hash
    || (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || (!loopback && connectorHostnameIsUnsafe(url.hostname))) throw invalid();
  for (const key of url.searchParams.keys()) {
    if (/^(access_token|refresh_token|client_secret|api[_-]?key|authorization|password|token|secret|code|state)$/i.test(key)) throw invalid();
  }
  return url.toString();
}
