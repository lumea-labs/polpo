export const RUNTIME_CONTEXT_ACCOUNTING_VERSION = 1 as const;

export const RUNTIME_CONTEXT_ACCOUNTING_SEGMENT_CATEGORIES = [
  "instructions",
  "memory",
  "brain",
  "skills",
  "tools",
  "workspace",
  "runtime",
  "conversation",
  "attachments",
  "retrieval",
  "other",
] as const;

export type RuntimeContextAccountingSegmentCategory =
  (typeof RUNTIME_CONTEXT_ACCOUNTING_SEGMENT_CATEGORIES)[number];

export const RUNTIME_CONTEXT_ACCOUNTING_SEGMENT_KINDS = [
  "prompt",
  "tool-schema",
  "message",
  "attachment",
  "retrieval",
] as const;

export type RuntimeContextAccountingSegmentKind =
  (typeof RUNTIME_CONTEXT_ACCOUNTING_SEGMENT_KINDS)[number];

/**
 * Secret-free accounting metadata for one model-context contribution.
 * Content is deliberately absent: inspectors receive size and provenance,
 * never prompt text, credentials, messages, or retrieved documents.
 */
export interface RuntimeContextAccountingSegment {
  readonly id: string;
  readonly label: string;
  readonly category: RuntimeContextAccountingSegmentCategory;
  readonly kind: RuntimeContextAccountingSegmentKind;
  readonly tokens: number;
  readonly characters?: number;
  readonly items?: number;
  readonly deferred?: boolean;
}

export interface RuntimeContextCategoryAccounting {
  readonly category: RuntimeContextAccountingSegmentCategory;
  readonly tokens: number;
  readonly segments: number;
}

export interface RuntimeContextAccountingTotals {
  readonly promptTokens: number;
  readonly toolSchemaTokens: number;
  readonly messageTokens: number;
  readonly attachmentTokens: number;
  readonly retrievalTokens: number;
  readonly totalTokens: number;
}

export interface RuntimeContextAccounting {
  readonly version: typeof RUNTIME_CONTEXT_ACCOUNTING_VERSION;
  readonly segments: readonly RuntimeContextAccountingSegment[];
  readonly categories: readonly RuntimeContextCategoryAccounting[];
  readonly totals: RuntimeContextAccountingTotals;
}
