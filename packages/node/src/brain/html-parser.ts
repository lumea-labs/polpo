import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  BrainStoreValidationError,
  type BrainParser,
  type BrainParserInput,
  type BrainParserResult,
} from "@polpo-ai/core/brain";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

const IGNORED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
]);
const BLOCK_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tr",
  "ul",
]);

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node && typeof node.tagName === "string";
}

function isHidden(element: HtmlElement): boolean {
  return element.attrs.some((attribute) => (
    attribute.name === "hidden"
    || (
      attribute.name === "aria-hidden"
      && attribute.value.trim().toLowerCase() === "true"
    )
  ));
}

function collectText(
  node: HtmlNode,
  output: string[],
  options: { readonly includeTitle: boolean },
): void {
  if (isElement(node)) {
    const tag = node.tagName.toLowerCase();
    if (
      IGNORED_ELEMENTS.has(tag)
      || isHidden(node)
      || (!options.includeTitle && tag === "title")
    ) {
      return;
    }
    if (BLOCK_ELEMENTS.has(tag)) output.push("\n");
    for (const child of node.childNodes) collectText(child, output, options);
    if (BLOCK_ELEMENTS.has(tag)) output.push("\n");
    return;
  }
  if ("value" in node && typeof node.value === "string") {
    output.push(node.value);
    return;
  }
  if ("childNodes" in node) {
    for (const child of node.childNodes) collectText(child, output, options);
  }
}

function normalizedText(parts: readonly string[]): string {
  return parts
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function findTitle(node: HtmlNode): string | undefined {
  if (isElement(node) && node.tagName.toLowerCase() === "title") {
    const output: string[] = [];
    collectText(node, output, { includeTitle: true });
    return normalizedText(output) || undefined;
  }
  if ("childNodes" in node) {
    for (const child of node.childNodes) {
      const title = findTitle(child);
      if (title) return title;
    }
  }
  return undefined;
}

export class HtmlBrainParser implements BrainParser {
  supports(contentType: string | undefined): boolean {
    const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    return normalized === "text/html" || normalized === "application/xhtml+xml";
  }

  async parse(input: BrainParserInput): Promise<BrainParserResult> {
    if (!this.supports(input.contentType)) {
      throw new BrainStoreValidationError(
        `Unsupported HTML content type: ${String(input.contentType)}`,
      );
    }
    let html: string;
    if (input.body.kind === "text") {
      html = input.body.text;
    } else {
      try {
        html = new TextDecoder("utf-8", { fatal: true }).decode(input.body.bytes);
      } catch (error) {
        throw new BrainStoreValidationError(
          `Brain HTML is not valid UTF-8: ${
            error instanceof Error ? error.message : "decode failed"
          }`,
        );
      }
    }
    const document = parse(html);
    const output: string[] = [];
    collectText(document, output, { includeTitle: false });
    const content = normalizedText(output);
    const title = findTitle(document);
    return Object.freeze({
      sections: content
        ? Object.freeze([Object.freeze({
            content,
            ...(title ? { locator: title } : {}),
          })])
        : Object.freeze([]),
    });
  }
}
