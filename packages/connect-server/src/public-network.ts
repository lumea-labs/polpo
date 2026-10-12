import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import { connectorHostnameIsUnsafe } from "@polpo-ai/connect";

type ResolveHostname = (hostname: string) => Promise<readonly string[]>;
const resolveHostname: ResolveHostname = async hostname =>
  (await lookup(hostname, { all: true, verbatim: true })).map(answer => answer.address);
const denied = () => new Error("Public network destination required");

/** Validate the exact addresses returned to net/tls.connect; no second DNS lookup. */
export function publicAddressLookup(resolve: ResolveHostname): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname).then(addresses => {
      if (!addresses.length || addresses.some(address => !isIP(address) || connectorHostnameIsUnsafe(address))) {
        callback(denied(), "");
        return;
      }
      const answers = addresses.map(address => ({ address, family: isIP(address) }));
      if (options.all) callback(null, answers);
      else {
        const selected = answers.find(answer => !options.family || answer.family === options.family);
        if (!selected) callback(denied(), "");
        else callback(null, selected.address, selected.family);
      }
    }, () => callback(denied(), ""));
  };
}

export function createPublicNetworkTransport(resolve: ResolveHostname = resolveHostname) {
  const dispatcher = new Agent({
    connect: { lookup: publicAddressLookup(resolve), timeout: 10_000 },
    connections: 8, headersTimeout: 10_000, bodyTimeout: 10_000,
  });
  const fetchPublic: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || url.username || url.password || url.hash || connectorHostnameIsUnsafe(url.hostname)) throw denied();
    // The service owns redirect policy. Never let fetch follow an unvalidated
    // Location before the service can reapply origin/path/auth restrictions.
    const request: RequestInit & { dispatcher: Agent } = {
      ...init, redirect: init?.redirect === "manual" ? "manual" : "error", dispatcher,
    };
    return globalThis.fetch(input, request);
  };
  return { fetch: fetchPublic, close: () => dispatcher.destroy() };
}

// A process-wide dispatcher reuses validated sockets across short-lived service
// instances. Custom fetch adapters own equivalent socket/egress enforcement.
export const publicNetworkFetch = createPublicNetworkTransport().fetch;
