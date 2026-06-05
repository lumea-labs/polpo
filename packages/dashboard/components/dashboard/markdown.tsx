"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

const ReactMarkdown = dynamic(() => import("react-markdown"), {
  loading: () => (
    <div className="space-y-2">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-5/6" />
    </div>
  ),
});

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
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
}
