import { jsonSchema } from "ai";

type RequestClientTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
};

type RequestToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

type ModelToolCall = {
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
};

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export class RequestClientToolError extends Error {
  readonly code: "tool_name_conflict" | "parallel_client_tool_calls_returned";
  readonly toolName?: string;

  constructor(
    code: RequestClientToolError["code"],
    message: string,
    toolName?: string,
  ) {
    super(message);
    this.name = "RequestClientToolError";
    this.code = code;
    this.toolName = toolName;
  }
}

/**
 * Convert request-declared OpenAI function tools into AI SDK tools without an
 * execute handler. They can be selected by the model and returned to the
 * caller, but can never cross the server execution boundary.
 */
export function createRequestClientTools(
  tools: RequestClientTool[] | undefined,
): Record<string, { description?: string; strict?: boolean; inputSchema: ReturnType<typeof jsonSchema> }> {
  return Object.fromEntries((tools ?? []).map((tool) => [
    tool.function.name,
    {
      ...(tool.function.description ? { description: tool.function.description } : {}),
      ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
      inputSchema: jsonSchema(tool.function.parameters ?? EMPTY_PARAMETERS),
    },
  ]));
}

export function assertRequestClientToolNamesAvailable(
  requestTools: RequestClientTool[] | undefined,
  occupiedNames: Iterable<string>,
): void {
  const occupied = new Set(
    [...occupiedNames].map((name) => name.toLocaleLowerCase("en-US")),
  );
  for (const tool of requestTools ?? []) {
    const name = tool.function.name;
    if (!occupied.has(name.toLocaleLowerCase("en-US"))) continue;
    throw new RequestClientToolError(
      "tool_name_conflict",
      `Request tool name conflicts with an effective runtime tool: ${name}`,
      name,
    );
  }
}

export function requestToolChoiceToAI(
  choice: RequestToolChoice | undefined,
): unknown | undefined {
  if (choice === undefined || typeof choice === "string") return choice;
  return { type: "tool", toolName: choice.function.name };
}

/**
 * A request-scoped client tool ends the server turn. Executing any sibling
 * call before returning would make the result order-dependent, so mixed or
 * parallel calls fail before a server tool is dispatched.
 */
export function selectRequestClientToolCall<T extends ModelToolCall>(
  calls: T[],
  clientToolNames: ReadonlySet<string>,
): T | undefined {
  const clientCalls = calls.filter(
    (call) => typeof call.toolName === "string" && clientToolNames.has(call.toolName),
  );
  if (clientCalls.length === 0) return undefined;
  if (calls.length !== 1 || clientCalls.length !== 1) {
    throw new RequestClientToolError(
      "parallel_client_tool_calls_returned",
      "A client-side tool call cannot be combined with another tool call in the same turn",
    );
  }
  return clientCalls[0];
}
