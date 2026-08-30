import type { CanonicalTurnCommitted } from "../canonical-turn.js";
import { createMemoryExtractionCandidate } from "./extraction.js";
import type {
  MemoryExtractionCandidate,
  MemoryExtractionCandidateStore,
  MemoryExtractionProposal,
  MemoryExtractionStoreContext,
} from "./extraction.js";
import { MemoryContractError } from "./errors.js";
import { createMemoryItem } from "./item.js";
import { detectSensitiveMemoryContent } from "./policy.js";
import { memoryScopeKey } from "./scope.js";
import type { MemoryItemStore, MemoryStoreContext } from "./store-types.js";
import type { MemoryKind, MemoryScope } from "./types.js";
import type { MemoryLearningMode } from "./tool-settings.js";

export const MAX_MEMORY_LEARNING_CANDIDATES = 20;
export const MAX_MEMORY_LEARNING_TURN_CHARACTERS = 64_000;
export const DEFAULT_AUTOMATIC_MEMORY_CONFIDENCE = 0.9;

export type MemoryTurnIneligibilityReason =
  | "learning_off"
  | "surface_disabled"
  | "turn_not_succeeded"
  | "missing_external_user"
  | "missing_visible_messages";

export interface MemoryTurnEligibilityInput {
  readonly turn: CanonicalTurnCommitted;
  readonly mode: MemoryLearningMode;
  readonly surfaces: readonly ("chat" | "channel")[];
}

export type MemoryTurnEligibility =
  | {
      readonly eligible: true;
      readonly scope: MemoryScope;
    }
  | {
      readonly eligible: false;
      readonly reason: MemoryTurnIneligibilityReason;
    };

export function evaluateMemoryTurnEligibility(
  input: MemoryTurnEligibilityInput,
): MemoryTurnEligibility {
  if (input.mode === "off") return { eligible: false, reason: "learning_off" };
  if (!input.surfaces.includes(input.turn.surface)) {
    return { eligible: false, reason: "surface_disabled" };
  }
  if (input.turn.terminalStatus !== "succeeded") {
    return { eligible: false, reason: "turn_not_succeeded" };
  }
  if (!input.turn.assistantMessage) {
    return { eligible: false, reason: "missing_visible_messages" };
  }
  const externalUserId = input.turn.trustedInvocation.externalUserId;
  if (!externalUserId) {
    return { eligible: false, reason: "missing_external_user" };
  }
  return {
    eligible: true,
    scope: Object.freeze({
      kind: "user",
      subjectId: externalUserId,
      agentName: input.turn.agentName,
    }),
  };
}

export interface MemoryLearningVisibleTurn {
  readonly turn: CanonicalTurnCommitted;
  readonly userContent: string;
  readonly assistantContent: string;
}

export interface MemoryExtractorCandidate {
  readonly kind: MemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly confidence?: number;
  /** Initial release accepts only facts evidenced by the visible user message. */
  readonly evidence: "user";
  readonly existingMemoryId?: string;
}

