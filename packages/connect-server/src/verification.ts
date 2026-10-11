import { ConnectError, type ConnectionRecord, type ConnectionVerificationResult, type ConnectorProviderDefinition } from "@polpo-ai/connect";
import type { ConnectService, VerifyConnectionInput, VerifyMcpConnectionProbe } from "./service.js";

export async function verifyConnectionProbe(
  service: ConnectService,
  input: VerifyConnectionInput,
  connection: ConnectionRecord,
  provider: ConnectorProviderDefinition,
  base: Pick<ConnectionVerificationResult, "checkedAt" | "configurationVersion">,
  verifyMcp?: VerifyMcpConnectionProbe,
): Promise<ConnectionVerificationResult> {
  const probe = provider.verification;
  const result: ConnectionVerificationResult = {
    ...base, connectionId: connection.id, providerId: provider.id,
    credentialVersion: connection.credentialVersion ?? connection.updatedAt,
    check: probe?.kind === "mcp_discovery" ? "mcp_discovery" : probe?.kind === "http"
      ? probe.account && connection.authType !== "none" ? "authenticated_operation" : "operation" : "configuration",
    outcome: "unsupported", code: "probe_not_configured",
  };
  if (connection.status !== "active") return { ...result, outcome: "failed", code: "connection_revoked" };
  if (!probe) return result;
  try {
    if (probe.kind === "mcp_discovery") {
      if (!verifyMcp) return { ...result, code: "mcp_probe_unavailable" };
      const credential = await service.resolveCredential({ ...input, scopes: probe.scopes, actionId: "connection.verify" });
      input.signal?.throwIfAborted();
      const discovered = await verifyMcp({ connection, credential, signal: input.signal });
      if (!Number.isSafeInteger(discovered.toolCount) || discovered.toolCount < 0) {
        return { ...result, outcome: "inconclusive", code: "invalid_response" };
      }
      return { ...result, outcome: "passed", code: "ok", toolCount: discovered.toolCount };
    }
    const response = await service.request({ ...input, scopes: probe.scopes, actionId: "connection.verify",
      request: { method: "GET", path: probe.path, query: probe.query } });
    const status = response.status;
    if (status === 401) return { ...result, outcome: "failed", code: "invalid_credentials" };
    if (status === 403) return { ...result, outcome: "failed", code: "access_denied" };
    if (status === 429) return { ...result, outcome: "inconclusive", code: "rate_limited" };
    if (status >= 500) return { ...result, outcome: "inconclusive", code: "provider_unavailable" };
    if (status < 200 || status >= 300) return { ...result, outcome: "failed", code: "probe_rejected" };
    if (probe.account) {
      if (connection.authType === "none") return { ...result, outcome: "unsupported", code: "public_account_probe" };
      const id = responseField(response.body, probe.account.idPath);
      const label = probe.account.labelPath ? responseField(response.body, probe.account.labelPath) : undefined;
      if (!id) return { ...result, outcome: "inconclusive", code: "invalid_response" };
      return { ...result, outcome: "passed", code: "ok", account: { id, ...(label ? { label } : {}) } };
    }
    return { ...result, outcome: "passed", code: "ok" };
  } catch (error) {
    if (error instanceof ConnectError) {
      const status = error.details && typeof error.details === "object" && "providerStatus" in error.details
        ? error.details.providerStatus : undefined;
      if (status === 401) return { ...result, outcome: "failed", code: "invalid_credentials" };
      if (status === 403) return { ...result, outcome: "failed", code: "access_denied" };
      if (status === 429) return { ...result, outcome: "inconclusive", code: "rate_limited" };
      const denied = ["invalid_scope", "policy_denied", "connection_revoked", "secret_not_found", "unsupported_auth", "setup_invalid"];
      return { ...result, outcome: denied.includes(error.code) ? "failed" : "inconclusive", code: error.code };
    }
    return { ...result, outcome: "inconclusive", code: input.signal?.aborted ? "aborted" : "probe_failed" };
  }
}

function responseField(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.trim() && current.length <= 512 ? current : undefined;
}
