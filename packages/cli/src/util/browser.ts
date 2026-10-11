/**
 * Cross-platform browser opener.
 *
 * Uses the platform-specific command to open a URL:
 *   macOS   → open
 *   Windows → URL protocol handler
 *   Linux   → xdg-open
 *
 * Fire-and-forget: does not wait for the command to complete and swallows errors.
 * Callers should always print the URL as a fallback so users can copy-paste if
 * the browser doesn't open (headless/ssh/WSL cases).
 */
export async function openBrowser(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    const { platform } = await import("node:os");
    const { spawn } = await import("node:child_process");
    const os = platform();
    const command = os === "darwin" ? "open" : os === "win32" ? "rundll32.exe" : "xdg-open";
    const args = os === "win32" ? ["url.dll,FileProtocolHandler", parsed.href] : [parsed.href];
    // URLs may contain shell metacharacters; they must remain a single argument.
    const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => {});
    child.unref();
  } catch {
    // The caller prints the URL as a fallback for unavailable desktop openers.
  }
}
