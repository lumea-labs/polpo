import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ platform: "linux", spawn: vi.fn(), exec: vi.fn(), once: vi.fn(), unref: vi.fn() }));
vi.mock("node:os", () => ({ platform: () => mocks.platform }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, exec: mocks.exec }));
import { openBrowser } from "../src/util/browser.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spawn.mockReturnValue({ once: mocks.once, unref: mocks.unref });
});

describe("browser opener", () => {
  it.each([
    ["linux", "xdg-open", []], ["darwin", "open", []], ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler"]],
  ])("passes metacharacters as one URL argument on %s", async (platform, executable, prefix) => {
    mocks.platform = platform as string;
    const url = "https://$(id).example/path?query=`not-a-command`&next=value";
    await openBrowser(url);
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledWith(executable, [...prefix as string[], new URL(url).href],
      { shell: false, detached: true, stdio: "ignore", windowsHide: true });
    expect(mocks.once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(mocks.unref).toHaveBeenCalledOnce();
  });
  it.each(["javascript:alert(1)", "file:///tmp/app", "--help", "not a URL"])("does not open an unsupported URL: %s", async url => {
    await openBrowser(url);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("leaves the printed fallback usable when launching fails", async () => {
    mocks.spawn.mockImplementation(() => { throw new Error("No graphical session"); });
    await expect(openBrowser("https://polpo.sh")).resolves.toBeUndefined();
  });
});
