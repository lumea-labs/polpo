/**
 * Vault tools for agents to access their own credentials at runtime.
 *
 * Provides read-only access to the agent's resolved vault:
 * - vault_get: inspect credential keys for a specific service
 * - vault_list: list available services (keys only, values masked)
 *
 * The vault is pre-resolved at spawn time — ${ENV_VAR} references are already
 * replaced with actual values. Tool implementations receive those values
 * internally, but model-visible vault tools never expose them.
 */

import { Type } from "@sinclair/typebox";
import type { PolpoTool } from "@polpo-ai/core";
import type { ResolvedVault } from "./types.js";

// ─── Tool names ───

export const ALL_VAULT_TOOL_NAMES = ["vault_get", "vault_list"] as const;
export type VaultToolName = (typeof ALL_VAULT_TOOL_NAMES)[number];

// ─── Tool: vault_get ───

const VaultGetSchema = Type.Object({
  service: Type.String({ description: "Service name to retrieve credentials for (e.g. 'smtp', 'openai', 'stripe')" }),
});

function createVaultGetTool(vault: ResolvedVault): PolpoTool<typeof VaultGetSchema> {
  return {
    name: "vault_get",
    label: "Inspect Vault Credentials",
    description: "Check whether credentials exist for a specific service and list their key names. Secret values are never exposed. Use vault_list first to see available services.",
    parameters: VaultGetSchema,
    async execute(_toolCallId, params) {
      const creds = vault.get(params.service);
      if (!creds) {
        return {
          content: [{ type: "text", text: `No vault entry found for service "${params.service}". Use vault_list to see available services.` }],
          details: { service: params.service, found: false },
        };
      }
      const keys = Object.keys(creds);
      const lines = keys.map((key) => `  ${key}: [REDACTED]`);
      return {
        content: [{
          type: "text",
          text: `Credentials are configured for "${params.service}":\n${lines.join("\n")}\nSecret values are available only to tool implementations at execution time.`,
        }],
        details: { service: params.service, found: true, keys },
      };
    },
  };
}

// ─── Tool: vault_list ───

const VaultListSchema = Type.Object({});

function createVaultListTool(vault: ResolvedVault): PolpoTool<typeof VaultListSchema> {
  return {
    name: "vault_list",
    label: "List Vault Services",
    description: "List all available services in your vault. Shows service names, types, and credential key names; secret values are never exposed.",
    parameters: VaultListSchema,
    async execute() {
      const services = vault.list();
      if (services.length === 0) {
        return {
          content: [{ type: "text", text: "No vault entries configured for this agent." }],
          details: { count: 0, services: [] },
        };
      }
      const lines = services.map(s => `  - ${s.service} (${s.type}): keys=[${s.keys.join(", ")}]`);
      return {
        content: [{ type: "text", text: `${services.length} vault service(s):\n${lines.join("\n")}` }],
        details: { count: services.length, services: services.map(s => s.service) },
      };
    },
  };
}

// ─── Factory ───

/**
 * Create vault tools (core — always included when vault is available).
 * Vault tools are core tools: they are always available to every agent
 * that has a resolved vault, regardless of allowedTools configuration.
 */
export function createVaultToolsCore(vault: ResolvedVault): PolpoTool<any>[] {
  return [createVaultGetTool(vault), createVaultListTool(vault)];
}

/**
 * Create vault tools for an agent, filtered by allowedTools.
 * @deprecated Use createVaultToolsCore() — vault tools are now core tools (always available).
 */
export function createVaultTools(vault: ResolvedVault, allowedTools?: string[]): PolpoTool<any>[] {
  const tools: PolpoTool<any>[] = [];
  const allowed = (name: string) => !allowedTools || allowedTools.includes(name);

  if (allowed("vault_get")) tools.push(createVaultGetTool(vault));
  if (allowed("vault_list")) tools.push(createVaultListTool(vault));

  return tools;
}
