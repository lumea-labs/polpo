import { describe, expect, it, vi } from "vitest";
import { createRuntimePlan } from "@polpo-ai/core/runtime-plan";
import { SSEBridge, type SSEClient } from "../server/sse-bridge.js";

describe("SSE runtime plan bridge", () => {
  it("forwards runtime plan decisions to connected clients", () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const orchestrator = {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn(),
    };
    const bridge = new SSEBridge(orchestrator as never);
    const client: SSEClient = {
      id: "client-1",
      send: vi.fn(),
      close: vi.fn(),
    };
    bridge.start();
    bridge.addClient(client);

    const plan = createRuntimePlan({
      id: "plan-1",
      surface: "agent",
      source: "request",
      model: { selection: "openai/gpt-5" },
    });
    handlers.get("runtime:plan")?.({
      type: "runtime.plan.resolved",
      plan,
    });

    expect(client.send).toHaveBeenCalledWith(
      "runtime:plan",
      { type: "runtime.plan.resolved", plan },
      "1",
    );
  });
});
