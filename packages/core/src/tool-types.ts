/**
 * is a pure import swap with zero runtime changes.
 */
import type { TSchema, Static } from "@sinclair/typebox";

export interface ToolResult<TDetails = any> {
  /** Explicit execution failure, compatible with MCP CallToolResult. */
  isError?: boolean;
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details: TDetails;
}

export type ToolUpdateCallback<T = any> = (partialResult: ToolResult<T>) => void;

/** Provider-neutral behavioral metadata, compatible with MCP tool annotations. */
export interface PolpoToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  /** Polpo extension used only when results are safe to reuse within one Run. */
  resultStability?: "stable" | "volatile" | "unknown";
}

export type PolpoToolStrictness =
  | "execution"
  | "provider-preferred"
  | "provider-required";

export interface PolpoTool<TParameters extends TSchema = TSchema, TDetails = any> {
  name: string;
  label: string;
  description: string;
  /** Whether every execution of this tool needs a runtime sandbox. */
  requiresSandbox?: boolean;
  /** Behavioral facts used for approvals, retries, deduplication, and audit. */
  annotations?: PolpoToolAnnotations;
  /** Local execution validation is unconditional; this controls provider-native strictness. */
  strictness?: PolpoToolStrictness;
  parameters: TParameters;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback<TDetails>,
  ) => Promise<ToolResult<TDetails>>;
}
