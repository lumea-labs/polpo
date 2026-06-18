import ts from "typescript";
import {
  agentStep,
  bash,
  defineLoop,
  defineProjectLoop,
  humanStep,
  otherwise,
  parallelStep,
  permission,
  policy,
  requireTool,
  toolAction,
  toolStep,
  when,
  type ProjectLoopConfig,
} from "@polpo-ai/core";

export class LoopDslCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopDslCompileError";
  }
}

type JsonObject = Record<string, unknown>;

const CALLS: Record<string, (...args: unknown[]) => unknown> = {
  defineLoop: (loop) => defineLoop(asObject(loop, "defineLoop argument") as unknown as ProjectLoopConfig),
  defineProjectLoop: (loop) =>
    defineProjectLoop(asObject(loop, "defineProjectLoop argument") as unknown as ProjectLoopConfig),
  agentStep: (step) => agentStep(asObject(step, "agentStep argument") as any),
  toolStep: (step) => toolStep(asObject(step, "toolStep argument") as any),
  humanStep: (step) => humanStep(asObject(step, "humanStep argument") as any),
  parallelStep: (step) => parallelStep(asObject(step, "parallelStep argument") as any),
  when: (expression, to) => when(asString(expression, "when expression"), asString(to, "when target")),
  otherwise: (to) => otherwise(asString(to, "otherwise target")),
  requireTool: (tool) => requireTool(asString(tool, "required tool")),
  toolAction: (tool, input, options) =>
    toolAction(asString(tool, "toolAction tool"), input, options === undefined ? {} : asObject(options, "toolAction options") as any),
  bash: (command, options) =>
    bash(asString(command, "bash command"), options === undefined ? {} : asObject(options, "bash options") as any),
  permission: (config) => permission(asObject(config, "permission argument") as any),
  policy: (config) => policy(asObject(config, "policy argument") as any),
};

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LoopDslCompileError(`${label} must be an object literal.`);
  }
  return value as JsonObject;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LoopDslCompileError(`${label} must be a non-empty string literal.`);
  }
  return value;
}

function propertyName(name: ts.PropertyName, source: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw errorAt(source, name, "Computed property names are not supported in loop DSL source.");
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function errorAt(source: ts.SourceFile, node: ts.Node, message: string): LoopDslCompileError {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return new LoopDslCompileError(`${message} (${source.fileName}:${line + 1}:${character + 1})`);
}

function expressionToValue(expression: ts.Expression, source: ts.SourceFile): unknown {
  const expr = unwrap(expression);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return undefined;

  if (ts.isPrefixUnaryExpression(expr)) {
    const value = expressionToValue(expr.operand, source);
    if (typeof value !== "number") throw errorAt(source, expr, "Unary operators are only supported for number literals.");
    if (expr.operator === ts.SyntaxKind.MinusToken) return -value;
    if (expr.operator === ts.SyntaxKind.PlusToken) return value;
    throw errorAt(source, expr, "Unsupported unary operator in loop DSL source.");
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((item) => expressionToValue(item, source)).filter((value) => value !== undefined);
  }

  if (ts.isObjectLiteralExpression(expr)) {
    const out: JsonObject = {};
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property)) {
        const value = expressionToValue(property.initializer, source);
        if (value !== undefined) out[propertyName(property.name, source)] = value;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        throw errorAt(source, property, "Shorthand properties are not supported in loop DSL source.");
      }
      if (ts.isSpreadAssignment(property)) {
        throw errorAt(source, property, "Spread properties are not supported in loop DSL source.");
      }
      throw errorAt(source, property, "Only plain object properties are supported in loop DSL source.");
    }
    return out;
  }

  if (ts.isCallExpression(expr)) {
    const name = callName(expr.expression);
    if (!name || !CALLS[name]) {
      throw errorAt(source, expr, "Only Polpo loop DSL helper calls are supported.");
    }
    return CALLS[name](...expr.arguments.map((arg) => expressionToValue(arg, source)));
  }

  throw errorAt(source, expr, "Unsupported expression in loop DSL source.");
}

function readDefaultExport(source: ts.SourceFile): ts.Expression {
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
  }
  throw new LoopDslCompileError("Loop DSL source must default-export defineLoop({...}) or a loop object.");
}

export function compileLoopSource(sourceText: string, fileName = "loop.ts"): ProjectLoopConfig {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    const position = first.start === undefined ? "" : ` at ${fileName}:${source.getLineAndCharacterOfPosition(first.start).line + 1}`;
    throw new LoopDslCompileError(`Invalid TypeScript loop DSL source${position}: ${message}`);
  }

  const exported = expressionToValue(readDefaultExport(source), source);
  return defineProjectLoop(asObject(exported, "default export") as unknown as ProjectLoopConfig);
}
