import type { ApiKey } from "@/lib/api";

function timeAgo(date: string | null) {
  if (!date) return "never";
  const diff = Date.now() - new Date(date).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return "just now";
}

export function ApiKeysTable({ keys }: { keys: ApiKey[] }) {
  return (
    <div className="mt-4 rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Name</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Key</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Environment</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Last used</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3 font-medium">{key.name}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {key.keyPrefix}...
              </td>
              <td className="px-4 py-3">
                <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                  key.environment === "live"
                    ? "bg-brand/10 text-brand"
                    : "bg-secondary text-muted-foreground"
                }`}>
                  {key.environment}
                </span>
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {timeAgo(key.lastUsedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
