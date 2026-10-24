/**
 * http_fetch / http_download hardening: SSRF on redirects, DNS-pinned
 * connects, bounded bodies and an overall deadline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PolpoTool } from "@polpo-ai/core";
import { createHttpTools } from "../http-tools.js";
import { safeFetch, readBodyCapped } from "../safe-fetch.js";
import { assertUrlAllowed, blockedAddressReason } from "../ssrf-guard.js";

let cwd: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "polpo-http-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(cwd, { recursive: true, force: true });
});

function tool(name: "http_fetch" | "http_download"): PolpoTool<any> {
  return createHttpTools(cwd, [cwd], [name])[0];
}

function text(result: { content: Array<{ type: string } & Record<string, any>> }): string {
  return result.content[0].text;
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl as any);
  globalThis.fetch = fn as any;
  return fn;
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

/** A body that never ends. */
function endlessBody(onCancel?: () => void): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  return new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { onCancel?.(); },
  });
}

describe("http_fetch — redirects re-apply the SSRF guard", () => {
  it("refuses a redirect to the cloud metadata address and never requests it", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url.startsWith("https://public.example/")) return redirect(302, "http://169.254.169.254/latest/meta-data/");
      return new Response("SECRET-CREDENTIALS", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await tool("http_fetch").execute("c1", { url: "https://public.example/start" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(text(result)).not.toContain("SECRET-CREDENTIALS");
    expect(result.details).toMatchObject({ error: "ssrf_blocked" });
    expect(text(result)).toMatch(/169\.254\.169\.254/);
  });

  it("refuses redirects to private hosts, IPv4-mapped IPv6 and non-http schemes", async () => {
    for (const location of ["http://10.0.0.5/", "http://[::ffff:127.0.0.1]:8080/", "http://localhost./", "file:///etc/passwd"]) {
      const fetchMock = mockFetch(async () => redirect(307, location));
      const result = await tool("http_fetch").execute("c1", { url: "https://public.example/" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.details).toMatchObject({ error: "ssrf_blocked" });
    }
  });

  it("follows public redirects, rewrites 303 to GET and drops credentials across origins", async () => {
    const fetchMock = mockFetch(async (url) => {
      if (url === "https://a.example/submit") return redirect(303, "https://b.example/result");
      return new Response("done", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const result = await tool("http_fetch").execute("c1", {
      url: "https://a.example/submit",
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json", "X-Trace": "1" },
      body: "{}",
    });
    expect(text(result)).toContain("done");
    expect(result.details).toMatchObject({ status: 200, redirects: 1, finalUrl: "https://b.example/result" });
    const second = fetchMock.mock.calls[1];
    expect(second[0]).toBe("https://b.example/result");
    expect(second[1]).toMatchObject({ method: "GET", body: undefined, redirect: "manual" });
    expect((second[1] as RequestInit).headers).toEqual({ "X-Trace": "1" });
  });

  it("stops after the redirect limit", async () => {
    let n = 0;
    const fetchMock = mockFetch(async () => redirect(302, `https://loop.example/${++n}`));
    const result = await tool("http_fetch").execute("c1", { url: "https://loop.example/0" });
    expect(text(result)).toMatch(/too many redirects/i);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("http_fetch — bounded body and overall deadline", () => {
  it("stops reading an endless body at the cap and marks it truncated", { timeout: 10_000 }, async () => {
    let cancelled = false;
    mockFetch(async () => new Response(endlessBody(() => { cancelled = true; }), {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    const result = await tool("http_fetch").execute("c1", { url: "https://big.example/" });
    expect(text(result)).toMatch(/\[truncated — response body exceeded 100000 bytes\]/);
    expect(text(result).length).toBeLessThan(110_000);
    expect(result.details).toMatchObject({ truncated: true });
    expect(cancelled).toBe(true);
  });

  it("applies the timeout to the body read, not just to the headers", { timeout: 10_000 }, async () => {
    mockFetch(async (_url, init) => {
      // Headers arrive immediately, the body never does. Mirror real fetch:
      // aborting the request errors the body stream.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
    });
    const t0 = Date.now();
    const result = await tool("http_fetch").execute("c1", { url: "https://slow.example/", timeout: 200 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(text(result)).toMatch(/timed out after 200ms/);
  });

  it("treats timeout 0 / negative as the default instead of an instant abort", async () => {
    mockFetch(async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));
    for (const timeout of [0, -1]) {
      const result = await tool("http_fetch").execute("c1", { url: "https://ok.example/", timeout });
      expect(text(result)).toContain("ok");
    }
  });

  it("http_download reapplies the SSRF guard on redirects", async () => {
    mockFetch(async () => redirect(301, "http://192.168.1.1/router.cfg"));
    const result = await tool("http_download").execute("c1", { url: "https://files.example/x", path: "x.bin" });
    expect(result.details).toMatchObject({ error: "ssrf_blocked" });
    expect(existsSync(join(cwd, "x.bin"))).toBe(false);
  });
});

describe("safeFetch — DNS answers are validated at connect time", () => {
  let server: Server;
  let port: number;
  let hits: number;

  beforeEach(async () => {
    hits = 0;
    server = createServer((_req, res) => { hits++; res.end("internal-only"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a public-looking hostname that resolves to loopback (DNS rebinding)", async () => {
    const controller = new AbortController();
    const resolveHostname = async () => ["127.0.0.1"];
    // The URL itself passes the static guard…
    expect(() => assertUrlAllowed(`http://rebind.example:${port}/`)).not.toThrow();
    // …but the connection is refused once DNS answers are inspected.
    await expect(
      safeFetch(`http://rebind.example:${port}/`, { signal: controller.signal, resolveHostname }),
    ).rejects.toSatisfy((err: any) => /SSRF blocked/.test(`${err?.message} ${err?.cause?.message}`));
    expect(hits).toBe(0);
  });

  it("refuses when any of the answers is private", async () => {
    const controller = new AbortController();
    const resolveHostname = async () => ["93.184.216.34", "10.1.2.3"];
    await expect(
      safeFetch(`http://mixed.example:${port}/`, { signal: controller.signal, resolveHostname }),
    ).rejects.toSatisfy((err: any) => /10\.1\.2\.3/.test(`${err?.message} ${err?.cause?.message}`));
    expect(hits).toBe(0);
  });
});

describe("ssrf guard — address classification", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "0.1.2.3", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe",
  ])("blocks %s", (address) => {
    expect(blockedAddressReason(address)).toBeTruthy();
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700::1111", "172.32.0.1"])("allows %s", (address) => {
    expect(blockedAddressReason(address)).toBeUndefined();
  });

  it("blocks URL literals that the old guard let through", () => {
    for (const url of ["http://[::ffff:127.0.0.1]/", "http://[fd12::1]/", "http://100.64.1.1/", "http://localhost./", "http://app.localhost/"]) {
      expect(() => assertUrlAllowed(url)).toThrow(/SSRF blocked/);
    }
  });
});

describe("readBodyCapped", () => {
  it("returns the full body under the cap", async () => {
    const { bytes, truncated } = await readBodyCapped(new Response("hello"), 10);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(truncated).toBe(false);
  });
});
