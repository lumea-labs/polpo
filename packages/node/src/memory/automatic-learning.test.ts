import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanonicalTurnOutboxDispatcher,
  InMemoryMemoryExtractionStore,
  InMemoryMemoryItemStore,
  type CanonicalTurnCommitted,
  type MemoryExtractor,
} from "@polpo-ai/core";
import { FileSessionStore } from "@polpo-ai/file-stores";
import { createLocalMemoryLearningHandler } from "./automatic-learning.js";

const directories: string[] = [];
const occurredAt = "2026-08-30T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

async function fixture(options: {
  mode?: "suggest" | "automatic";
  userContent?: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
    | { type: "file"; file_id: string }
  >;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "polpo-auto-memory-"));
  directories.push(directory);
  const sessionStore = new FileSessionStore(directory);
  const sessionId = await sessionStore.create({
    agent: "assistant",
    user: "external-user",
  });
  const turnId = "turn-1";
  const user = await sessionStore.addMessage(
    sessionId,
    "user",
    options.userContent ?? "I prefer concise weekly summaries.",
    { turnId },
  );
  const assistant = await sessionStore.addMessage(
    sessionId,
    "assistant",
    "",
    { turnId },
  );
  const turn: CanonicalTurnCommitted = {
    turnId,
    requestId: "request-1",
    runId: "run-1",
    sessionId,
    agentName: "assistant",
    surface: "chat",
    terminalStatus: "succeeded",
    userMessage: { id: user.id, role: "user" },
    assistantMessage: { id: assistant.id, role: "assistant" },
    trustedInvocation: { externalUserId: "external-user" },
    learningPolicy: {
      mode: options.mode ?? "suggest",
      surfaces: ["chat"],
      kinds: ["preference"],
    },
    occurredAt,
  };
  await sessionStore.commitCanonicalTurn!({
    turn,
    assistant: {
      messageId: assistant.id,
      content: "I will keep future summaries concise.",
    },
  });
  return { directory, sessionId, sessionStore, turn };
}

function extractor(
  implementation: MemoryExtractor["extract"] = vi.fn(async () => ({
    candidates: [{
      kind: "preference",
      content: "Prefers concise weekly summaries.",
      confidence: 0.98,
      evidence: "user",
    }],
  })),
): MemoryExtractor {
  return { revision: "extractor-v1", extract: implementation };
}

function dispatcher(options: {
  sessionStore: FileSessionStore;
  memoryExtractor: MemoryExtractor;
  candidateStore?: InMemoryMemoryExtractionStore;
  itemStore?: InMemoryMemoryItemStore;
}) {
  const candidateStore = options.candidateStore ?? new InMemoryMemoryExtractionStore({
    now: () => occurredAt,
  });
  const itemStore = options.itemStore ?? new InMemoryMemoryItemStore();
  return {
    candidateStore,
    itemStore,
    dispatcher: new CanonicalTurnOutboxDispatcher({
      sessionStore: options.sessionStore,
      handler: createLocalMemoryLearningHandler({
        extractor: options.memoryExtractor,
        sessionStore: options.sessionStore,
        candidateStore,
        itemStore,
        namespace: "project-1",
        projectId: "project-1",
      }),
    }),
  };
}

const access = {
  projectId: "project-1",
  agentName: "assistant",
  externalUserId: "external-user",
};

describe("local automatic Memory learning", () => {
  it("creates a pending suggestion and acknowledges the durable turn", async () => {
    const state = await fixture();
    const harness = dispatcher({
      sessionStore: state.sessionStore,
      memoryExtractor: extractor(),
    });

    await expect(harness.dispatcher.dispatchPending()).resolves.toMatchObject({
      scanned: 1,
      dispatched: 1,
      failed: 0,
    });
    await expect(state.sessionStore.listPendingCanonicalTurns!()).resolves.toEqual([]);
    await expect(harness.candidateStore.list({}, {
      namespace: "project-1",
      access,
    })).resolves.toMatchObject([{
      status: "pending",
      kind: "preference",
      content: "Prefers concise weekly summaries.",
    }]);
  });

  it("keeps extraction failures pending and retries them after a process restart", async () => {
    const state = await fixture();
    const failing = extractor(vi.fn(async () => {
      throw new Error("extractor unavailable");
    }));
    const first = dispatcher({
      sessionStore: state.sessionStore,
      memoryExtractor: failing,
    });

    await expect(first.dispatcher.dispatchPending()).resolves.toMatchObject({
      failed: 1,
      dispatched: 0,
    });
    await expect(state.sessionStore.listPendingCanonicalTurns!()).resolves.toMatchObject([{
      attempts: 1,
      status: "pending",
    }]);

    const reopenedSessionStore = new FileSessionStore(state.directory);
    const succeeding = extractor();
    const second = dispatcher({
      sessionStore: reopenedSessionStore,
      memoryExtractor: succeeding,
      candidateStore: first.candidateStore,
      itemStore: first.itemStore,
    });
    await expect(second.dispatcher.dispatchPending()).resolves.toMatchObject({
      failed: 0,
      dispatched: 1,
    });
    expect(succeeding.extract).toHaveBeenCalledTimes(1);
    await expect(second.dispatcher.dispatchPending()).resolves.toMatchObject({ scanned: 0 });
  });

  it("honors the immutable policy captured at commit time", async () => {
    const state = await fixture({ mode: "suggest" });
    const harness = dispatcher({
      sessionStore: state.sessionStore,
      memoryExtractor: extractor(),
    });

    await harness.dispatcher.dispatchPending();
    await expect(harness.candidateStore.list({}, {
      namespace: "project-1",
      access,
    })).resolves.toMatchObject([{ status: "pending" }]);
    await expect(harness.itemStore.list({}, {
      namespace: "project-1",
      access,
      surface: "chat",
    })).resolves.toEqual([]);
  });

  it("passes only visible text parts to the extractor", async () => {
    const state = await fixture({
      userContent: [
        { type: "text", text: "Remember weekly summaries." },
        { type: "image_url", image_url: { url: "https://example.com/private.png" } },
        { type: "file", file_id: "secret-file" },
        { type: "text", text: "Keep them concise." },
      ],
    });
    const memoryExtractor = extractor();
    const harness = dispatcher({ sessionStore: state.sessionStore, memoryExtractor });

    await harness.dispatcher.dispatchPending();
    expect(memoryExtractor.extract).toHaveBeenCalledWith(expect.objectContaining({
      userContent: "Remember weekly summaries.\nKeep them concise.",
      assistantContent: "I will keep future summaries concise.",
    }));
  });

  it("fails closed when canonical message references are unavailable", async () => {
    const state = await fixture();
    const sessionPath = join(
      state.directory,
      "sessions",
      `${state.sessionId}.jsonl`,
    );
    const records = (await readFile(sessionPath, "utf8")).trim().split("\n");
    await writeFile(sessionPath, `${records.slice(0, -1).join("\n")}\n`, "utf8");
    const harness = dispatcher({
      sessionStore: state.sessionStore,
      memoryExtractor: extractor(),
    });

    await expect(harness.dispatcher.dispatchPending()).resolves.toMatchObject({
      scanned: 1,
      dispatched: 0,
      failed: 1,
    });
    await expect(state.sessionStore.listPendingCanonicalTurns!()).resolves.toMatchObject([{
      attempts: 1,
      status: "pending",
    }]);
  });
});
