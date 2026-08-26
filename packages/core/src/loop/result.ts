import { resolveLoopInputBindings } from "./bindings.js";
import type {
  ContextBag,
  LoopPresentation,
  LoopPresentationAction,
  ProjectLoopResultConfig,
} from "./types.js";

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_ACTIONS = 10;
const MAX_ACTION_LABEL_LENGTH = 80;
const MAX_POSTBACK_VALUE_LENGTH = 2_000;
const MAX_PRESENTATION_TEXT_LENGTH = 100_000;

export class LoopResultProjectionError extends Error {
  readonly code = "loop_result_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "LoopResultProjectionError";
  }
}

export type PreparedProjectLoopResult = Readonly<{
  data?: unknown;
  presentation?: LoopPresentation;
}>;

export function prepareProjectLoopResult(
  config: ProjectLoopResultConfig | undefined,
  context: Readonly<ContextBag>,
): PreparedProjectLoopResult {
  if (!config) return Object.freeze({});
  const data = config.data === undefined
    ? undefined
    : resolveLoopInputBindings(config.data, context);
  const presentation = config.presentation === undefined
    ? undefined
    : preparePresentation(config.presentation, context);
  return Object.freeze({
    ...(data === undefined ? {} : { data }),
    ...(presentation === undefined ? {} : { presentation }),
  });
}

function preparePresentation(
  input: NonNullable<ProjectLoopResultConfig["presentation"]>,
  context: Readonly<ContextBag>,
): LoopPresentation {
  const resolvedText = resolveLoopInputBindings(input.text, context);
  if (typeof resolvedText !== "string" || !resolvedText.trim()) {
    throw invalid("Loop result presentation.text must resolve to a non-empty string");
  }
  if (resolvedText.length > MAX_PRESENTATION_TEXT_LENGTH) {
    throw invalid(
      `Loop result presentation.text exceeds ${MAX_PRESENTATION_TEXT_LENGTH} characters`,
    );
  }
  const resolvedActions = input.actions === undefined
    ? undefined
    : resolveLoopInputBindings(input.actions, context);
  return Object.freeze({
    text: resolvedText,
    ...(resolvedActions === undefined
      ? {}
      : { actions: Object.freeze(normalizeActions(resolvedActions)) }),
  });
}

function normalizeActions(value: unknown): LoopPresentationAction[] {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) {
    throw invalid(`Loop result presentation.actions must be an array of at most ${MAX_ACTIONS} actions`);
  }
  return value.map((candidate, index) => normalizeAction(candidate, index));
}

function normalizeAction(value: unknown, index: number): LoopPresentationAction {
  if (!isPlainRecord(value)) {
    throw invalid(`Loop result presentation.actions[${index}] must be an object`);
  }
  const type = value.type;
  const allowed = type === "open_url"
    ? new Set(["id", "label", "type", "url"])
    : type === "postback"
      ? new Set(["id", "label", "type", "value"])
      : null;
  if (!allowed) {
    throw invalid(`Loop result presentation.actions[${index}].type is invalid`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw invalid(`Loop result presentation.actions[${index}] contains unsupported field "${unknown}"`);
  }
  const id = requiredString(value.id, `presentation.actions[${index}].id`, 64);
  if (!ACTION_ID.test(id)) {
    throw invalid(`Loop result presentation.actions[${index}].id is invalid`);
  }
  const label = requiredString(
    value.label,
    `presentation.actions[${index}].label`,
    MAX_ACTION_LABEL_LENGTH,
  );
  if (type === "open_url") {
    const url = requiredString(value.url, `presentation.actions[${index}].url`, 2_048);
    assertSafeActionUrl(url, index);
    return Object.freeze({ id, label, type, url });
  }
  const postback = requiredString(
    value.value,
    `presentation.actions[${index}].value`,
    MAX_POSTBACK_VALUE_LENGTH,
  );
  return Object.freeze({ id, label, type: "postback", value: postback });
}

function assertSafeActionUrl(value: string, index: number): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid(`Loop result presentation.actions[${index}].url is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw invalid(
      `Loop result presentation.actions[${index}].url must be an HTTPS URL without credentials`,
    );
  }
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw invalid(`Loop result ${label} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): LoopResultProjectionError {
  return new LoopResultProjectionError(message);
}
