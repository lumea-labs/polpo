"use client";

import { lazy, Suspense } from "react";
import { useMemory } from "@polpo-ai/react";
import { Skeleton } from "../ui/skeleton.js";

export { Button } from "../ui/button.js";
export { PageBody, PageHeader } from "../ui/page-header.js";
export { RefreshButton } from "../ui/refresh-button.js";

const ReactMarkdown = lazy(() => import("react-markdown"));

export function usePolpoClient(_projectId: string) {
  const { saveMemory } = useMemory();
  return { saveMemory };
}

export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none
      prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-foreground
      prose-h1:text-lg prose-h2:text-sm prose-h3:text-xs
      prose-p:text-muted-foreground prose-p:leading-relaxed
      prose-li:text-muted-foreground prose-li:marker:text-muted-foreground/40
      prose-strong:text-foreground prose-strong:font-medium
      prose-code:text-xs prose-code:font-mono prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:rounded
      prose-pre:bg-card prose-pre:border prose-pre:border-border prose-pre:rounded-lg
      prose-a:text-brand prose-a:no-underline hover:prose-a:underline
    ">
      <Suspense
        fallback={
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
          </div>
        }
      >
        <ReactMarkdown>{content}</ReactMarkdown>
      </Suspense>
    </div>
  );
}
