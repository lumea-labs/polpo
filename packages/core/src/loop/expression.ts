/**
 * SafeExpressionEvaluator — a tiny, SANDBOXED condition evaluator for the
 * declarative config surface (approval gates, and the upcoming loop/pipeline
 * routers). NO `eval`/`new Function`/globals: a recursive-descent parser over a
 * restricted grammar, so a tenant-authored expression can only read fields of
 * the supplied context and combine them with comparisons/boolean logic — it can
 * never reach `process`, call functions, or execute arbitrary code.
 *
 * Grammar (precedence low→high):
 *   or   := and ('||' and)*
 *   and  := cmp ('&&' cmp)*
 *   cmp  := unary (('==='|'!=='|'=='|'!='|'>='|'<='|'>'|'<') unary)?
 *   unary:= '!' unary | primary
 *   prim := '(' or ')' | number | 'string' | "string" | true | false | null | path
 * path: a.b.c → looked up in the context (missing → undefined).
 */

type Tok = { t: "num" | "str" | "id" | "op" | "punc"; v: string };

// Longest operators first so `===` matches before `==`.
const OPS = ["===", "!==", "==", "!=", ">=", "<=", "&&", "||", ">", "<", "!"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ t: "punc", v: c });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }
    throw new Error(`Unexpected character "${c}" at ${i}`);
  }
  return out;
}

function lookup(path: string, ctx: Record<string, unknown>): unknown {
  if (path === "true") return true;
  if (path === "false") return false;
  if (path === "null") return null;
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  if (op === "===") return a === b;
  if (op === "!==") return a !== b;
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  const numeric = !Number.isNaN(an) && !Number.isNaN(bn) && a !== "" && b !== "" && a != null && b != null;
  // null/undefined treated as equal ("not set"), so `x == null` works as expected.
  const nullish = (v: unknown) => v === null || v === undefined;
  // Ordering against null/undefined is never true (can't order "not set").
  if ((op === ">" || op === "<" || op === ">=" || op === "<=") && (nullish(a) || nullish(b))) return false;
  const eq = nullish(a) || nullish(b) ? nullish(a) && nullish(b) : a === b || (numeric ? an === bn : String(a) === String(b));
  switch (op) {
    case "==":
      return eq;
    case "!=":
      return !eq;
    case ">":
      return numeric ? an > bn : String(a) > String(b);
    case "<":
      return numeric ? an < bn : String(a) < String(b);
    case ">=":
      return numeric ? an >= bn : String(a) >= String(b);
    case "<=":
      return numeric ? an <= bn : String(a) <= String(b);
    default:
      return false;
  }
}

class Parser {
  private p = 0;
  constructor(
    private toks: Tok[],
    private ctx: Record<string, unknown>,
  ) {}
  private peek() {
    return this.toks[this.p];
  }
  private eat() {
    return this.toks[this.p++];
  }
  parse(): unknown {
    const v = this.or();
    if (this.p < this.toks.length) throw new Error("Trailing tokens");
    return v;
  }
  private or(): unknown {
    let l = this.and();
    while (this.peek()?.v === "||") {
      this.eat();
      l = Boolean(l) || Boolean(this.and());
    }
    return l;
  }
  private and(): unknown {
    let l = this.cmp();
    while (this.peek()?.v === "&&") {
      this.eat();
      l = Boolean(l) && Boolean(this.cmp());
    }
    return l;
  }
  private cmp(): unknown {
    const l = this.unary();
    const op = this.peek();
    if (op?.t === "op" && ["===", "!==", "==", "!=", ">", "<", ">=", "<="].includes(op.v)) {
      this.eat();
      return compare(op.v, l, this.unary());
    }
    return l;
  }
  private unary(): unknown {
    if (this.peek()?.v === "!") {
      this.eat();
      return !this.unary();
    }
    return this.primary();
  }
  private primary(): unknown {
    const tok = this.eat();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.t === "punc" && tok.v === "(") {
      const v = this.or();
      if (this.eat()?.v !== ")") throw new Error("Expected )");
      return v;
    }
    if (tok.t === "num") return Number(tok.v);
    if (tok.t === "str") return tok.v;
    if (tok.t === "id") return lookup(tok.v, this.ctx);
    throw new Error(`Unexpected token "${tok.v}"`);
  }
}

/**
 * Evaluate a condition expression against a context object, returning a boolean.
 * Throws on a malformed expression. An empty/absent expression is `true`.
 */
export function evaluateExpression(expression: string | undefined, ctx: Record<string, unknown>): boolean {
  if (!expression || !expression.trim()) return true;
  return Boolean(new Parser(tokenize(expression), ctx).parse());
}

/**
 * Class wrapper. `evaluate` never throws — a malformed expression returns
 * `false` (safe default), matching how condition gates fail closed.
 */
export class SafeExpressionEvaluator {
  evaluate(expression: string | undefined, ctx: Record<string, unknown>): boolean {
    try {
      return evaluateExpression(expression, ctx);
    } catch {
      return false;
    }
  }
}
