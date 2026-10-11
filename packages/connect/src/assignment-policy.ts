import type { ConnectionBindingAttributes, ConnectionRecord } from "./types.js";

/** A prospective assignment for one capability. Hosts supply only active,
 * visible accounts and must also check scopes, grants and execution surfaces. */
export interface ConnectionAssignment {
  connection: Pick<ConnectionRecord, "id" | "providerId" | "audience" | "owner" | "binding">;
  /** Additional grant constraints. They never replace account constraints. */
  binding?: ConnectionBindingAttributes;
}

export type ConnectionAssignmentValidation = { ok: true } | {
  ok: false;
  reason: "invalid_context" | "provider_mismatch" | "overlapping_context";
  connectionIds: string[];
};

/** Configuration preflight, not runtime authorization or a write lock. Distinct
 * accounts may coexist only when no explicit trusted selector can match both.
 * Hosts that cannot select an audience explicitly must additionally restrict
 * assignments to one audience. Runtime must still reject ambiguous selection. */
export function validateConnectionAssignments(assignments: readonly ConnectionAssignment[]): ConnectionAssignmentValidation {
  const contexts: { assignment: ConnectionAssignment; fields: Map<string, string> }[] = [];
  for (const assignment of assignments) {
    const fields = contextConstraints(assignment);
    if (!fields) return { ok: false, reason: "invalid_context", connectionIds: [assignment.connection.id] };
    for (const previous of contexts) {
      const ids = [previous.assignment.connection.id, assignment.connection.id];
      if (previous.assignment.connection.providerId !== assignment.connection.providerId) {
        return { ok: false, reason: "provider_mismatch", connectionIds: ids };
      }
      if (ids[0] === ids[1]) continue; // Several grants may authorize the same account.
      const disjoint = [...fields].some(([key, value]) => previous.fields.has(key) && previous.fields.get(key) !== value);
      if (!disjoint) return { ok: false, reason: "overlapping_context", connectionIds: ids };
    }
    contexts.push({ assignment, fields });
  }
  return { ok: true };
}

const bindingParts = {
  principal: ["type", "id", "namespace"],
  tenant: ["namespace", "id"],
  resource: ["namespace", "type", "id"],
} as const;

function contextConstraints({ connection, binding }: ConnectionAssignment): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  const audience = connection.audience ?? "shared";
  if (!["personal", "shared", "end_user"].includes(audience)) return;
  fields.set("audience", audience);
  const add = (key: string, value: unknown) => {
    // Selector normalization trims values; whitespace-bearing persisted values
    // cannot reliably identify a reachable account.
    if (typeof value !== "string" || !value || value.trim() !== value) return false;
    if (fields.has(key) && fields.get(key) !== value) return false;
    fields.set(key, value);
    return true;
  };
  const merge = (value: unknown, requireConstraint: boolean): boolean => {
    if (value === undefined) return true;
    if (!plainObject(value) || (requireConstraint && Object.keys(value).length === 0)) return false;
    for (const [key, part] of Object.entries(value)) {
      if (key === "scopeEpoch") {
        if (!add(key, part)) return false;
      } else {
        if (!Object.hasOwn(bindingParts, key)) return false;
        const allowed = bindingParts[key as keyof typeof bindingParts] as readonly string[] | undefined;
        if (!allowed || !plainObject(part) || Object.keys(part).length === 0) return false;
        for (const [field, text] of Object.entries(part)) {
          if (!allowed.includes(field) || !add(`${key}.${field}`, text)) return false;
        }
      }
    }
    return true;
  };
  if (!merge(connection.binding, true) || !merge(binding, false)) return;
  if (audience === "personal") {
    if (connection.owner?.type !== "user" || !add("principal.type", "user") || !add("principal.id", connection.owner.id)) return;
  }
  if (audience === "end_user") {
    // End-user identity must be carried by the Connection itself, not rescued
    // by a grant. Partial legacy fields still constrain shared installations.
    const principal = connection.binding?.principal;
    const owner = connection.owner;
    if (owner?.type !== "external_user" || principal?.type !== "external_user" || principal.id !== owner.id
      || !add("principal.type", "external_user") || !add("principal.id", owner.id)
      || !add("principal.namespace", owner.namespace)) return;
  }
  return fields;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
