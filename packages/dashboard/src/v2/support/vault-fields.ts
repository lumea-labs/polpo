/**
 * Shared vault credential-field config + helpers.
 *
 * Mirrors the credential schemas in @polpo-ai/server's vault route
 * (`SaveVaultEntryBody`). Used by both the agent vault tab CRUD and the
 * builder's `save_credential` secure form so the typed fields stay in sync.
 */

export type VaultType = "api_key" | "smtp" | "imap" | "oauth" | "login" | "custom";

export interface FieldDef {
  k: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
}

export const typeLabel: Record<string, string> = {
  smtp: "SMTP",
  imap: "IMAP",
  oauth: "OAuth",
  api_key: "API Key",
  login: "Login",
  custom: "Custom",
};

export const TYPE_OPTIONS: VaultType[] = ["api_key", "smtp", "imap", "oauth", "login", "custom"];

export const TYPE_FIELDS: Record<Exclude<VaultType, "custom">, FieldDef[]> = {
  api_key: [{ k: "key", label: "API key", secret: true }],
  smtp: [
    { k: "host", label: "Host" },
    { k: "port", label: "Port", placeholder: "587" },
    { k: "user", label: "User" },
    { k: "pass", label: "Password", secret: true },
    { k: "from", label: "From address" },
    { k: "secure", label: "Secure", optional: true, placeholder: "true | false" },
  ],
  imap: [
    { k: "host", label: "Host" },
    { k: "port", label: "Port", placeholder: "993" },
    { k: "user", label: "User" },
    { k: "pass", label: "Password", secret: true },
    { k: "tls", label: "TLS", optional: true, placeholder: "true | false" },
  ],
  oauth: [
    { k: "access_token", label: "Access token", secret: true },
    { k: "refresh_token", label: "Refresh token", secret: true, optional: true },
    { k: "client_id", label: "Client ID", optional: true },
    { k: "client_secret", label: "Client secret", secret: true, optional: true },
    { k: "expires_at", label: "Expires at", optional: true },
    { k: "scope", label: "Scope", optional: true },
  ],
  login: [
    { k: "username", label: "Username" },
    { k: "password", label: "Password", secret: true },
  ],
};

// Sharp, design-system-consistent field styling (no rounded; native inputs).
export const VAULT_INPUT_CLS =
  "w-full border border-border bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none";
export const VAULT_FIELD_LABEL_CLS =
  "font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground";

/**
 * Build the credentials object from form state, validating required fields.
 * Throws a user-facing Error on the first missing required field.
 */
export function buildCredentials(
  type: VaultType,
  fields: Record<string, string>,
  customRows: { k: string; v: string }[],
): Record<string, string> {
  if (type === "custom") {
    const out: Record<string, string> = {};
    for (const r of customRows) if (r.k.trim()) out[r.k.trim()] = r.v;
    if (Object.keys(out).length === 0) throw new Error("Add at least one field.");
    return out;
  }
  const out: Record<string, string> = {};
  for (const f of TYPE_FIELDS[type]) {
    const v = (fields[f.k] ?? "").trim();
    if (!v && !f.optional) throw new Error(`${f.label} is required.`);
    if (v) out[f.k] = v;
  }
  return out;
}
