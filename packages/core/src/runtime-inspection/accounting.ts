import {
  RUNTIME_CONTEXT_ACCOUNTING_VERSION,
  RUNTIME_CONTEXT_SEGMENT_CATEGORIES,
  RUNTIME_CONTEXT_SEGMENT_KINDS,
  type RuntimeContextAccounting,
  type RuntimeContextAccountingSegment,
  type RuntimeContextCategoryAccounting,
  type RuntimeContextSegmentCategory,
  type RuntimeContextSegmentKind,
} from "./types.js";

const MAX_ACCOUNTING_SEGMENTS = 10_000;
const categorySet = new Set<string>(RUNTIME_CONTEXT_SEGMENT_CATEGORIES);
const kindSet = new Set<string>(RUNTIME_CONTEXT_SEGMENT_KINDS);

export function normalizeRuntimeContextSegmentCategory(
  value: unknown,
): RuntimeContextSegmentCategory {
  return typeof value === "string" && categorySet.has(value)
    ? value as RuntimeContextSegmentCategory
    : "other";
}

function assertText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertCount(value: unknown, field: string): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertKind(value: unknown): RuntimeContextSegmentKind {
  if (typeof value !== "string" || !kindSet.has(value)) {
    throw new TypeError(`Unknown runtime context segment kind: ${String(value)}`);
  }
  return value as RuntimeContextSegmentKind;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function addCount(current: number, value: number, field: string): number {
  const total = current + value;
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`${field} exceeds the maximum safe integer`);
  }
  return total;
}

function copySegment(
  input: RuntimeContextAccountingSegment,
): RuntimeContextAccountingSegment {
  const segment: RuntimeContextAccountingSegment = {
    id: assertText(input.id, "segment.id"),
    label: assertText(input.label, "segment.label"),
    category: normalizeRuntimeContextSegmentCategory(input.category),
    kind: assertKind(input.kind),
    tokens: assertCount(input.tokens, "segment.tokens"),
    ...(input.characters === undefined
      ? {}
      : { characters: assertCount(input.characters, "segment.characters") }),
    ...(input.items === undefined
      ? {}
      : { items: assertCount(input.items, "segment.items") }),
    ...(input.deferred === undefined
      ? {}
      : { deferred: assertBoolean(input.deferred, "segment.deferred") }),
  };
  return Object.freeze(segment);
}

export function createRuntimeContextAccounting(
  input: readonly RuntimeContextAccountingSegment[],
): RuntimeContextAccounting {
  if (!Array.isArray(input)) {
    throw new TypeError("Runtime context segments must be an array");
  }
  if (input.length > MAX_ACCOUNTING_SEGMENTS) {
    throw new RangeError(
      `Runtime context accounting supports at most ${MAX_ACCOUNTING_SEGMENTS} segments`,
    );
  }

  const ids = new Set<string>();
  const segments = input.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new TypeError("Each runtime context segment must be an object");
    }
    const segment = copySegment(candidate);
    if (ids.has(segment.id)) {
      throw new TypeError(`Duplicate runtime context segment id: ${segment.id}`);
    }
    ids.add(segment.id);
    return segment;
  });

  const categoryTotals = new Map<
    RuntimeContextSegmentCategory,
    { tokens: number; segments: number }
  >();
  let promptTokens = 0;
  let toolSchemaTokens = 0;
  let messageTokens = 0;
  let attachmentTokens = 0;
  let retrievalTokens = 0;

  for (const segment of segments) {
    const existing = categoryTotals.get(segment.category) ?? {
      tokens: 0,
      segments: 0,
    };
    existing.tokens = addCount(
      existing.tokens,
      segment.tokens,
      `category.${segment.category}.tokens`,
    );
    existing.segments += 1;
    categoryTotals.set(segment.category, existing);

    switch (segment.kind) {
      case "prompt":
        promptTokens = addCount(promptTokens, segment.tokens, "promptTokens");
        break;
      case "tool-schema":
        toolSchemaTokens = addCount(
          toolSchemaTokens,
          segment.tokens,
          "toolSchemaTokens",
        );
        break;
      case "message":
        messageTokens = addCount(messageTokens, segment.tokens, "messageTokens");
        break;
      case "attachment":
        attachmentTokens = addCount(
          attachmentTokens,
          segment.tokens,
          "attachmentTokens",
        );
        break;
      case "retrieval":
        retrievalTokens = addCount(
          retrievalTokens,
          segment.tokens,
          "retrievalTokens",
        );
        break;
    }
  }

  const categories: RuntimeContextCategoryAccounting[] = [];
  for (const category of RUNTIME_CONTEXT_SEGMENT_CATEGORIES) {
    const totals = categoryTotals.get(category);
    if (!totals) continue;
    categories.push(Object.freeze({
      category,
      tokens: totals.tokens,
      segments: totals.segments,
    }));
  }

  const totalTokens = [
    promptTokens,
    toolSchemaTokens,
    messageTokens,
    attachmentTokens,
    retrievalTokens,
  ].reduce(
    (total, value) => addCount(total, value, "totalTokens"),
    0,
  );

  return Object.freeze({
    version: RUNTIME_CONTEXT_ACCOUNTING_VERSION,
    segments: Object.freeze(segments),
    categories: Object.freeze(categories),
    totals: Object.freeze({
      promptTokens,
      toolSchemaTokens,
      messageTokens,
      attachmentTokens,
      retrievalTokens,
      totalTokens,
    }),
  });
}
