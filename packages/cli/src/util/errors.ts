/**
 * Translate raw API / network error messages into actionable CLI hints.
 *
 * Order matters: more specific patterns first. Falls through to the original
 * message when nothing matches, so we never lose information.
 *
 * Accepts `unknown` because callers pull `error` straight off API response
 * bodies and that field can be a string, a Zod issue array, an object, or
 * undefined. We normalize defensively here so a malformed 4xx body can't
 * crash the deploy with `msg.includes is not a function`.
 */
export function friendlyError(input: unknown): string {
  const msg = normalizeToString(input);
  if (msg.includes("Multiple projects found")) return "Multiple projects found. Run: polpo projects set";
  if (/HTTP 401|Unauthorized/i.test(msg)) return "Session expired or invalid. Run: polpo login";
  if (/HTTP 403|Forbidden/i.test(msg)) return "Access denied. Check your credentials or project permissions.";
  if (/HTTP 404|Not Found/i.test(msg)) return "Resource not found.";
  if (/HTTP 409|Conflict/i.test(msg)) return "Conflict — resource already exists.";
  if (/HTTP 429|rate.?limit/i.test(msg)) return "Rate limited. Wait a moment and retry.";
  if (/HTTP 5\d\d|Service Unavailable|Bad Gateway|Internal Server Error/i.test(msg)) {
    return "Polpo Cloud is having issues. Check status.polpo.sh or retry shortly.";
  }
  if (
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|Could not reach/i.test(msg)
  ) {
    return "Could not reach the Polpo API. Check your network or run: polpo whoami";
  }
  return msg;
}

/**
 * Coerce any value to a short, human-readable string suitable for an error
 * message. Strings pass through. Objects/arrays JSON.stringify, with a safe
 * fallback when stringify throws (e.g. circular refs).
 */
function normalizeToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Network error thrown by the API client when fetch() itself fails (DNS,
 * TCP refused, TLS handshake, timeout). Carries the host so callers can
 * print "Could not reach https://api.polpo.sh".
 */
export class ApiNetworkError extends Error {
  constructor(public readonly baseUrl: string, cause: unknown) {
    super(`Could not reach ${baseUrl}: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "ApiNetworkError";
    this.cause = cause;
  }
}
