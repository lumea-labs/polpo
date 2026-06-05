import { Skeleton } from "#/components/ui/skeleton";

export function PlaygroundSkeleton() {
  return (
    <>
      {/* Top bar — mirrors view.tsx: back button + brand row + selector */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-32" />
          <div className="hidden md:block h-5 w-px bg-border" />
          <div className="hidden md:flex items-center gap-2">
            <Skeleton className="h-4 w-16 opacity-60" />
            <Skeleton className="h-3 w-20 opacity-60" />
          </div>
        </div>
        <div className="flex items-center gap-3 border border-border bg-card px-3 py-2">
          <Skeleton className="size-6" />
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-2.5 w-28 opacity-60" />
          </div>
          <Skeleton className="ml-2 size-3.5" />
        </div>
      </div>

      {/* Chat pane fills the rest of the viewport. */}
      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 space-y-6 px-6 py-8">
          <MessageSkeleton role="user" />
          <MessageSkeleton role="assistant" />
          <MessageSkeleton role="user" short />
          <MessageSkeleton role="assistant" />
        </div>

        <div className="px-6 pb-4 pt-3">
          <Skeleton className="h-11 w-full rounded-2xl" />
        </div>
      </main>
    </>
  );
}

function MessageSkeleton({
  role,
  short,
}: {
  role: "user" | "assistant";
  short?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[70%] space-y-2 ${isUser ? "text-right" : ""}`}>
        <Skeleton
          className={`h-3 ${isUser ? "ml-auto w-16" : "w-20"} opacity-60`}
        />
        <Skeleton className={`h-4 ${short ? "w-32" : "w-full min-w-[280px]"}`} />
        {!short && <Skeleton className="h-4 w-4/5" />}
        {!short && !isUser && <Skeleton className="h-4 w-3/5" />}
      </div>
    </div>
  );
}
