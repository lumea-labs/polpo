import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type { ApiClient } from "../src/commands/cloud/api.js";
import {
  approveMemoryCandidate,
  memoryCandidateDataFrom,
  memoryCandidateHeaders,
  memoryCandidateListPath,
  memoryCandidatePath,
  memoryCandidateRevision,
  registerMemoryCommands,
} from "../src/commands/cloud/memory.js";

describe("Memory candidate CLI", () => {
  it("encodes agent, candidate, filters, cursor, and external user independently", () => {
    expect(memoryCandidatePath("support / eu", "candidate / 1", "audit")).toBe(
      "/v1/memory/agents/support%20%2F%20eu/memory/candidates/candidate%20%2F%201/audit",
    );
    expect(memoryCandidateListPath("support / eu", {
      cursor: "next/cursor",
      limit: "25",
      statuses: ["pending", "approved", "pending"],
    })).toBe(
      "/v1/memory/agents/support%20%2F%20eu/memory/candidates"
        + "?statuses=pending%2Capproved&limit=25&cursor=next%2Fcursor",
    );
    expect(memoryCandidateHeaders(" customer / 42 ")).toEqual({
      "x-polpo-external-user-id": "v1:customer%20%2F%2042",
    });
  });

  it("rejects missing identity, unsupported statuses, unsafe limits, and stale revision syntax", () => {
    expect(() => memoryCandidateHeaders("   ")).toThrow(/external user/i);
    expect(() => memoryCandidateHeaders("x".repeat(513))).toThrow(/512/i);
    expect(() => memoryCandidateListPath("agent", { statuses: ["failed"] }))
      .toThrow(/status/i);
    expect(() => memoryCandidateListPath("agent", { limit: "0" })).toThrow(/1 and 100/i);
    expect(() => memoryCandidateListPath("agent", { limit: "101" })).toThrow(/1 and 100/i);
    expect(() => memoryCandidateListPath("agent", { limit: "1.5" })).toThrow(/1 and 100/i);
    expect(() => memoryCandidateRevision(undefined)).toThrow(/revision/i);
    expect(() => memoryCandidateRevision("0")).toThrow(/positive integer/i);
    expect(() => memoryCandidateRevision("1.2")).toThrow(/positive integer/i);
    expect(memoryCandidateRevision("7")).toBe(7);
  });

  it("surfaces stable API errors and malformed success envelopes", () => {
    expect(() => memoryCandidateDataFrom({
      status: 409,
      data: { ok: false, error: "Revision changed.", code: "MEMORY_CONFLICT" },
    } as any)).toThrow("Revision changed.");
    expect(() => memoryCandidateDataFrom({ status: 200, data: { ok: true } } as any))
      .toThrow(/missing data/i);
  });

  it("uses the approved revision for the optional apply request", async () => {
    const post = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: { ok: true, data: { candidate: { id: "candidate-1", revision: 8 } } },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          ok: true,
          data: {
            candidate: { id: "candidate-1", revision: 9, status: "applied" },
            memoryId: "memory-1",
          },
        },
      });
    const client = { post } as unknown as ApiClient;

    await expect(approveMemoryCandidate(client, {
      agent: "agent-1",
      candidateId: "candidate-1",
      externalUserId: "user-1",
      expectedRevision: 7,
      reason: "Verified by operator",
      apply: true,
    })).resolves.toMatchObject({ memoryId: "memory-1" });

    expect(post).toHaveBeenNthCalledWith(1,
      "/v1/memory/agents/agent-1/memory/candidates/candidate-1/decision",
      {
        decision: "approve",
        expectedRevision: 7,
        reason: "Verified by operator",
      },
      { headers: { "x-polpo-external-user-id": "v1:user-1" } },
    );
    expect(post).toHaveBeenNthCalledWith(2,
      "/v1/memory/agents/agent-1/memory/candidates/candidate-1/apply",
      { expectedRevision: 8 },
      { headers: { "x-polpo-external-user-id": "v1:user-1" } },
    );
  });

  it("does not apply when approval fails", async () => {
    const post = vi.fn().mockResolvedValue({
      status: 409,
      data: { ok: false, error: "Revision changed.", code: "MEMORY_CONFLICT" },
    });
    const client = { post } as unknown as ApiClient;

    await expect(approveMemoryCandidate(client, {
      agent: "agent-1",
      candidateId: "candidate-1",
      externalUserId: "user-1",
      expectedRevision: 3,
      apply: true,
    })).rejects.toThrow("Revision changed.");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("registers explicit candidate review commands and safety options", () => {
    const program = new Command();
    program.exitOverride();
    registerMemoryCommands(program);
    const memory = program.commands.find((command) => command.name() === "memory")!;
    const candidates = memory.commands.find((command) => command.name() === "candidates")!;
    expect(candidates.commands.map((command) => command.name())).toEqual([
      "list",
      "get",
      "audit",
      "approve",
      "reject",
      "apply",
    ]);
    for (const command of candidates.commands) {
      expect(command.options.map((option) => option.long)).toEqual(
        expect.arrayContaining(["--agent", "--user", "--json"]),
      );
    }
    for (const name of ["approve", "reject", "apply"]) {
      const command = candidates.commands.find((candidate) => candidate.name() === name)!;
      expect(command.options.map((option) => option.long)).toContain("--revision");
    }
    expect(candidates.commands.find((command) => command.name() === "approve")!
      .options.map((option) => option.long)).toContain("--apply");
  });
});
