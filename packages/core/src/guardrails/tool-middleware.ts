import type { RuntimeGuardrailDecision } from "../runtime-plan/types.js";
import {
  GuardrailAbortedError,
  GuardrailApprovalRequiredError,
  GuardrailBlockedError,
} from "./errors.js";
import { RuntimeGuardrailEngine } from "./engine.js";
import type {
  RunToolExecutionResult,
  RunToolMiddleware,
  RunToolMiddlewareOptions,
  RunToolNext,
  RunToolRequest,
  RuntimeToolSideEffect,
} from "./types.js";

const DEFAULT_MAX_OUTPUT_CHARACTERS = 256_000;

function freezeArgs(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GuardrailBlockedError("Guardrail rewrote tool arguments to a non-object value");
  }
  return value as Readonly<Record<string, unknown>>;
}

function normalizeOutput(
  output: string,
  maxCharacters: number,
): { output: string; truncated: boolean } {
  const normalized = output.replace(/\r\n?/g, "\n");
  if (normalized.length <= maxCharacters) return { output: normalized, truncated: false };
  let bounded = normalized.slice(0, maxCharacters);
  const finalCode = bounded.charCodeAt(bounded.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) bounded = bounded.slice(0, -1);
  return { output: `${bounded}\n[TRUNCATED]`, truncated: true };
}

function terminalDecision(
  decisions: readonly RuntimeGuardrailDecision[],
): RuntimeGuardrailDecision {
  return decisions[decisions.length - 1]!;
}

export function inferToolSideEffect(name: string): RuntimeToolSideEffect {
  const normalized = name.trim().toLowerCase().replace(/^mcp__[^_]+__/, "");
  if (
    /^(get|list|read|search|find|inspect|describe|query|fetch|download|view|stat|check|lookup|count)(_|$)/.test(normalized)
  ) {
    return "read";
  }
  if (
    /^(create|add|set|update|edit|write|delete|remove|send|deploy|publish|run|execute|bash|shell|upload|move|copy|rename|approve|reject)(_|$)/.test(normalized)
  ) {
    return "write";
  }
  return "unknown";
}

export function createRunToolMiddleware(
  engine: RuntimeGuardrailEngine,
  options: RunToolMiddlewareOptions = {},
): RunToolMiddleware {
  const maxOutputCharacters = options.maxOutputCharacters ?? DEFAULT_MAX_OUTPUT_CHARACTERS;
  if (!Number.isSafeInteger(maxOutputCharacters) || maxOutputCharacters < 1) {
    throw new TypeError("maxOutputCharacters must be a positive safe integer");
  }

  return {
    async execute(
      request: RunToolRequest,
      next: RunToolNext,
    ): Promise<RunToolExecutionResult> {
      if (request.signal?.aborted) throw new GuardrailAbortedError();
      const normalizedRequest = Object.freeze({
        ...request,
        sideEffect: request.sideEffect ?? inferToolSideEffect(request.name),
      });
      const before = await engine.evaluate({
        phase: "tool.before",
        value: request.args,
        context: request.context,
        tool: {
          name: request.name,
          callId: request.callId,
          sideEffect: normalizedRequest.sideEffect,
          schema: request.schema,
        },
        signal: request.signal,
      });
      const args = freezeArgs(before.value);

      if (before.terminalAction === "block") {
        throw new GuardrailBlockedError(
          terminalDecision(before.decisions).reason,
          before.decisions,
        );
      }
      if (before.terminalAction === "approval") {
        const decision = terminalDecision(before.decisions);
        if (!options.approval) {
          throw new GuardrailApprovalRequiredError(decision.reason, before.decisions);
        }
        const approval = await options.approval(
          Object.freeze({ ...normalizedRequest, args }),
          decision,
        );
        if (request.signal?.aborted) {
          throw new GuardrailAbortedError(undefined, before.decisions);
        }
        if (approval !== "approved") {
          throw new GuardrailBlockedError("Guardrail approval was denied", before.decisions);
        }
      }

      const toolRequest = Object.freeze({ ...normalizedRequest, args });
      const rawOutput = await next(toolRequest);
      if (typeof rawOutput !== "string") {
        throw new TypeError(`Tool "${request.name}" returned a non-string result`);
      }
      if (request.signal?.aborted) {
        throw new GuardrailAbortedError(
          "Tool execution was aborted after dispatch; the outcome may be uncertain",
          before.decisions,
          normalizedRequest.sideEffect !== "read",
        );
      }

      const bounded = normalizeOutput(rawOutput, maxOutputCharacters);
      const after = await engine.evaluate({
        phase: "tool.after",
        value: bounded.output,
        context: request.context,
        tool: {
          name: request.name,
          callId: request.callId,
          sideEffect: normalizedRequest.sideEffect,
          schema: request.schema,
        },
        signal: request.signal,
        outputTruncated: bounded.truncated,
      });
      const decisions = Object.freeze([...before.decisions, ...after.decisions]);
      if (after.terminalAction === "block") {
        throw new GuardrailBlockedError(
          terminalDecision(after.decisions).reason,
          decisions,
        );
      }
      if (after.terminalAction === "approval") {
        throw new GuardrailApprovalRequiredError(
          "Approval cannot be deferred until after a tool has executed",
          decisions,
        );
      }
      if (typeof after.value !== "string") {
        throw new GuardrailBlockedError(
          "Guardrail rewrote tool output to a non-string value",
          decisions,
        );
      }

      return Object.freeze({
        output: after.value,
        args,
        decisions,
        outputTruncated: bounded.truncated,
      });
    },
  };
}

export function wrapRunToolExecutor(
  executor: (name: string, args: Record<string, unknown>) => Promise<string>,
  middleware: RunToolMiddleware | undefined,
  resolveRequest: (
    name: string,
    args: Record<string, unknown>,
  ) => Omit<RunToolRequest, "name" | "args"> & Partial<Pick<RunToolRequest, "name" | "args">>,
): (name: string, args: Record<string, unknown>) => Promise<string> {
  if (!middleware) return executor;
  return async (name, args) => {
    const request = resolveRequest(name, args);
    const result = await middleware.execute(
      {
        ...request,
        name: request.name ?? name,
        args: request.args ?? args,
      },
      (nextRequest) => executor(nextRequest.name, nextRequest.args as Record<string, unknown>),
    );
    return result.output;
  };
}
