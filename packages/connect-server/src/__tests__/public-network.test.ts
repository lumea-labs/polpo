import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import { createPublicNetworkTransport, publicAddressLookup } from "../public-network.js";

const transports: ReturnType<typeof createPublicNetworkTransport>[] = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(transport => transport.close())); });

describe("Connect network transport", () => {
  it("pins the exact validated DNS answers supplied to the socket connector", async () => {
    const resolve = vi.fn(async () => ["8.8.8.8", "2606:4700:4700::1111"]);
    const lookup = publicAddressLookup(resolve);
    const answers = await new Promise((resolve, reject) => lookup("api.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
    expect(answers).toEqual([{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    // A later socket cannot reuse a previously approved hostname after rebinding.
    resolve.mockResolvedValueOnce(["127.0.0.1"]);
    await expect(new Promise((resolve, reject) => lookup("api.example", {}, (error, address) => error ? reject(error) : resolve(address))))
      .rejects.toThrow("Public network destination required");
  });

  it.each([["8.8.8.8", "10.0.0.1"], ["::ffff:7f00:1"], [], ["not-an-ip"]])("rejects unsafe DNS results %j", async (...addresses) => {
    const lookup = publicAddressLookup(async () => addresses as string[]);
    await expect(new Promise((resolve, reject) => lookup("api.example", {}, (error, address) => error ? reject(error) : resolve(address))))
      .rejects.toThrow("Public network destination required");
  });

  it("blocks private DNS at socket creation before sending credentials to a local server", async () => {
    let connections = 0;
    const server = createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const transport = createPublicNetworkTransport(async () => ["127.0.0.1"]); transports.push(transport);
      await expect(transport.fetch(`https://public-looking.example:${address.port}/account`, {
        headers: { authorization: "Bearer private-test-token" }, signal: AbortSignal.timeout(1000),
      })).rejects.toThrow();
      expect(connections).toBe(0);
      await expect(transport.fetch(`https://127.0.0.1:${address.port}/account`)).rejects.toThrow("Public network destination required");
      await expect(transport.fetch("http://api.example/account")).rejects.toThrow("Public network destination required");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
