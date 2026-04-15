/**
 * Translate raw API error messages to actionable CLI hints.
 */
export function friendlyError(msg: string): string {
  if (msg.includes("Multiple projects found")) return "Multiple projects found. Run: polpo projects set";
  if (/HTTP 401|Unauthorized/i.test(msg)) return "Session expired or invalid. Run: polpo login";
  if (/HTTP 403|Forbidden/i.test(msg)) return "Access denied. Check your credentials or project permissions.";
  return msg;
}
