import { describe, it, expect, vi } from "vitest";
import type { ApiClient, ApiResponse } from "../../src/commands/cloud/api.js";
import { resolveDefaultOrg, type Org } from "../../src/util/org.js";

function mockClient(get: ReturnType<typeof vi.fn>): ApiClient {
  return {
    get,
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

function ok<T>(data: T): ApiResponse<T> {
  return { status: 200, data };
}

describe("resolveDefaultOrg", () => {
  it("returns the first org when the user has exactly one", async () => {
    const get = vi.fn().mockResolvedValue(ok([{ id: "o1", name: "Acme" }] as Org[]));
    const org = await resolveDefaultOrg(mockClient(get));
    expect(org).toEqual({ id: "o1", name: "Acme" });
    expect(get).toHaveBeenCalledWith("/v1/orgs");
  });

  it("returns the first org when the user has multiple", async () => {
    const orgs: Org[] = [
      { id: "o1", name: "First" },
      { id: "o2", name: "Second" },
    ];
    const get = vi.fn().mockResolvedValue(ok(orgs));
    const org = await resolveDefaultOrg(mockClient(get));
    expect(org).toEqual({ id: "o1", name: "First" });
  });

  it("throws a friendly error when the user has zero orgs", async () => {
    const get = vi.fn().mockResolvedValue(ok([] as Org[]));
    await expect(resolveDefaultOrg(mockClient(get))).rejects.toThrow(
      /No organization found/,
    );
  });

  it("throws when the response is not an array (null)", async () => {
    const get = vi.fn().mockResolvedValue(ok(null as unknown as Org[]));
    await expect(resolveDefaultOrg(mockClient(get))).rejects.toThrow(
      /No organization found/,
    );
  });

  it("propagates network errors as-is", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(resolveDefaultOrg(mockClient(get))).rejects.toThrow("ECONNRESET");
  });
});
