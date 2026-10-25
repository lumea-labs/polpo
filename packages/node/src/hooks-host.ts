/**
 * Node host for Claude Code–compatible hooks: runs command hooks with the
 * event JSON on stdin (locally in their own process group, or through a
 * sandbox Shell), and HTTP hooks over a DNS-pinned connection.
 */
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Shell } from "@polpo-ai/core/shell";
import type {
  CommandHookRequest,
  CommandRunResult,
  HookHost,
  HttpHookRequest,
  HttpRunResult,
} from "@polpo-ai/core/runtime-hooks";

/** Captured stdout/stderr bound per stream; output beyond it is discarded. */
export const HOOK_PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;
/** After the hook process exits, wait this long for its pipes to close. */
export const HOOK_PIPE_GRACE_MS = 250;
/** HTTP hook response bodies are read up to this size. */
export const HOOK_HTTP_RESPONSE_LIMIT_BYTES = 256 * 1024;

export interface NodeHookHostOptions extends Omit<HookHost, "runCommand" | "runHttp"> {
  /**
   * Run command hooks through this Shell (sandbox, remote runner). When
   * omitted, command hooks spawn locally in their own process group.
   */
  shell?: Shell;
  /**
   * HTTP destination policy. `public` (default) requires a hostname resolving
   * only to public addresses and pins the connection to them; `any` permits
   * private and loopback endpoints (self-hosted operators who opt in).
   */
  httpDestinations?: "public" | "any";
  lookup?: typeof dnsLookup;
}

export function createNodeHookHost(options: NodeHookHostOptions = {}): HookHost {
  const { shell, httpDestinations = "public", lookup = dnsLookup, ...rest } = options;
  return {
    ...rest,
    runCommand: shell ? (request) => runCommandThroughShell(shell, request) : runLocalCommand,
    runHttp: (request) => runHttpHook(request, { destinations: httpDestinations, lookup }),
  };
}

// ─── Local process ──────────────────────────────────────────────────────────

/**
 * Spawn the hook in its own session (no controlling terminal), write the event
 * JSON to stdin once and close it, collect bounded output, and kill the whole
 * process group when the engine aborts (timeout or cancellation).
 */
export function runLocalCommand(request: CommandHookRequest): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const { file, args } = commandLine(request);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: request.cwd,
        env: { ...hookProcessEnv(), ...request.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ kind: "command", exitCode: null, stdout: "", stderr: "", startError: errorMessage(error) });
      return;
    }

    const stdout = boundedCollector();
    const stderr = boundedCollector();
    let exitCode: number | null = null;
    let settled = false;
    let exited = false;
    let pipesOpen = 2;
    let graceTimer: NodeJS.Timeout | undefined;

    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    };
    const settle = (result: Omit<CommandRunResult, "kind" | "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      request.signal.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ kind: "command", stdout: stdout.text(), stderr: stderr.text(), ...result });
    };
    const onAbort = () => {
      killGroup();
      settle({ exitCode: null, timedOut: true });
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const pipeClosed = () => {
      pipesOpen--;
      if (exited && pipesOpen === 0) settle({ exitCode });
    };
    child.stdout?.on("close", pipeClosed);
    child.stderr?.on("close", pipeClosed);
    child.on("error", (error) => settle({ exitCode: null, startError: errorMessage(error) }));
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? (signal ? 128 + signalNumber(signal) : null);
      if (pipesOpen === 0) {
        settle({ exitCode });
        return;
      }
      // A background child still holds stdout/stderr open: stop reading shortly
      // after the hook's own process exits and refuse to honor that capture.
      graceTimer = setTimeout(() => settle({ exitCode, suspectCapture: true }), HOOK_PIPE_GRACE_MS);
    });

    child.stdin?.on("error", () => { /* hook may exit without reading stdin */ });
    child.stdin?.end(request.stdin);
  });
}

function commandLine(request: CommandHookRequest): { file: string; args: string[] } {
  if (request.argv) return { file: request.command, args: request.argv };
  if (request.shell === "powershell") {
    return { file: process.platform === "win32" ? "powershell.exe" : "pwsh", args: ["-NoProfile", "-Command", request.command] };
  }
  return process.platform === "win32"
    ? { file: "bash", args: ["-c", request.command] }
    : { file: "/bin/sh", args: ["-c", request.command] };
}

/** Inherit the host environment except OpenTelemetry exporter settings, as the reference does. */
function hookProcessEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("OTEL_")));
}

