import { createHash } from "node:crypto";
import { ConnectError, normalizeScopes, type OAuth2AuthConfig, type OAuthAccountIdentity, type OAuthUserInfoPolicy } from "@polpo-ai/connect";
import { requestOAuthJson, type TokenTransportOptions } from "./oauth-token-transport.js";

export function oauthIdentityPolicyFingerprint(policy?: OAuthUserInfoPolicy): string | undefined {
  return policy ? createHash("sha256").update(JSON.stringify([
    policy.method, policy.issuer, policy.url, [...policy.requiredScopes].sort(),
    Object.entries(policy.scopeAliases ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ])).digest("hex") : undefined;
}

export function normalizeOAuthTokenScopes(auth: OAuth2AuthConfig, scopes: string[]): string[] {
  const aliases = auth.identity?.scopeAliases;
  return normalizeScopes(scopes.map(scope => aliases && Object.hasOwn(aliases, scope) ? aliases[scope] : scope));
}

export async function resolveOAuthAccountIdentity(
  options: TokenTransportOptions,
  policy: OAuthUserInfoPolicy,
  accessToken: string,
  now: Date,
): Promise<OAuthAccountIdentity> {
  const fail = (category: string, status?: number) => new ConnectError("setup_invalid", "OAuth account identity could not be verified", {
    details: { category, ...(status === undefined ? {} : { providerStatus: status }) },
  });
  const body = await requestOAuthJson({ ...options, requireJsonContentType: true }, policy.url, {
    method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  }, fail);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("invalid_identity");
  const value = body as Record<string, unknown>;
  if (typeof value.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(value.sub)
    || (value.iss !== undefined && value.iss !== policy.issuer)) throw fail("invalid_identity");
  return { issuer: policy.issuer, subject: value.sub, verifiedAt: now.toISOString(),
    policyFingerprint: oauthIdentityPolicyFingerprint(policy)! };
}
