import { isMemoryItemRetrievable } from "./lifecycle.js";
import type {
  MemoryItem,
  MemoryKind,
  RenderMemoryItemsOptions,
} from "./types.js";

const KIND_LABELS: Readonly<Record<MemoryKind, string>> = {
  fact: "Fact",
  preference: "Preference",
  open_thread: "Open thread",
  style: "Style",
  failure_pattern: "Failure pattern",
  successful_episode: "Successful episode",
  procedure_hint: "Procedure hint",
};

function renderContent(content: string): string {
  const [first, ...rest] = content.split("\n");
  return [first, ...rest.map((line) => `  ${line}`)].join("\n");
}

export function renderMemoryItemsMarkdown(
  items: readonly MemoryItem[],
  options: RenderMemoryItemsOptions = {},
): string {
  const now = options.now ?? new Date();
  return items
    .filter((item) => (
      options.includePending
        ? item.status === "pending" || isMemoryItemRetrievable(item, now)
        : isMemoryItemRetrievable(item, now)
    ))
    .slice()
    .sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
    ))
    .map((item) => `- **${KIND_LABELS[item.kind]}:** ${renderContent(item.content)}`)
    .join("\n");
}