export interface MemoryExtractorResult {
  readonly candidates: readonly MemoryExtractorCandidate[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryExtractorInput extends MemoryLearningVisibleTurn {
  readonly allowedKinds: readonly MemoryKind[];
  readonly scope: MemoryScope;
  readonly signal?: AbortSignal;
}

export interface MemoryExtractor {
  readonly revision: string;
  extract(input: MemoryExtractorInput): Promise<MemoryExtractorResult>;
}

export type MemoryConsolidationDecision = "pending" | "apply" | "reject";

export interface MemoryConsolidationResolution {
  readonly proposal: MemoryExtractionProposal;
  readonly decision: MemoryConsolidationDecision;
  readonly reason?: string;
}

export interface MemoryConsolidationInput {
  readonly mode: Exclude<MemoryLearningMode, "off">;
  readonly candidate: MemoryExtractorCandidate;
  readonly scope: MemoryScope;
  readonly observedAt: string;
  readonly itemContext: MemoryStoreContext;
}

export interface MemoryConsolidationPolicy {
  readonly revision: string;
  resolve(input: MemoryConsolidationInput): Promise<MemoryConsolidationResolution>;
}

export interface DeterministicMemoryConsolidationPolicyOptions {
  readonly itemStore: MemoryItemStore;
  readonly automaticConfidence?: number;
  readonly revision?: string;
}

export class DeterministicMemoryConsolidationPolicy
implements MemoryConsolidationPolicy {
  readonly revision: string;
  private readonly threshold: number;

  constructor(private readonly options: DeterministicMemoryConsolidationPolicyOptions) {
    this.revision = requiredRevision(options.revision ?? "deterministic-v1", "policy revision");
    this.threshold = options.automaticConfidence ?? DEFAULT_AUTOMATIC_MEMORY_CONFIDENCE;
    if (!Number.isFinite(this.threshold) || this.threshold < 0 || this.threshold > 1) {
      throw new TypeError("automaticConfidence must be between 0 and 1");
    }
  }

  async resolve(input: MemoryConsolidationInput): Promise<MemoryConsolidationResolution> {
    if (detectSensitiveMemoryContent(
      `${input.candidate.content}\n${input.candidate.summary ?? ""}`,
    ).length > 0) {
      return {
        proposal: { action: "create" },
        decision: "reject",
        reason: "sensitive_content",
      };
    }

    const duplicate = await this.options.itemStore.findDedupeCandidate({
      scope: input.scope,
      kind: input.candidate.kind,
      content: input.candidate.content,
    }, input.itemContext);
    if (duplicate) {
      return {
        proposal: { action: "duplicate", existingMemoryId: duplicate.id },
        decision: "reject",
        reason: "exact_duplicate",
      };
    }

    let proposal: MemoryExtractionProposal = { action: "create" };
    if (input.candidate.existingMemoryId) {
      const existing = await this.options.itemStore.get(
        input.candidate.existingMemoryId,
        input.itemContext,
        { includeInactive: true, includeExpired: true },
      );
      proposal = {
        action: "supersede",
        existingMemoryId: input.candidate.existingMemoryId,
      };
      if (
        !existing
        || existing.status !== "active"
        || existing.kind !== input.candidate.kind
        || memoryScopeKey(existing.scope) !== memoryScopeKey(input.scope)
      ) {
        return { proposal, decision: "reject", reason: "invalid_supersede_target" };
      }
      if (Date.parse(existing.updatedAt) > Date.parse(input.observedAt)) {
        return { proposal, decision: "reject", reason: "stale_extraction" };
      }
    }

    if (input.mode === "suggest") return { proposal, decision: "pending" };
    if ((input.candidate.confidence ?? 0) < this.threshold) {
      return { proposal, decision: "pending", reason: "confidence_below_threshold" };
    }
    return { proposal, decision: "apply" };
  }
}

export interface MemoryLearningProcessInput extends MemoryLearningVisibleTurn {
  readonly mode: MemoryLearningMode;
  readonly surfaces: readonly ("chat" | "channel")[];
  readonly kinds: readonly MemoryKind[];
  readonly candidateContext: MemoryExtractionStoreContext;
  readonly itemContext: MemoryStoreContext;
  readonly signal?: AbortSignal;
}

export interface MemoryLearningProcessResult {
  readonly eligible: boolean;
  readonly reason?: MemoryTurnIneligibilityReason;
  readonly candidates: readonly MemoryExtractionCandidate[];
  readonly appliedMemoryIds: readonly string[];
  readonly usage?: MemoryExtractorResult["usage"];
  readonly providerMetadata?: MemoryExtractorResult["providerMetadata"];
}

export interface MemoryLearningServiceOptions {
  readonly extractor: MemoryExtractor;
  readonly policy: MemoryConsolidationPolicy;
  readonly candidateStore: MemoryExtractionCandidateStore;
  readonly itemStore: MemoryItemStore;
  readonly now?: () => Date | string;
}

export class MemoryLearningService {
  constructor(private readonly options: MemoryLearningServiceOptions) {
    requiredRevision(options.extractor.revision, "extractor revision");
    requiredRevision(options.policy.revision, "policy revision");
  }

  async process(input: MemoryLearningProcessInput): Promise<MemoryLearningProcessResult> {
    const eligibility = evaluateMemoryTurnEligibility(input);
    if (!eligibility.eligible) {
      return {
        eligible: false,
        reason: eligibility.reason,
        candidates: [],
        appliedMemoryIds: [],
      };
    }
    assertBoundedVisibleContent(input.userContent, "userContent");
    assertBoundedVisibleContent(input.assistantContent, "assistantContent");
    const allowedKinds = [...new Set(input.kinds)];
    const extraction = await this.options.extractor.extract({
      turn: input.turn,
      userContent: input.userContent,
      assistantContent: input.assistantContent,
      allowedKinds,
      scope: eligibility.scope,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!extraction || !Array.isArray(extraction.candidates)) {
      throw new MemoryContractError("Memory extractor returned an invalid result");
    }
    if (extraction.candidates.length > MAX_MEMORY_LEARNING_CANDIDATES) {
      throw new MemoryContractError(
        `Memory extractor returned more than ${MAX_MEMORY_LEARNING_CANDIDATES} candidates`,
      );
    }

    const candidates: MemoryExtractionCandidate[] = [];
    const appliedMemoryIds: string[] = [];
    for (const [index, extracted] of extraction.candidates.entries()) {
      assertExtractorCandidate(extracted, allowedKinds, index);
      const idempotencyKey = [
        input.turn.turnId,
        this.options.extractor.revision,
        this.options.policy.revision,
        index,
      ].join(":");
      const existingCandidate = await this.options.candidateStore.getByIdempotencyKey?.(
        idempotencyKey,
        eligibility.scope,
        input.candidateContext,
      );
      if (existingCandidate) {
        let replayed = existingCandidate;
        if (replayed.status === "approved") {
          const memoryId = await applyMemoryExtractionCandidate(
            replayed,
            this.options.itemStore,
            input.itemContext,
            this.options.now,
          );
          replayed = await this.options.candidateStore.markApplied(replayed.id, {
            memoryId,
            expectedRevision: replayed.revision,
          }, input.candidateContext);
        }
        if (replayed.status === "applied" && replayed.appliedMemoryId) {
          appliedMemoryIds.push(replayed.appliedMemoryId);
        }
        candidates.push(replayed);
        continue;
      }
      const resolution = await this.options.policy.resolve({
        mode: input.mode as Exclude<MemoryLearningMode, "off">,
        candidate: extracted,
        scope: eligibility.scope,
        observedAt: input.turn.occurredAt,
        itemContext: input.itemContext,
      });
      const proposed = await this.options.candidateStore.propose(
        createMemoryExtractionCandidate({
          idempotencyKey,
          scope: eligibility.scope,
          kind: extracted.kind,
          content: extracted.content,
          ...(extracted.summary ? { summary: extracted.summary } : {}),
          ...(extracted.confidence === undefined
            ? {}
            : { confidence: extracted.confidence }),
          source: {
            sourceId: input.turn.turnId,
            turnId: input.turn.turnId,
            extractorRevision: this.options.extractor.revision,
            policyRevision: this.options.policy.revision,
            ...(input.turn.runId ? { runId: input.turn.runId } : {}),
            sessionId: input.turn.sessionId,
            messageIds: [input.turn.userMessage.id],
          },
          proposal: resolution.proposal,
          metadata: {
            evidence: "user",
            ...(resolution.reason ? { policyReason: resolution.reason } : {}),
          },
        }, { now: this.options.now }),
        input.candidateContext,
      );
      let candidate = proposed.candidate;
      if (candidate.status === "pending" && resolution.decision === "reject") {
        candidate = await this.options.candidateStore.decide(candidate.id, {
          decision: "reject",
          decidedBy: { actor: "system", actorId: this.options.policy.revision },
          reason: resolution.reason ?? "rejected_by_policy",
          expectedRevision: candidate.revision,
        }, input.candidateContext);
      } else if (candidate.status === "pending" && resolution.decision === "apply") {
        candidate = await this.options.candidateStore.decide(candidate.id, {
          decision: "approve",
          decidedBy: { actor: "system", actorId: this.options.policy.revision },
          expectedRevision: candidate.revision,
        }, input.candidateContext);
      }
      if (candidate.status === "approved") {
        const memoryId = await applyMemoryExtractionCandidate(
          candidate,
          this.options.itemStore,
          input.itemContext,
          this.options.now,
        );
        candidate = await this.options.candidateStore.markApplied(candidate.id, {
          memoryId,
          expectedRevision: candidate.revision,
        }, input.candidateContext);
        appliedMemoryIds.push(memoryId);
      } else if (candidate.status === "applied" && candidate.appliedMemoryId) {
        appliedMemoryIds.push(candidate.appliedMemoryId);
      }
      candidates.push(candidate);
    }
    return {
      eligible: true,
      candidates,
      appliedMemoryIds,
      ...(extraction.usage ? { usage: extraction.usage } : {}),
      ...(extraction.providerMetadata
        ? { providerMetadata: extraction.providerMetadata }
        : {}),
    };
  }
}

export async function applyMemoryExtractionCandidate(
  candidate: MemoryExtractionCandidate,
  itemStore: MemoryItemStore,
  context: MemoryStoreContext,
  now?: () => Date | string,
): Promise<string> {
  if (candidate.status !== "approved" && candidate.status !== "applied") {
    throw new MemoryContractError("Only approved Memory candidates can be applied");
  }
  const memoryId = candidate.appliedMemoryId ?? `learned-${candidate.id}`;
  const existingReplacement = await itemStore.get(
    memoryId,
    context,
    { includeInactive: true, includeExpired: true },
  );
  if (existingReplacement) {
    if (
      existingReplacement.kind !== candidate.kind
      || memoryScopeKey(existingReplacement.scope) !== memoryScopeKey(candidate.scope)
      || existingReplacement.content !== candidate.content
    ) {
      throw new MemoryContractError("Learned Memory id conflicts with another item");
    }
    return memoryId;
  }
  const item = createMemoryItem({
    id: memoryId,
    scope: candidate.scope,
    kind: candidate.kind,
    content: candidate.content,
    ...(candidate.summary ? { summary: candidate.summary } : {}),
    ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
    status: "active",
    provenance: {
      source: "extraction",
      actor: "system",
      sourceId: candidate.source.turnId ?? candidate.id,
      ...(candidate.source.runId ? { runId: candidate.source.runId } : {}),
      ...(candidate.source.sessionId ? { sessionId: candidate.source.sessionId } : {}),
      ...(candidate.source.messageIds?.[0]
        ? { messageId: candidate.source.messageIds[0] }
        : {}),
    },
  }, { now });
  if (candidate.proposal.action === "supersede") {
    const result = await itemStore.supersede(
      candidate.proposal.existingMemoryId!,
      item,
      context,
    );
    if (!result) throw new MemoryContractError("Superseded Memory no longer exists");
  } else {
    await itemStore.create(item, context);
  }
  return memoryId;
}

function requiredRevision(value: string, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function assertBoundedVisibleContent(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_MEMORY_LEARNING_TURN_CHARACTERS) {
    throw new MemoryContractError(
      `${path} must be a string with at most ${MAX_MEMORY_LEARNING_TURN_CHARACTERS} characters`,
    );
  }
}

function assertExtractorCandidate(
  value: unknown,
  allowedKinds: readonly MemoryKind[],
  index: number,
): asserts value is MemoryExtractorCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryContractError(`extractor candidate ${index} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["kind", "content", "summary", "confidence", "evidence", "existingMemoryId"]);
  const unknown = Object.keys(candidate).find((key) => !allowed.has(key));
  if (unknown) throw new MemoryContractError(`extractor candidate ${index}.${unknown} is unsupported`);
  if (!allowedKinds.includes(candidate.kind as MemoryKind)) {
    throw new MemoryContractError(`extractor candidate ${index}.kind is not allowed`);
  }
  if (candidate.evidence !== "user") {
    throw new MemoryContractError(`extractor candidate ${index} is not supported by the user message`);
  }
  if (typeof candidate.content !== "string" || candidate.content.trim().length === 0) {
    throw new MemoryContractError(`extractor candidate ${index}.content is invalid`);
  }
  if (candidate.summary !== undefined && typeof candidate.summary !== "string") {
    throw new MemoryContractError(`extractor candidate ${index}.summary is invalid`);
  }
  if (
    candidate.confidence !== undefined
    && (
      typeof candidate.confidence !== "number"
      || !Number.isFinite(candidate.confidence)
      || candidate.confidence < 0
      || candidate.confidence > 1
    )
  ) {
    throw new MemoryContractError(`extractor candidate ${index}.confidence is invalid`);
  }
  if (
    candidate.existingMemoryId !== undefined
    && (
      typeof candidate.existingMemoryId !== "string"
      || candidate.existingMemoryId.trim().length === 0
    )
  ) {
    throw new MemoryContractError(`extractor candidate ${index}.existingMemoryId is invalid`);
  }
}
