import { describe, expect, it, vi } from "vitest";
import { requestOAuthToken } from "../oauth-token-transport.js";

function harness(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  const resolveHostname = vi.fn(async () => ["8.8.8.8"]);
  return { fetch, resolveHostname };
}
const endpoint = "https://auth.example/token";
const payload = { grant_type: "authorization_code", code: "private-code", client_secret: "private-secret" };

describe("OAuth token transport", () => {
  it("uses a bounded non-redirecting form exchange", async () => {
    const options = harness(Response.json({ access_token: "access", scope: "read", expires_in: 3600 }));
    expect(await requestOAuthToken(options, endpoint, payload)).toEqual({ access_token: "access", scope: "read", expires_in: 3600 });
    expect(options.resolveHostname).toHaveBeenCalledWith("auth.example");
    expect(options.fetch.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
  });

  it.each(["http://auth.example/token", "https://localhost/token", "https://127.0.0.1/token", "https://user:pass@auth.example/token"])("denies unsafe endpoint %s before sending secrets", async (url) => {
    const options = harness(Response.json({ access_token: "access" }));
    await expect(requestOAuthToken(options, url, payload)).rejects.toMatchObject({ code: "token_exchange_failed" });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("denies a hostname that resolves to a private address", async () => {
    const options = harness(Response.json({ access_token: "access" }));
    options.resolveHostname.mockResolvedValue(["8.8.8.8", "10.0.0.1"]);
    await expect(requestOAuthToken(options, endpoint, payload)).rejects.toMatchObject({ code: "token_exchange_failed" });
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it.each([
    new Response("private-secret", { status: 401 }),
    new Response("invalid JSON with private-secret", { status: 200 }),
    Response.json({ error: "private-secret", access_token: "" }),
    Response.json({ access_token: "access", expires_in: "unexpected" }),
    Response.json({ access_token: "access", scope: ["read"] }),
    new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
  ])("redacts malformed and failed provider responses", async (response) => {
    const error = await requestOAuthToken(harness(response), endpoint, payload).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "token_exchange_failed" });
    expect(JSON.stringify(error)).not.toContain("private-secret");
  });

  it("bounds streamed responses without trusting Content-Length", async () => {
    const options = harness(new Response("x".repeat(262_145)));
    await expect(requestOAuthToken(options, endpoint, payload)).rejects.toMatchObject({
      code: "token_exchange_failed", details: { category: "response_too_large" },
    });
  });

  it("times out a stalled body, not just response headers", async () => {
    const cancelled = vi.fn();
    const options = harness(new Response(new ReadableStream({ cancel: cancelled })));
    await expect(requestOAuthToken({ ...options, timeoutMs: 10 }, endpoint, payload)).rejects.toMatchObject({
      code: "token_exchange_failed", details: { category: "timeout" },
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("bounds DNS lookup time and does not send credentials after its deadline", async () => {
    const options = harness(Response.json({ access_token: "access" }));
    options.resolveHostname.mockImplementation(() => new Promise(() => {}));
    await expect(requestOAuthToken({ ...options, timeoutMs: 10 }, endpoint, payload)).rejects.toMatchObject({
      code: "token_exchange_failed", details: { category: "timeout" },
    });
    expect(options.fetch).not.toHaveBeenCalled();
  });
});
