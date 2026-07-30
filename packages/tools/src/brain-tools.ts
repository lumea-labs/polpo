import { Type } from "@sinclair/typebox";
import {
  brainScopeKey,
  normalizeBrainScope,
  type BrainReadService,
  type BrainScope,
  type BrainServiceContext,
} from "@polpo-ai/core/brain";
import type { PolpoTool } from "@polpo-ai/core";

export const ALL_BRAIN_TOOL_NAMES = [
  "brain_search",
  "source_read",
] as const;

export type BrainToolName = (typeof ALL_BRAIN_TOOL_NAMES)[number];

const BrainSearchSchema = Type.Object({
  query: Type.String({
    minLength: 1,
    description: "What to find in the connected knowledge sources.",
  }),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 50,
    description: "Maximum number of matching chunks.",
  })),
  token_budget: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100_000,
    description: "Maximum approximate tokens returned across all matches.",
  })),
}, { additionalProperties: false });

const SourceReadSchema = Type.Object({
  source_id: Type.String({
    minLength: 1,
    description: "Source id returned by brain_search.",
  }),
  scope_kind: Type.Optional(Type.Union([
    Type.Literal("org"),
    Type.Literal("project"),
  ], {
    description: "Scope kind returned by brain_search. Required when multiple scopes are granted.",
  })),
  scope_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Scope id returned by brain_search. Required when multiple scopes are granted.",
  })),
  version: Type.Optional(Type.String({
    minLength: 1,
    description: "Exact source version from a citation. Defaults to the current version.",
  })),
  offset: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: 1_000_000,
    description: "Chunk offset for continued reads.",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100,
    description: "Maximum chunks to return.",
  })),
  token_budget: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 100_000,
    description: "Maximum approximate tokens returned.",
  })),
}, { additionalProperties: false });

function exactGrantedScope(
  context: BrainServiceContext,
  input: {
    readonly scope_kind?: "org" | "project";
    readonly scope_id?: string;
  },
): BrainScope {
  if ((input.scope_kind === undefined) !== (input.scope_id === undefined)) {
    throw new Error("scope_kind and scope_id must be provided together");
  }
  if (input.scope_kind && input.scope_id) {
    const requested = normalizeBrainScope({
      kind: input.scope_kind,
      subjectId: input.scope_id,
    });
    const key = brainScopeKey(requested);
    const granted = context.readScopes.find(
      (scope) => brainScopeKey(scope) === key,
    );
    if (!granted) throw new Error("Requested Brain scope is not granted");
    return granted;
  }
  if (context.readScopes.length !== 1) {
    throw new Error(
      "An exact Brain scope is required when multiple scopes are granted",
    );
  }
  return normalizeBrainScope(context.readScopes[0]);
}

function filtered(
  tools: PolpoTool<any>[],
  allowedTools?: readonly string[],
): PolpoTool<any>[] {
  if (!allowedTools) return tools;
  const allowed = new Set(allowedTools.map((name) => name.toLowerCase()));
  return tools.filter((tool) => allowed.has(tool.name));
}

export function createBrainTools(
  service: BrainReadService,
  context: BrainServiceContext,
  allowedTools?: readonly string[],
): PolpoTool<any>[] {
  const brainSearch: PolpoTool<typeof BrainSearchSchema> = {
    name: "brain_search",
    label: "Search Brain",
    description:
      "Search the knowledge sources granted to this agent. Returns scoped, " +
      "versioned citations that can be opened with source_read.",
    parameters: BrainSearchSchema,
    async execute(_toolCallId, params) {
      const results = await service.search(context, {
        query: params.query,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.token_budget === undefined
          ? {}
          : { tokenBudget: params.token_budget }),
      });
      const payload = {
        results: results.map((result) => ({
          content: result.chunk.content,
          score: result.score,
          scores: result.scores,
          trust: result.trust,
          source: {
            id: result.chunk.sourceId,
            scope: result.scope,
          },
          citation: result.chunk.citation,
        })),
        total: results.length,
      };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(payload, null, 2),
        }],
        details: payload,
      };
    },
  };

  const sourceRead: PolpoTool<typeof SourceReadSchema> = {
    name: "source_read",
    label: "Read Brain Source",
    description:
      "Read a granted Brain source by id and citation version. Use the exact " +
      "scope returned by brain_search when more than one scope is available.",
    parameters: SourceReadSchema,
    async execute(_toolCallId, params) {
      const scope = exactGrantedScope(context, params);
      const result = await service.readSource(context, {
        ref: {
          scope,
          sourceId: params.source_id,
        },
        ...(params.version === undefined ? {} : { version: params.version }),
        ...(params.offset === undefined ? {} : { offset: params.offset }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
        ...(params.token_budget === undefined
          ? {}
          : { tokenBudget: params.token_budget }),
      });
      const payload = {
        source: {
          id: result.source.id,
          scope: result.source.scope,
          label: result.source.label,
          trust: result.source.trust,
          version: result.version.version,
        },
        chunks: result.chunks.map((chunk) => ({
          index: chunk.index,
          content: chunk.content,
          citation: chunk.citation,
        })),
        ...(result.nextOffset === undefined
          ? {}
          : { next_offset: result.nextOffset }),
      };
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(payload, null, 2),
        }],
        details: payload,
      };
    },
  };

  return filtered([brainSearch, sourceRead], allowedTools);
}
