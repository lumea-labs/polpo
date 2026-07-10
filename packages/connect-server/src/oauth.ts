import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = createOpaqueToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function toFormBody(input: Record<string, string | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") body.set(key, value);
  }
  return body;
}

export function parseScopes(scope: string | undefined, fallback: readonly string[]): string[] {
  if (!scope) return [...fallback];
  return scope.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
}