function boundedCollector() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk: Buffer) {
      if (bytes >= HOOK_PROCESS_OUTPUT_LIMIT_BYTES) return;
      const room = HOOK_PROCESS_OUTPUT_LIMIT_BYTES - bytes;
      const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      bytes += slice.byteLength;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

// ─── Sandbox / remote Shell ─────────────────────────────────────────────────

/**
 * Run a command hook through a Shell (e.g. a Daytona sandbox). The Shell
 * contract has no stdin, so the event JSON is decoded from base64 and piped in.
 */
export async function runCommandThroughShell(shell: Shell, request: CommandHookRequest): Promise<CommandRunResult> {
  const payload = Buffer.from(request.stdin, "utf8").toString("base64");
  const target = request.argv
    ? [request.command, ...request.argv].map(shellQuote).join(" ")
    : request.shell === "powershell"
      ? `pwsh -NoProfile -Command ${shellQuote(request.command)}`
      : `sh -c ${shellQuote(request.command)}`;
  const line = `printf '%s' ${shellQuote(payload)} | base64 -d | ${target}`;
  const aborted = new Promise<CommandRunResult>((resolve) => {
    const onAbort = () => resolve({ kind: "command", exitCode: null, stdout: "", stderr: "", timedOut: true });
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
  });
  const executed = shell.execute(line, { cwd: request.cwd, env: request.env, timeout: request.timeoutMs })
    .then((result): CommandRunResult => ({
      kind: "command",
      exitCode: result.exitCode,
      stdout: truncateUtf8(result.stdout, HOOK_PROCESS_OUTPUT_LIMIT_BYTES),
      stderr: truncateUtf8(result.stderr, HOOK_PROCESS_OUTPUT_LIMIT_BYTES),
    }))
    .catch((error): CommandRunResult => ({ kind: "command", exitCode: null, stdout: "", stderr: "", startError: errorMessage(error) }));
  return Promise.race([executed, aborted]);
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

export async function runHttpHook(
  request: HttpHookRequest,
  policy: { destinations: "public" | "any"; lookup: typeof dnsLookup },
): Promise<HttpRunResult> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "http", error: "HTTP hook URL is invalid" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    return { kind: "http", error: "HTTP hook URL must be http(s) without embedded credentials" };
  }
  let address: { address: string; family: number };
  try {
    const resolved = isIP(stripBrackets(url.hostname))
      ? [{ address: stripBrackets(url.hostname), family: isIP(stripBrackets(url.hostname)) }]
      : await policy.lookup(url.hostname, { all: true, verbatim: true });
    if (!resolved.length) return { kind: "http", error: "HTTP hook hostname did not resolve" };
    if (policy.destinations === "public" && resolved.some(({ address: candidate }) => !isPublicAddress(candidate))) {
      return { kind: "http", error: "HTTP hook destination must resolve only to public addresses" };
    }
    address = resolved[0]!;
  } catch {
    return { kind: "http", error: "HTTP hook hostname could not be resolved" };
  }
  if (policy.destinations === "public" && url.protocol !== "https:") {
    return { kind: "http", error: "HTTP hook URL must use https" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HttpRunResult) => {
      if (settled) return;
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: { ...request.headers, "content-length": String(Buffer.byteLength(request.body)) },
      ...(url.protocol === "https:" ? { servername: stripBrackets(url.hostname) } : {}),
      // Pin the socket to the validated address. Node 22 calls lookup with
      // `all: true` (autoSelectFamily) and expects an array in that case.
      lookup: ((_hostname: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (lookupOptions?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as never,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > HOOK_HTTP_RESPONSE_LIMIT_BYTES) {
          response.destroy();
          outgoing.destroy();
          finish({ kind: "http", error: `HTTP hook response exceeds ${HOOK_HTTP_RESPONSE_LIMIT_BYTES} bytes` });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish({
        kind: "http",
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      response.on("error", (error) => finish({ kind: "http", error: errorMessage(error) }));
    });
    const onAbort = () => {
      outgoing.destroy();
      finish({ kind: "http", timedOut: true });
    };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener("abort", onAbort, { once: true });
    outgoing.on("error", (error) => finish({ kind: "http", error: errorMessage(error) }));
    outgoing.end(request.body);
  });
}

/** Reject loopback, private, link-local, CGNAT, multicast, reserved and mapped/translated forms. */
export function isPublicAddress(raw: string): boolean {
  const address = stripBrackets(raw).toLowerCase();
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh), IPv4-compatible and NAT64.
  const mapped = /^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isPublicIpv4(mapped[1]!);
  const hexMapped = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16);
    const low = parseInt(hexMapped[2]!, 16);
    return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (address === "::" || address === "::1") return false;
  const first = parseInt(address.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 site local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2002) return false; // 6to4 can embed private IPv4
  if (address.startsWith("2001:db8:") || address.startsWith("2001:0db8:")) return false; // documentation
  if (address.startsWith("100::")) return false; // discard-only
  return true;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.byteLength <= maxBytes ? text : buffer.subarray(0, maxBytes).toString("utf8");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return numbers[signal] ?? 0;
}
