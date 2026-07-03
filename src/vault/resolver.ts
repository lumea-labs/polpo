/**
 * Vault resolver — re-export shim.
 * Source of truth is packages/core/src/vault-resolver.ts (@polpo-ai/core),
 * so the shell, @polpo-ai/tools, and the cloud data plane share one
 * definition of ResolvedVault.
 */
export {
  resolveEnvVar,
  resolveVaultCredentials,
  resolveAgentVault,
  type ResolvedVault,
  type SmtpCredentials,
  type ImapCredentials,
} from "@polpo-ai/core";
