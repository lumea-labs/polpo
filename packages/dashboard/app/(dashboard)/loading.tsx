export default function DashboardLoading() {
  return (
    <div className="px-4 py-6 md:px-8 md:py-8">
      <div className="space-y-4">
        {/* Header skeleton */}
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-80 animate-pulse rounded bg-muted/60" />

        {/* Content skeleton */}
        <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg border border-border bg-card"
            />
          ))}
        </div>

        <div className="mt-8 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded border border-border bg-card"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
