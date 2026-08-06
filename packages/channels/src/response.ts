import type { ChannelProviderId } from "./types.js";

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
): string[] {
  if (!text.trim()) return [];

  const hardLimit = HARD_LIMITS[provider];
  const softLimit = Math.min(SOFT_LIMITS[provider], hardLimit);
  if (text.length <= hardLimit) return [text];

  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > hardLimit) {
    const splitAt = findSemanticSplit(remaining, softLimit, hardLimit);
    const part = remaining.slice(0, splitAt);
    if (part) segments.push(part);
    remaining = remaining.slice(splitAt);
  }
  if (remaining) segments.push(remaining);
  return segments;
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
