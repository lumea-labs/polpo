import { canAccessMemoryScope } from "./scope.js";
import { MemoryPolicyError } from "./store-errors.js";
import type {
  MemoryItem,
  MemoryKind,
  MemoryScopeKind,
} from "./types.js";
import type { MemoryStoreContext } from "./store-types.js";

export interface MemorySensitiveContentFinding {
  readonly code: string;
  readonly start: number;
  readonly length: number;
}

export type MemorySensitiveContentHook = (
  content: string,
) =>
  | readonly MemorySensitiveContentFinding[]
  | Promise<readonly MemorySensitiveContentFinding[]>;

export interface MemoryWritePolicy {
  readonly allowedScopeKinds?: readonly MemoryScopeKind[];
  readonly allowedKinds?: readonly MemoryKind[];
  readonly allowSensitiveContent?: boolean;
  readonly allowPublicChannelBroadScopeWrites?: boolean;
  readonly sensitiveContentHook?: MemorySensitiveContentHook;
}

export interface MemoryPolicyViolation {
  readonly code:
    | "unauthorized_scope"
    | "scope_kind_denied"
    | "memory_kind_denied"
    | "public_channel_broad_scope"
    | "sensitive_content";
  readonly message: string;
  readonly findingCodes?: readonly string[];
}

export interface MemoryWriteDecision {
  readonly allowed: boolean;
  readonly violations: readonly MemoryPolicyViolation[];
}

interface SensitivePattern {
  readonly code: string;
  readonly expression: RegExp;
}

const SENSITIVE_PATTERNS: readonly SensitivePattern[] = [
  {
    code: "private_key",
    expression: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu,
  },
  {
    code: "bearer_token",
    expression: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
  },
  {
    code: "credential_assignment",
    expression: /\b(?:api[_-]?key|access[_-]?token|password|secret|client[_-]?secret)\s*[:=]\s*["']?[^\s"',;]{12,}/giu,
  },
  {
    code: "known_token_prefix",
    expression: /\b(?:sk[-_]|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_=-]{16,}\b/gu,
  },
];

const BROAD_SCOPE_KINDS = new Set<MemoryScopeKind>([
  "org",
  "project",
  "agent",
]);

function normalizeFinding(
  finding: MemorySensitiveContentFinding,
): MemorySensitiveContentFinding {
  const code = typeof finding.code === "string"
    && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(finding.code)
    ? finding.code
    : "custom_sensitive_content";
  const start = Number.isInteger(finding.start) && finding.start >= 0
    ? finding.start
    : 0;
  const length = Number.isInteger(finding.length) && finding.length >= 0
    ? finding.length
    : 0;
  return Object.freeze({ code, start, length });
}

export function detectSensitiveMemoryContent(
  content: string,
): MemorySensitiveContentFinding[] {
  const findings: MemorySensitiveContentFinding[] = [];
  for (const pattern of SENSITIVE_PATTERNS) {
    for (const match of content.matchAll(pattern.expression)) {
      findings.push(Object.freeze({
        code: pattern.code,
        start: match.index,
        length: match[0].length,
      }));
    }
  }
  return findings.sort((left, right) => (
    left.start - right.start
    || left.code.localeCompare(right.code)
  ));
}

export async function evaluateMemoryWrite(
  item: MemoryItem,
  context: MemoryStoreContext,
  policy: MemoryWritePolicy = {},
): Promise<MemoryWriteDecision> {
  const violations: MemoryPolicyViolation[] = [];

  if (!canAccessMemoryScope(item.scope, context.access)) {
    violations.push({
      code: "unauthorized_scope",
      message: "The caller cannot write this Memory scope.",
    });
  }
  if (
    policy.allowedScopeKinds
    && !policy.allowedScopeKinds.includes(item.scope.kind)
  ) {
    violations.push({
      code: "scope_kind_denied",
      message: `Memory scope kind "${item.scope.kind}" is denied by policy.`,
    });
  }
  if (policy.allowedKinds && !policy.allowedKinds.includes(item.kind)) {
    violations.push({
      code: "memory_kind_denied",
      message: `Memory kind "${item.kind}" is denied by policy.`,
    });
  }
  if (
    context.surface === "channel"
    && context.channelVisibility === "public"
    && BROAD_SCOPE_KINDS.has(item.scope.kind)
    && !policy.allowPublicChannelBroadScopeWrites
  ) {
    violations.push({
      code: "public_channel_broad_scope",
      message: "Public channels cannot write broad Memory scopes.",
    });
  }

  if (!policy.allowSensitiveContent) {
    const values = [
      item.content,
      ...(item.summary ? [item.summary] : []),
    ];
    const findings: MemorySensitiveContentFinding[] = [];
    for (const value of values) {
      findings.push(...detectSensitiveMemoryContent(value));
      if (policy.sensitiveContentHook) {
        try {
          const custom = await policy.sensitiveContentHook(value);
          findings.push(...custom.map(normalizeFinding));
        } catch (error) {
          throw new MemoryPolicyError(
            "Memory sensitive-content policy failed closed",
            { cause: error },
          );
        }
      }
    }
    if (findings.length > 0) {
      violations.push({
        code: "sensitive_content",
        message: "Memory content contains sensitive credential material.",
        findingCodes: [...new Set(findings.map((finding) => finding.code))],
      });
    }
  }

  return Object.freeze({
    allowed: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
