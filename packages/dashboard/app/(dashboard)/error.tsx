"use client";

/**
 * Error boundary for the dashboard group. A transient backend failure
 * (control-plane 5xx / network / DB unreachable) now surfaces here instead
 * of being swallowed into "no orgs → /onboarding". Auth failures (401) are
 * handled upstream by `getOrgs` (redirect to /login).
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md border border-border bg-card p-8 text-center">
        <h2 className="text-base font-semibold text-foreground">Something went wrong</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn&apos;t reach the control plane. This is usually temporary —
          give it a moment and retry.
        </p>
        {error?.digest ? (
          <p className="mt-3 font-mono text-[11px] text-muted-foreground/50">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="border border-foreground bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
          >
            Try again
          </button>
          <a
            href="/login"
            className="border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-foreground/40"
          >
            Sign in
          </a>
        </div>
      </div>
    </div>
  );
}
