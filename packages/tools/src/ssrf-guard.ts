/**
 * SSRF guard — blocks HTTP requests to internal/private network addresses.
 *
 * Prevents agents from making requests to:
 * - localhost (127.0.0.0/8, ::1, 0.0.0.0, localhost)
 * - RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local / cloud metadata (169.254.0.0/16, metadata.google.internal)
 * - Other non-public ranges (CGNAT, multicast, IPv6 ULA/link-local, IPv4-mapped IPv6)
 *
 * This only inspects the URL. Hostnames are additionally checked against the
 * addresses they resolve to at connect time (safe-fetch.ts).
 */

/** Hostnames that are always blocked. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

/**
 * Parse an IPv4 address string into a 32-bit number.
 * Returns undefined if not a valid IPv4 address.
 */
function parseIPv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;

  let num = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    num = (num << 8) | octet;
  }
  return num >>> 0; // unsigned 32-bit
}

/**
 * Check whether an IPv4 address (as 32-bit number) falls within a CIDR range.
 */
function inRange(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/**
 * Classify an IP address literal (IPv4 or IPv6, no brackets).
 * Returns a human-readable reason when the address is not a public unicast
 * destination, or undefined when it is allowed.
 *
 * Used both for URL host literals and for every address DNS returns before a
 * socket is opened (see safe-fetch.ts), so hostnames that resolve to internal
 * addresses are rejected too.
 */
export function blockedAddressReason(address: string): string | undefined {
  const bare = address.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = parseIPv4(bare);
  if (ipv4 !== undefined) return blockedIPv4Reason(ipv4);
  if (!bare.includes(":")) return undefined;

  let normalized: string;
  try {
    normalized = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return "invalid IPv6 address";
  }
  if (normalized === "::") return "unspecified";
  if (normalized === "::1") return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d, normalized by URL to ::ffff:xxxx:xxxx) and
  // NAT64 (64:ff9b::/96) embed an IPv4 destination.
  const embedded = normalized.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (embedded) {
    const high = parseInt(embedded[1], 16);
    const low = parseInt(embedded[2], 16);
    return blockedIPv4Reason(((high << 16) | low) >>> 0);
  }
  const firstGroup = parseInt(normalized.split(":")[0] || "0", 16);
  if ((firstGroup & 0xfe00) === 0xfc00) return "private network";
  if ((firstGroup & 0xffc0) === 0xfe80) return "link-local/metadata";
  if ((firstGroup & 0xff00) === 0xff00) return "multicast";
  return undefined;
}

function blockedIPv4Reason(ip: number): string | undefined {
  if (inRange(ip, 0x00000000, 8)) return "unspecified";
  if (inRange(ip, 0x7f000000, 8)) return "loopback";
  if (inRange(ip, 0x0a000000, 8)) return "private network";
  if (inRange(ip, 0xac100000, 12)) return "private network";
  if (inRange(ip, 0xc0a80000, 16)) return "private network";
  if (inRange(ip, 0x64400000, 10)) return "private network"; // 100.64.0.0/10 carrier-grade NAT
  if (inRange(ip, 0xa9fe0000, 16)) return "link-local/metadata";
  if (inRange(ip, 0xc0000000, 24)) return "reserved"; // 192.0.0.0/24 IETF protocol assignments
  if (inRange(ip, 0xc6120000, 15)) return "reserved"; // 198.18.0.0/15 benchmarking
  if (inRange(ip, 0xe0000000, 3)) return "multicast/reserved"; // 224.0.0.0/3
  return undefined;
}

/**
 * Assert that a URL does not point to a private/internal network address.
 * Throws an Error if the URL is blocked.
 *
 * @param urlString - The URL to check
 * @throws Error with descriptive message if the URL targets an internal address
 */
export function assertUrlAllowed(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets
  const bareHost = (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname).replace(/\.$/, "");

  // Block known hostnames
  if (BLOCKED_HOSTNAMES.has(bareHost) || bareHost.endsWith(".localhost")) {
    throw new Error(`SSRF blocked: requests to ${bareHost} are not allowed`);
  }

  // Block IPv6 loopback
  if (bareHost === "::1" || bareHost === "::0" || bareHost === "0:0:0:0:0:0:0:1" || bareHost === "0:0:0:0:0:0:0:0") {
    throw new Error(`SSRF blocked: requests to ${bareHost} are not allowed`);
  }

  // Block 0.0.0.0
  if (bareHost === "0.0.0.0") {
    throw new Error(`SSRF blocked: requests to 0.0.0.0 are not allowed`);
  }

  // Check IPv4 ranges
  const ipv4 = parseIPv4(bareHost);
  if (ipv4 !== undefined) {
    // 127.0.0.0/8 — loopback
    if (inRange(ipv4, 0x7f000000, 8)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (loopback) are not allowed`);
    }
    // 10.0.0.0/8 — RFC1918
    if (inRange(ipv4, 0x0a000000, 8)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (private network) are not allowed`);
    }
    // 172.16.0.0/12 — RFC1918
    if (inRange(ipv4, 0xac100000, 12)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (private network) are not allowed`);
    }
    // 192.168.0.0/16 — RFC1918
    if (inRange(ipv4, 0xc0a80000, 16)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (private network) are not allowed`);
    }
    // 169.254.0.0/16 — link-local / cloud metadata
    if (inRange(ipv4, 0xa9fe0000, 16)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (link-local/metadata) are not allowed`);
    }
  }

  // Remaining non-public literals (IPv6 ULA/link-local, IPv4-mapped IPv6,
  // CGNAT, multicast, …).
  const reason = blockedAddressReason(bareHost);
  if (reason) {
    throw new Error(`SSRF blocked: requests to ${bareHost} (${reason}) are not allowed`);
  }
}
