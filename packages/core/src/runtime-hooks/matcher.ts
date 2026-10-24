import { HOOK_EVENTS, type HookEventName } from "./events.js";

/** A compiled matcher: returns true when the group applies to a subject value. */
export type CompiledHookMatcher = (subject: string | undefined) => boolean;

const STANDARD_EXACT = /^[A-Za-z0-9_\- ,|]+$/;
const NARROW_EXACT = /^[A-Za-z0-9_|]+$/;
/** Longest subject a regex matcher is evaluated against; bounds hostile input. */
const MAX_SUBJECT_CHARS = 4_096;

const MATCH_ALL: CompiledHookMatcher = () => true;

/**
 * Compile a matcher with the reference rules:
 * - omitted, `""` or `"*"` matches every occurrence;
 * - only letters, digits, `_`, `-`, spaces, `,` and `|` → exact string or
 *   list of exact strings split on `|` or `,` (surrounding whitespace ignored);
 *   FileChanged and StopFailure use the narrower letters/digits/`_`/`|` set;
 * - anything else → unanchored JavaScript regular expression (`RegExp.test`).
 *
 * A named matcher never matches an absent or empty subject; a regex runs
 * against `""` so a pattern that matches the empty string still fires.
 * Throws when the regular expression is invalid.
 */
export function compileHookMatcher(event: HookEventName, matcher: string | undefined): CompiledHookMatcher {
  const kind = HOOK_EVENTS[event].matcher;
  if (kind === "none") return MATCH_ALL;
  if (matcher === undefined || matcher === "" || matcher === "*") return MATCH_ALL;

  const exact = kind === "narrow" ? NARROW_EXACT : STANDARD_EXACT;
  if (exact.test(matcher)) {
    const separator = kind === "narrow" ? /\|/ : /[|,]/;
    const names = new Set(matcher.split(separator).map((name) => name.trim()).filter(Boolean));
    return (subject) => subject !== undefined && subject !== "" && names.has(subject);
  }

  assertLinearRegex(matcher);
  const expression = new RegExp(matcher);
  return (subject) => expression.test((subject ?? "").slice(0, MAX_SUBJECT_CHARS));
}

/**
 * FileChanged watch list: the matcher is split on `|` and each segment is a
 * literal filename relative to the working directory, regex or not. An omitted
 * matcher adds nothing; `"*"` registers a file literally named `*`.
 */
export function fileChangedWatchNames(matcher: string | undefined): string[] {
  if (matcher === undefined || matcher === "") return [];
  return matcher.split("|").map((name) => name.trim()).filter(Boolean);
}

/**
 * Reject nested quantifiers (star height > 1), the shape behind catastrophic
 * backtracking such as `(a+)+$`. Hook matchers run on the shared runtime
 * thread; a tenant must not be able to stall it with one pattern. Patterns a
 * real tool/agent/model matcher needs (`mcp__.*__write.*`, `^Edit$`) pass.
 */
export function assertLinearRegex(pattern: string): void {
  const groups: boolean[] = [];
  let inClass = false;
  let lastWasGroupWithQuantifier = false;
  let quantifiedInCurrent = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") { i++; lastWasGroupWithQuantifier = false; continue; }
    if (inClass) { if (char === "]") inClass = false; continue; }
    if (char === "[") { inClass = true; lastWasGroupWithQuantifier = false; continue; }
    if (char === "(") {
      groups.push(quantifiedInCurrent);
      quantifiedInCurrent = false;
      lastWasGroupWithQuantifier = false;
      continue;
    }
    if (char === ")") {
      const inner = quantifiedInCurrent;
      quantifiedInCurrent = groups.pop() ?? false;
      lastWasGroupWithQuantifier = inner;
      if (inner) quantifiedInCurrent = true;
      continue;
    }
    const quantifier = char === "*" || char === "+" || (char === "{" && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)));
    if (quantifier) {
      if (lastWasGroupWithQuantifier) {
        throw new Error("nested quantifiers can cause catastrophic backtracking");
      }
      quantifiedInCurrent = true;
    }
    lastWasGroupWithQuantifier = false;
  }
}
