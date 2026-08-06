/**
 * is a pure import swap with zero runtime changes.
 */
import type { TSchema, Static } from "@sinclair/typebox";

export interface ToolResult<TDetails = any> {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  details: TDetails;
}

export type ToolUpdateCallback<T = any> = (partialResult: ToolResult<T>) => void;

export interface PolpoTool<TParameters extends TSchema = TSchema, TDetails = any> {
  name: string;
  label: string;
  description: string;
  /** Whether every execution of this tool needs a runtime sandbox. */
  requiresSandbox?: boolean;
  parameters: TParameters;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback<TDetails>,
  ) => Promise<ToolResult<TDetails>>;
}
