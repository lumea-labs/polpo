import { nanoid } from "nanoid";
import { createBrainChunk } from "./contracts.js";
import { BrainStoreValidationError } from "./store-errors.js";
import type {
  BrainChunk,
  BrainParsedSection,
  BrainSource,
} from "./types.js";

export const DEFAULT_BRAIN_CHUNK_CHARACTERS = 1_600;
export const DEFAULT_BRAIN_CHUNK_OVERLAP_CHARACTERS = 220;

export interface ChunkBrainSectionsInput {
  readonly source: BrainSource;
  readonly version: string;
  readonly sections: readonly BrainParsedSection[];
  readonly maxCharacters?: number;
  readonly overlapCharacters?: number;
  readonly createId?: () => string;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BrainStoreValidationError(`${name} must be a positive integer`);
  }
  return value;
}

function splitSection(
  content: string,
  maxCharacters: number,
  overlapCharacters: number,
): string[] {
  const normalized = content
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + maxCharacters, normalized.length);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const minimumSoftBreak = start + Math.floor(maxCharacters * 0.55);
      const candidates = [
        normalized.lastIndexOf("\n\n", hardEnd),
        normalized.lastIndexOf(". ", hardEnd),
        normalized.lastIndexOf("\n", hardEnd),
        normalized.lastIndexOf(" ", hardEnd),
      ].filter((candidate) => candidate >= minimumSoftBreak);
      if (candidates.length > 0) {
        end = Math.max(...candidates);
        if (normalized.slice(end, end + 2) === ". ") end += 1;
      }
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    const next = end - overlapCharacters;
    start = Math.max(start + 1, next);
  }
  return chunks;
}

export function chunkBrainSections(
  input: ChunkBrainSectionsInput,
): BrainChunk[] {
  const maxCharacters = positiveInteger(
    input.maxCharacters ?? DEFAULT_BRAIN_CHUNK_CHARACTERS,
    "maxCharacters",
  );
  const overlapCharacters = input.overlapCharacters
    ?? DEFAULT_BRAIN_CHUNK_OVERLAP_CHARACTERS;
  if (
    !Number.isSafeInteger(overlapCharacters)
    || overlapCharacters < 0
    || overlapCharacters >= maxCharacters
  ) {
    throw new BrainStoreValidationError(
      "overlapCharacters must be a non-negative integer smaller than maxCharacters",
    );
  }
  if (!Array.isArray(input.sections)) {
    throw new BrainStoreValidationError("sections must be an array");
  }
  const uri = typeof input.source.metadata.uri === "string"
    ? input.source.metadata.uri
    : undefined;
  const chunks: BrainChunk[] = [];
  for (const section of input.sections) {
    if (!section || typeof section.content !== "string") {
      throw new BrainStoreValidationError(
        "Every parsed section must contain text",
      );
    }
    const pieces = splitSection(
      section.content,
      maxCharacters,
      overlapCharacters,
    );
    for (const [pieceIndex, content] of pieces.entries()) {
      const id = input.createId?.() ?? `brain-chunk-${nanoid(16)}`;
      const locator = section.locator
        ? `${section.locator} · chunk ${pieceIndex + 1}`
        : `chunk ${chunks.length + 1}`;
      chunks.push(createBrainChunk({
        id,
        sourceId: input.source.id,
        version: input.version,
        index: chunks.length,
        content,
        citation: {
          sourceId: input.source.id,
          version: input.version,
          chunkId: id,
          label: input.source.label,
          ...(uri ? { uri } : {}),
          locator,
          capturedAt: input.source.updatedAt,
        },
        tokenCount: Math.max(1, Math.ceil(content.length / 4)),
        metadata: section.metadata
          ? { ...input.source.metadata, ...section.metadata }
          : { ...input.source.metadata },
      }));
    }
  }
  return chunks;
}
