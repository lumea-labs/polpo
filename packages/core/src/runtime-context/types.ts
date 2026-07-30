import type {
  RuntimeInvocationSource,
  RuntimeSurface,
} from "../runtime-plan/index.js";
import type { RuntimeGuardrailDecision } from "../runtime-plan/types.js";

export const RUNTIME_CONTEXT_SEGMENT_KINDS = ["memory", "brain"] as const;
export type RuntimeContextSegmentKind =
  (typeof RUNTIME_CONTEXT_SEGMENT_KINDS)[number];

export const RUNTIME_CONTEXT_TRUST_LEVELS = [
  "trusted",
  "user_provided",
  "external",
  "untrusted",
] as const;
export type RuntimeContextTrust =
  (typeof RUNTIME_CONTEXT_TRUST_LEVELS)[number];

export interface RuntimeContextSource {
  readonly type: RuntimeContextSegmentKind;
  readonly id: string;
  readonly label?: string;
  readonly reference?: string;
}

export interface RuntimeContextCitation {
  readonly handle: string;
  readonly sourceId: string;
  readonly version: string;
  readonly uri?: string;
  readonly label?: string;
}

export interface RuntimeContextEntry {
  readonly id: string;
  readonly content: string;
  readonly source: RuntimeContextSource;
  readonly timestamp: string;
  readonly version?: string;
  readonly trust: RuntimeContextTrust;
  readonly citation?: RuntimeContextCitation;
  readonly score?: number;
  readonly estimatedTokens?: number;
}

export interface RuntimeContextSegment {
  readonly kind: RuntimeContextSegmentKind;
  readonly entries: readonly RuntimeContextEntry[];
}

export interface RuntimeContextResult {
  readonly segments: readonly RuntimeContextSegment[];
}

export interface RuntimeContextAudit {
  readonly resolvedAt: string;
  readonly tokenBudget: number;
  readonly estimatedTokens: number;
  readonly candidateEntries: number;
  readonly selectedEntries: number;
  readonly droppedEntries: number;
}

export interface RuntimeContextResolution extends RuntimeContextResult {
  readonly audit: RuntimeContextAudit;
}

export interface RuntimeContextRetrievalInput {
  readonly agentName: string;
  readonly query: string;
  readonly surface: RuntimeSurface;
  readonly source: RuntimeInvocationSource;
  readonly tokenBudget: number;
  /** Hosted application's end user, never the Polpo account/member id. */
  readonly externalUserId?: string;
  readonly sessionId?: string;
  readonly channelId?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export type RuntimeContextRetrievalRequest = Omit<
  RuntimeContextRetrievalInput,
  "tokenBudget"
>;

export type RuntimeContextRetriever = (
  input: RuntimeContextRetrievalInput,
) => RuntimeContextResult | Promise<RuntimeContextResult>;

export interface RuntimeContextProvider {
  /**
   * Hard cap for the final rendered context block. Zero disables retrieval
   * without invoking the provider.
   */
  readonly tokenBudget: number;
  readonly retrieve: RuntimeContextRetriever;
}

export interface ResolveRuntimeContextOptions {
  readonly now?: () => Date | string;
}

/**
 * Trust assigned to prompt-bound context. This is intentionally separate from
 * retrieval-entry trust because it also covers system and developer content.
 */
export type RuntimePromptContextTrust =
  | "system"
  | "developer"
  | "user"
  | "external"
  | "untrusted";

/**
 * Prompt-context protection is opt-in until a host explicitly enables it.
 * The serializable value survives process and deployment boundaries.
 */
export type RuntimeContextTrustMode = "off" | "enforce";

export interface RuntimePromptContextSegment {
  readonly kind: string;
  readonly sourceId?: string;
  readonly trust: RuntimePromptContextTrust;
  readonly content: string;
  readonly truncated?: boolean;
  readonly findings?: readonly RuntimeGuardrailDecision[];
}

export interface CreateRuntimePromptContextSegmentInput {
  readonly kind: string;
  readonly sourceId?: string;
  readonly trust: RuntimePromptContextTrust;
  readonly content: string;
  readonly truncated?: boolean;
  readonly findings?: readonly RuntimeGuardrailDecision[];
}

export interface RuntimePromptContextSegmentOptions {
  readonly maxCharacters?: number;
}
