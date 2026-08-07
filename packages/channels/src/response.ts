import type {
  ChannelProviderId,
  ChannelResponseDeliveryPolicy,
} from "./types.js";

const HARD_LIMITS: Record<ChannelProviderId, number> = {
  discord: 2_000,
  slack: 40_000,
  telegram: 4_096,
  whatsapp: 4_096,
};

const SOFT_LIMITS: Record<ChannelProviderId, number> = {
  discord: 1_850,
  slack: 8_000,
  telegram: 3_800,
  whatsapp: 3_800,
};

export function channelMessageHardLimit(provider: ChannelProviderId): number {
  return HARD_LIMITS[provider];
}

export function segmentChannelText(
  provider: ChannelProviderId,
  text: string,
  responseDelivery?: ChannelResponseDeliveryPolicy,
): string[] {
  if (!text.trim()) return [];

  const hardLimit = HARD_LIMITS[provider];
  const softLimit = Math.min(SOFT_LIMITS[provider], hardLimit);
  if (responseDelivery?.style !== "conversational") {
    return segmentWithLimits(text, softLimit, hardLimit);
  }

  const targetCharacters = Math.min(
    responseDelivery.targetCharacters ?? 900,
    softLimit,
  );
  const maxMessages = responseDelivery.maxMessages ?? 6;
  if (text.length <= targetCharacters) return [text];

  const segments: string[] = [];
  let remaining = text;
  const preferredMaximum = Math.min(
    hardLimit,
    Math.max(targetCharacters + 1, Math.floor(targetCharacters * 1.35)),
  );
  while (
    remaining.length > preferredMaximum
    && segments.length < maxMessages - 1
  ) {
    const splitAt = findSemanticSplit(
      remaining,
      targetCharacters,
      preferredMaximum,
    );
    const part = remaining.slice(0, splitAt);
    if (part) segments.push(part);
    remaining = remaining.slice(splitAt);
  }
  return [...segments, ...segmentWithLimits(remaining, softLimit, hardLimit)];
}

export function normalizeChannelResponseDeliveryPolicy(
  input: unknown,
): ChannelResponseDeliveryPolicy | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("responseDelivery must be an object");
  }
  const value = input as Record<string, unknown>;
  const style = value.style;
  if (style !== "single" && style !== "conversational") {
    throw new Error('responseDelivery.style must be "single" or "conversational"');
  }
  const targetCharacters = boundedInteger(
    value.targetCharacters,
    "responseDelivery.targetCharacters",
    200,
    4_000,
  );
  const maxMessages = boundedInteger(
    value.maxMessages,
    "responseDelivery.maxMessages",
    2,
    20,
  );
  if (
    style === "single"
    && (targetCharacters !== undefined || maxMessages !== undefined)
  ) {
    throw new Error(
      "responseDelivery targetCharacters and maxMessages are only valid for conversational style",
    );
  }
  return {
    style,
    ...(targetCharacters === undefined ? {} : { targetCharacters }),
    ...(maxMessages === undefined ? {} : { maxMessages }),
  };
}

function segmentWithLimits(
  text: string,
  softLimit: number,
  hardLimit: number,
): string[] {
  if (!text) return [];
  if (text.length <= hardLimit) return [text];
  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > hardLimit) {
    const splitAt = findSemanticSplit(remaining, softLimit, hardLimit);
    segments.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) segments.push(remaining);
  return segments;
}

function boundedInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function findSemanticSplit(text: string, softLimit: number, hardLimit: number): number {
  const window = text.slice(0, hardLimit + 1);
  const preferred = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "];

  for (const delimiter of preferred) {
    const index = window.lastIndexOf(delimiter, hardLimit);
    if (index >= softLimit) return index + delimiter.length;
  }

  // Prefer a coherent earlier boundary over a hard cut when no good split
  // exists in the ideal window. Avoid producing a tiny leading segment.
  const minimumUsefulLength = Math.floor(hardLimit * 0.35);
  for (const delimiter of preferred) {
    const index = window.lastIndexOf(delimiter, softLimit);
    if (index >= minimumUsefulLength) return index + delimiter.length;
  }

  return avoidSplittingSurrogatePair(text, hardLimit);
}

function avoidSplittingSurrogatePair(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  const splitsPair = before >= 0xd800 && before <= 0xdbff
    && after >= 0xdc00 && after <= 0xdfff;
  return splitsPair ? index - 1 : index;
}
