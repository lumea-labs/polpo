import { MemoryContractError } from "./errors.js";
import type { MemoryItem, MemoryStatus } from "./types.js";

const allowedTransitions: Readonly<Record<MemoryStatus, ReadonlySet<MemoryStatus>>> = {
  pending: new Set(["pending", "active", "deleted"]),
  active: new Set(["active", "superseded", "deleted"]),
  superseded: new Set(["superseded", "deleted"]),
  deleted: new Set(["deleted"]),
};

export function assertMemoryStatusTransition(
  from: MemoryStatus,
  to: MemoryStatus,
): void {
  if (!allowedTransitions[from]?.has(to)) {
    throw new MemoryContractError(
      `Invalid Memory status transition: ${String(from)} -> ${String(to)}`,
      "invalid_transition",
      "status",
    );
  }
}

function timestamp(value: Date | string): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new MemoryContractError(
      "Memory comparison time must be a valid date",
      "invalid_item",
      "now",
    );
  }
  return time;
}

export function isMemoryItemExpired(
  item: Pick<MemoryItem, "expiresAt">,
  now: Date | string = new Date(),
): boolean {
  if (!item.expiresAt) return false;
  const expiresAt = Date.parse(item.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new MemoryContractError(
      "Memory expiresAt must be a valid date",
      "invalid_item",
      "expiresAt",
    );
  }
  return expiresAt <= timestamp(now);
}

export function isMemoryItemRetrievable(
  item: Pick<MemoryItem, "status" | "expiresAt">,
  now: Date | string = new Date(),
): boolean {
  return item.status === "active" && !isMemoryItemExpired(item, now);
}
