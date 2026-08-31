import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAgentMcpTools, type McpServerSpec } from "../mcp-client.js";

/**
 * These tests cover the wiring around the AI SDK MCP client (vault
 * templating, host allowlist, namespacing, dispose) by mocking the
 * client itself. We do NOT spin up a real MCP server here — that's
 * an integration concern. The unit-level invariants we lock in are:
 *
 *  - `${vault:service:key}` is replaced with the resolved credential.
 *  - A missing vault credential throws a clean, named error.
 *  - Tools are namespaced `mcp__<server>__<tool>` so collisions across
 *    servers are impossible.
 *  - One bad server doesn't take down the whole resolve — the rest
 *    of the agent's MCPs still come up.
 *  - `dispose()` closes every transport that was successfully opened.
 *  - `POLPO_MCP_ALLOWED_HOSTS` rejects off-list hosts before any
 *    network I/O.
 */

const closeMock = vi.fn(async () => {});
const toolsMock = vi.fn(async () => ({
  ping: {
    description: "ping the server",
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(async () => "pong"),
  },
  echo: {
    description: "echo back",
    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
    execute: vi.fn(async (args: any) => `echo:${args.msg}`),
  },
}));
const createClientMock: any = vi.fn(async () => ({
  tools: toolsMock,
  close: closeMock,
}));

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: (arg: unknown) => createClientMock(arg),
}));
vi.mock("@ai-sdk/mcp/mcp-stdio", () => ({
  Experimental_StdioMCPTransport: class {
    constructor(public spec: unknown) {}
  },
}));

const fakeVault = {
  getKey(service: string, key: string) {
    if (service === "polpo" && key === "api_key") return "secret-123";
    return undefined;
  },
};

