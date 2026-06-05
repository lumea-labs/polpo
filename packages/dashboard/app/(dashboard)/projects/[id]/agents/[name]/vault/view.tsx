import { Hint } from "#/components/dashboard/hint";

interface VaultEntry {
  service: string;
  type: string;
  label: string | null;
}

const typeLabel: Record<string, string> = {
  smtp: "SMTP",
  imap: "IMAP",
  oauth: "OAuth",
  api_key: "API Key",
  login: "Login",
  custom: "Custom",
};

export default function AgentVaultView({ entries }: { entries: VaultEntry[] }) {
  return (
    <div>
      <div className="mb-4">
        <Hint>
          Credentials this agent can access at runtime via{" "}
          <span className="font-mono">vault_get</span>. AES-256-GCM encrypted at rest —
          never exposed in the dashboard.
        </Hint>
      </div>

      {entries.length > 0 ? (
        <div data-testid="vault-table" className="border border-border overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[400px]">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Service</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Type</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Label</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.service} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 font-mono text-xs font-medium">{entry.service}</td>
                  <td className="px-4 py-3">
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {typeLabel[entry.type] ?? entry.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{entry.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div data-testid="vault-empty" className="border border-border p-8 text-center text-sm text-muted-foreground">
          No credentials stored for this agent.
        </div>
      )}
    </div>
  );
}
