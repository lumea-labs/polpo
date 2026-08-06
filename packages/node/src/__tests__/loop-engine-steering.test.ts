import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModel } from "@polpo-ai/llm";
import {
  MockLanguageModelV3,
  mockResolvedModel,
  mockTextModel,
  mockTurnSequenceModel,
} from "./helpers/mock-llm.js";

let activeResolvedModel: ResolvedModel = mockResolvedModel(mockTextModel("default"));

vi.mock("@polpo-ai/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polpo-ai/llm")>();
  return {
    ...actual,
    resolveModel: () => activeResolvedModel,
    enforceModelAllowlist: () => {},
    mapReasoningToProviderOptions: () => undefined,
  };
});

import { InMemorySteeringController } from "@polpo-ai/core/steering";
import type { AgentConfig, Task } from "@polpo-ai/core/types";
import { spawnLoopEngine, toSteeringModelMessage } from "../adapters/loop-engine.js";

let root: string;
let cwd: string;
let polpoDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "polpo-steering-"));
  cwd = join(root, "work");
  polpoDir = join(root, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function agent(): AgentConfig {
  return { name: "steered", role: "assistant", maxTurns: 4 };
}

function task(): Task {
  const now = new Date().toISOString();
  return {
    id: "steering-task",
    title: "Original task",
    description: "Start here",
    state: "in_progress",
    expectations: [],
    createdAt: now,
    updatedAt: now,
    assignedTo: "steered",
  } as Task;
}

describe("loop-engine steering adapter", () => {
  test("exposes a run-scoped controller on every agent handle", async () => {
    activeResolvedModel = mockResolvedModel(mockTextModel("done"));
    const handle = spawnLoopEngine(agent(), task(), cwd, { polpoDir });

    expect(handle.steering).toBeInstanceOf(InMemorySteeringController);
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(() => handle.steering!.enqueue({
      id: "after-close",
      mode: "steer",
      content: { text: "late" },
    })).toThrow(/closed/i);
  });

  test("maps provider-neutral text and attachments in one user message", () => {
    const mapped = toSteeringModelMessage({
      id: "s1",
      mode: "steer",
      createdAt: "2026-08-06T00:00:00.000Z",
      content: {
        text: "Use these references",
        attachments: [
          { type: "image", url: "https://example.com/mock.png", mediaType: "image/png", name: "mock" },
          { type: "audio", url: "https://example.com/note.ogg", mediaType: "audio/ogg", name: "note.ogg" },
          { type: "file", url: "data:text/plain;base64,aGVsbG8=", mediaType: "text/plain", name: "note.txt" },
        ],
      },
    });

    expect(mapped.role).toBe("user");
    expect(mapped.content).toEqual([
      { type: "text", text: "Use these references" },
      { type: "image", image: new URL("https://example.com/mock.png"), mediaType: "image/png" },
      { type: "file", data: new URL("https://example.com/note.ogg"), mediaType: "audio/ogg", filename: "note.ogg" },
      { type: "file", data: new URL("data:text/plain;base64,aGVsbG8="), mediaType: "text/plain", filename: "note.txt" },
    ]);
  });

  test("a message queued while the model is running reaches the next prompt", async () => {
    const controller = new InMemorySteeringController();
    const prompts: unknown[][] = [];
    const inner = mockTurnSequenceModel([
      { type: "text", text: "first answer" },
      { type: "text", text: "revised answer" },
    ]);
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: (options) => {
        prompts.push(options.prompt as unknown[]);
        if (calls++ === 0) {
          controller.enqueue({ id: "mid", mode: "steer", content: { text: "Change the answer to green" } });
        }
        return inner.doStream(options);
      },
    });
    activeResolvedModel = mockResolvedModel(model);

    const checkpoints: any[] = [];
    const handle = spawnLoopEngine(agent(), task(), cwd, {
      polpoDir,
      steering: controller,
      onTurnCheckpoint: (checkpoint) => checkpoints.push(JSON.parse(JSON.stringify(checkpoint))),
    });
    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[0])).not.toContain("Change the answer to green");
    expect(JSON.stringify(prompts[1])).toContain("Change the answer to green");
    expect(checkpoints[0].steering.pending).toEqual([]);
    expect(checkpoints[0].history.some((message: any) => JSON.stringify(message).includes("Change the answer to green"))).toBe(true);
  });

  test("an undeliverable last-turn follow-up survives in the checkpoint", async () => {
    const controller = new InMemorySteeringController();
    controller.enqueue({ id: "next", mode: "follow_up", content: { text: "Continue after resume" } });
    activeResolvedModel = mockResolvedModel(mockTextModel("done"));
    const checkpoints: any[] = [];

    const handle = spawnLoopEngine({ ...agent(), maxTurns: 1 }, task(), cwd, {
      polpoDir,
      steering: controller,
      onTurnCheckpoint: (checkpoint) => checkpoints.push(JSON.parse(JSON.stringify(checkpoint))),
    });
    const result = await handle.done;

    expect(result.exitCode).toBe(0);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].steering.pending).toMatchObject([{ id: "next", mode: "follow_up" }]);
  });
});
