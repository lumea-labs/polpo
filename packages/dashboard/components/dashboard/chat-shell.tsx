"use client";

/**
 * Shared chat shell — the single place that wires an adapter into the
 * `@lumea-labs/chat` UI with the `variant="task"` tool-call renderer.
 *
 * Both the playground/agent-test chat (`PolpoChat`, Polpo SDK adapter)
 * and the Meta Agent builder chat (`BuilderChat`, custom SSE adapter)
 * render through here, so the tool-call variant (and the provider stack)
 * is defined exactly once — change it here, both surfaces follow.
 *
 * `children` overrides the default `<Chat>` input (e.g. the playground's
 * custom InputBar with the skills menu); omit for the default composer.
 */

import type { ReactNode } from "react";
import {
  Chat,
  ChatProvider,
  ToolCallVariantProvider,
  type ChatAdapter,
} from "@lumea-labs/chat";

export function ChatShell({
  adapter,
  children,
}: {
  adapter: ChatAdapter;
  children?: ReactNode;
}) {
  return (
    <ChatProvider adapter={adapter}>
      {/* variant="task" → tool calls render as task cards (matches
          lumea-agents). Defined ONCE here for every chat surface. */}
      <ToolCallVariantProvider variant="task">
        <Chat className="flex-1">{children}</Chat>
      </ToolCallVariantProvider>
    </ChatProvider>
  );
}
