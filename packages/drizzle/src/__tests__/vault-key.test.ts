import { describe, expect, it } from "vitest";
import { DrizzleVaultStore } from "../stores/vault-store.js";

describe("DrizzleVaultStore explicit key", () => {
  it("accepts a host-owned 32-byte key without resolving process-global state", () => {
    const key = Buffer.alloc(32, 7);
    expect(() => new DrizzleVaultStore({} as never, {} as never, key)).not.toThrow();
  });

  it("rejects malformed host-owned keys", () => {
    expect(() => new DrizzleVaultStore({} as never, {} as never, Buffer.alloc(31))).toThrow(
      "Vault encryption key must be 32 bytes",
    );
  });
});
