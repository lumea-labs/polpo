import { BrainStoreValidationError } from "./store-errors.js";
import type { BrainParser } from "./ports.js";
import type { BrainParserInput, BrainParserResult } from "./types.js";

const SUPPORTED_TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
]);

function baseContentType(value: string | undefined): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function decodeBody(input: BrainParserInput): string {
  if (input.body.kind === "text") return input.body.text;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.body.bytes);
  } catch (error) {
    throw new BrainStoreValidationError(
      `Brain content is not valid UTF-8: ${
        error instanceof Error ? error.message : "decode failed"
      }`,
    );
  }
}

export class PlainTextBrainParser implements BrainParser {
  supports(contentType: string | undefined): boolean {
    const normalized = baseContentType(contentType);
    return normalized === undefined || SUPPORTED_TEXT_TYPES.has(normalized);
  }

  async parse(input: BrainParserInput): Promise<BrainParserResult> {
    if (!this.supports(input.contentType)) {
      throw new BrainStoreValidationError(
        `Unsupported text content type: ${String(input.contentType)}`,
      );
    }
    const contentType = baseContentType(input.contentType);
    let text = decodeBody(input);
    if (contentType === "application/json") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        throw new BrainStoreValidationError("Brain JSON content is malformed");
      }
    }
    text = text.replace(/\r\n?/g, "\n").trim();
    return Object.freeze({
      sections: text
        ? Object.freeze([Object.freeze({ content: text })])
        : Object.freeze([]),
    });
  }
}