describe("resolveAgentMcpTools", () => {
  beforeEach(() => {
    closeMock.mockClear();
    toolsMock.mockClear();
    createClientMock.mockClear();
    delete process.env.POLPO_MCP_ALLOWED_HOSTS;
  });
  afterEach(() => {
    delete process.env.POLPO_MCP_ALLOWED_HOSTS;
  });

  it("returns empty + no-op dispose when the agent declares no servers", async () => {
    const result = await resolveAgentMcpTools("agent-1", undefined, undefined);
    expect(result.tools).toEqual([]);
    await expect(result.dispose()).resolves.toBeUndefined();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("namespaces tools as mcp__<server>__<tool>", async () => {
    const servers: Record<string, McpServerSpec> = {
      polpo: { type: "http", url: "https://api.polpo.sh/mcp" },
    };
    const result = await resolveAgentMcpTools("orchestrator", servers, undefined);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["mcp__polpo__echo", "mcp__polpo__ping"]);
  });

  it("templates ${vault:service:key} into header values", async () => {
    const servers: Record<string, McpServerSpec> = {
      polpo: {
        type: "http",
        url: "https://api.polpo.sh/mcp",
        headers: { Authorization: "Bearer ${vault:polpo:api_key}" },
      },
    };
    await resolveAgentMcpTools("agent-1", servers, fakeVault);
    const call = (createClientMock as any).mock.calls[0]?.[0] as any;
    expect(call.transport.headers.Authorization).toBe("Bearer secret-123");
  });

  it("passes host-owned OAuth providers to HTTP transports without serializing credentials", async () => {
    const oauthProvider = {
      tokens: vi.fn(async () => ({ access_token: "access-1", token_type: "Bearer" })),
      saveTokens: vi.fn(async () => {}),
      redirectToAuthorization: vi.fn(async () => {}),
      saveCodeVerifier: vi.fn(async () => {}),
      codeVerifier: vi.fn(async () => "verifier"),
      redirectUrl: "https://app.example/connect/oauth/callback",
      clientMetadata: {
        client_name: "Polpo",
        redirect_uris: ["https://app.example/connect/oauth/callback"],
      },
      clientInformation: vi.fn(async () => ({ client_id: "client-1" })),
    };
    const servers: Record<string, McpServerSpec> = {
      linear: { type: "http", url: "https://mcp.linear.app/mcp", connectionId: "conn_linear" },
    };

    await resolveAgentMcpTools("agent-1", servers, undefined, { linear: oauthProvider });

    const call = createClientMock.mock.calls[0]?.[0] as any;
    expect(call.transport.authProvider).toBe(oauthProvider);
    expect(call.transport).not.toHaveProperty("connectionId");
    expect(servers.linear).not.toHaveProperty("authProvider");
    expect(JSON.stringify(servers)).not.toContain("access-1");
  });

  it("rejects runtime OAuth providers for stdio transports", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const servers: Record<string, McpServerSpec> = {
      local: { type: "stdio", command: "node", args: ["server.js"] },
    };

    const result = await resolveAgentMcpTools("agent-1", servers, undefined, {
      local: {} as any,
    });

    expect(result.tools).toEqual([]);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(errSpy.mock.calls[0]?.[1]).toContain("only supported for HTTP or SSE");
    errSpy.mockRestore();
  });

  it("errors clearly when a vault placeholder cannot be resolved", async () => {
    // We swallow per-server errors and log them, so the resolve still
    // succeeds with an empty tool array — the agent simply doesn't get
    // tools from the broken server.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const servers: Record<string, McpServerSpec> = {
      bad: {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer ${vault:nonexistent:key}" },
      },
    };
    const result = await resolveAgentMcpTools("agent-1", servers, fakeVault);
    expect(result.tools).toEqual([]);
    expect(errSpy.mock.calls[0]?.[1]).toContain('Vault credential "nonexistent:key"');
    errSpy.mockRestore();
  });

  it("isolates failures — one broken server doesn't kill the rest", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // First call throws, second succeeds.
    createClientMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ tools: toolsMock, close: closeMock } as any);
    const servers: Record<string, McpServerSpec> = {
      broken: { type: "http", url: "https://broken.example.com/mcp" },
      working: { type: "http", url: "https://working.example.com/mcp" },
    };
    const result = await resolveAgentMcpTools("agent-1", servers, undefined);
    expect(result.tools.map((t) => t.name)).toEqual([
      "mcp__working__ping",
      "mcp__working__echo",
    ]);
    errSpy.mockRestore();
  });

  it("dispose closes every successfully-opened transport", async () => {
    const servers: Record<string, McpServerSpec> = {
      a: { type: "http", url: "https://a.example.com/mcp" },
      b: { type: "http", url: "https://b.example.com/mcp" },
    };
    const result = await resolveAgentMcpTools("agent-1", servers, undefined);
    await result.dispose();
    expect(closeMock).toHaveBeenCalledTimes(2);
  });

  it("rejects HTTP servers outside POLPO_MCP_ALLOWED_HOSTS", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.POLPO_MCP_ALLOWED_HOSTS = "*.polpo.sh,internal.example.com";
    const servers: Record<string, McpServerSpec> = {
      external: { type: "http", url: "https://attacker.example.com/mcp" },
      ok: { type: "http", url: "https://api.polpo.sh/mcp" },
    };
    const result = await resolveAgentMcpTools("agent-1", servers, undefined);
    expect(result.tools.map((t) => t.name)).toEqual([
      "mcp__ok__ping",
      "mcp__ok__echo",
    ]);
    expect(errSpy.mock.calls[0]?.[1]).toContain("not in POLPO_MCP_ALLOWED_HOSTS");
    errSpy.mockRestore();
  });

  it("adapts MCP execute to Polpo's ToolResult shape (text content)", async () => {
    const servers: Record<string, McpServerSpec> = {
      polpo: { type: "http", url: "https://api.polpo.sh/mcp" },
    };
    const { tools } = await resolveAgentMcpTools("agent-1", servers, undefined);
    const echo = tools.find((t) => t.name === "mcp__polpo__echo")!;
    expect(echo.requiresSandbox).toBe(false);
    const result = await echo.execute("call-1", { msg: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
  });
});
