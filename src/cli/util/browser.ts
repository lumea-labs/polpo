/**
 * Cross-platform browser opener.
 *
 * Uses the platform-specific command to open a URL:
 *   macOS   → open
 *   Windows → start
 *   Linux   → xdg-open
 *
 * Fire-and-forget: does not wait for the command to complete and swallows errors.
 * Callers should always print the URL as a fallback so users can copy-paste if
 * the browser doesn't open (headless/ssh/WSL cases).
 */
export async function openBrowser(url: string): Promise<void> {
  const { platform } = await import("node:os");
  const { exec } = await import("node:child_process");
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}
