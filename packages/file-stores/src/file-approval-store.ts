import { mkdirSync } from "node:fs";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { ApprovalRequest, ApprovalStatus } from "@polpo-ai/core/types";
import { withProjectFileTransaction, type ProjectFileTransaction } from "./project-file-transaction.js";

const filePath = "approvals.json";

function parseRequests(raw: string): ApprovalRequest[] {
  let requests: unknown;
  try { requests = JSON.parse(raw); } catch { throw new Error("Invalid stored approval requests"); }
  if (!Array.isArray(requests)) throw new Error("Invalid stored approval requests");
  const ids = new Set<string>();
  for (const request of requests) {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || typeof request.id !== "string" || !request.id || ids.has(request.id)
      || typeof request.gateId !== "string" || typeof request.gateName !== "string"
      || typeof request.requestedAt !== "string"
      || !["pending", "approved", "rejected", "timeout"].includes(request.status)
      || ["taskId", "missionId", "resolvedAt", "resolvedBy", "note"].some(
        key => request[key] !== undefined && typeof request[key] !== "string")) {
      throw new Error("Invalid stored approval requests");
    }
    ids.add(request.id);
  }
  return requests as ApprovalRequest[];
}

/** Internal staged access shared with atomic Task/Run/Approval decisions. */
export function readFileApprovalRequests(tx: ProjectFileTransaction): ApprovalRequest[] {
  const raw = tx.read(filePath);
  return raw === null ? [] : parseRequests(raw);
}
export function writeFileApprovalRequests(tx: ProjectFileTransaction, requests: ApprovalRequest[]): void {
  const raw = JSON.stringify(requests, null, 2);
  parseRequests(raw);
  tx.write(filePath, raw);
}

/**
 * Filesystem-based approval store.
 * Persists the existing JSON array in .polpo/approvals.json. Every operation
 * uses the project coordinator: separate runtimes must not overwrite each
 * other's requests or acknowledge a failed write. Reads also recover committed
 * journals and return detached snapshots; there is no per-process cache.
 *
 * Individual operations are atomic. A get followed by upsert is NOT a compare
 * and swap, nor an atomic change of the associated Task/Run.
 */
export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly polpoDir: string) {
    mkdirSync(polpoDir, { recursive: true });
  }

  private read(tx: ProjectFileTransaction): ApprovalRequest[] {
    return readFileApprovalRequests(tx);
  }

  async upsert(request: ApprovalRequest): Promise<void> {
    // Validate the serialized form too, so an invalid payload cannot poison the
    // durable array. Serialization errors propagate without touching storage.
    const snapshot = parseRequests(JSON.stringify([request]))[0];
    withProjectFileTransaction(this.polpoDir, tx => {
      const requests = this.read(tx);
      const index = requests.findIndex(r => r.id === snapshot.id);
      if (index < 0) requests.push(snapshot);
      else requests[index] = snapshot;
      writeFileApprovalRequests(tx, requests);
    });
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    return withProjectFileTransaction(this.polpoDir, tx => this.read(tx).find(r => r.id === id));
  }

  async list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const requests = this.read(tx);
      return status ? requests.filter(r => r.status === status) : requests;
    });
  }

  async listByTask(taskId: string): Promise<ApprovalRequest[]> {
    return withProjectFileTransaction(this.polpoDir, tx => this.read(tx).filter(r => r.taskId === taskId));
  }

  async delete(id: string): Promise<boolean> {
    return withProjectFileTransaction(this.polpoDir, tx => {
      const requests = this.read(tx);
      const remaining = requests.filter(r => r.id !== id);
      if (remaining.length === requests.length) return false;
      writeFileApprovalRequests(tx, remaining);
      return true;
    });
  }

  async close(): Promise<void> {}
}
