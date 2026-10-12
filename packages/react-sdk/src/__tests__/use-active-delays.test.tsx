// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { PolpoStore } from "@polpo-ai/sdk";
import { useActiveDelays } from "../hooks/use-active-delays.js";
import { createMockClient, createWrapper } from "./helpers.js";

it("hydrates colliding labels and applies live expiration to just one execution", async () => {
  const store = new PolpoStore();
  const delays = ["a", "b"].map(id => ({ executionId: id, missionId: id, group: "Same #2", delayName: "cooldown",
    delay: { name: "cooldown", afterTasks: [], blocksTasks: [], duration: "PT1M" },
    startedAt: "2026-10-11T08:00:00.000Z", expiresAt: "2026-10-11T08:01:00.000Z" }));
  const client = createMockClient({ listDelays: vi.fn().mockResolvedValue(delays) });
  const { result } = renderHook(() => useActiveDelays(), { wrapper: createWrapper(client, store) });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.activeDelays).toEqual(delays);
  act(() => store.applyEvent({ id: "expiry", event: "delay:expired", timestamp: delays[0].expiresAt, data: delays[0] }));
  expect(result.current.activeDelays).toEqual([delays[1]]);
});

it("does not resurrect expired timers or overwrite live starts with an older HTTP snapshot", async () => {
  const store = new PolpoStore();
  const delay = { executionId: "run", group: "Shared", delayName: "wait", delay: { name: "wait", afterTasks: [], blocksTasks: [], duration: "PT1M" },
    startedAt: "2026-10-11T08:00:00.000Z", expiresAt: "2026-10-11T08:01:00.000Z" };
  let resolve!: (value: typeof delay[]) => void;
  const client = createMockClient({ listDelays: vi.fn().mockImplementation(() => new Promise(r => { resolve = r; })) });
  const { result } = renderHook(() => useActiveDelays(), { wrapper: createWrapper(client, store) });
  const live = { ...delay, executionId: "new-run" };
  act(() => {
    store.applyEventBatch([
      { id: "expiry", event: "delay:expired", timestamp: delay.expiresAt, data: delay },
      ...Array.from({ length: 205 }, (_, i) => ({ id: `noise-${i}`, event: "log", timestamp: delay.expiresAt, data: {} })),
      { id: "start", event: "delay:started", timestamp: live.startedAt, data: live },
    ]);
  });
  await act(async () => resolve([delay]));
  expect(result.current.activeDelays).toEqual([expect.objectContaining(live)]);
});

it("drops timers absent from a refreshed snapshot and ignores replaced requests", async () => {
  const store = new PolpoStore();
  const delay = { group: "Old", delayName: "wait", delay: { name: "wait", afterTasks: [], blocksTasks: [], duration: "PT1M" },
    startedAt: "2026-10-11T08:00:00.000Z", expiresAt: "2026-10-11T08:01:00.000Z" };
  const resolvers: Array<(delays: typeof delay[]) => void> = [];
  const client = createMockClient({ listDelays: vi.fn().mockImplementation(() => new Promise(r => { resolvers.push(r); })) });
  const { result, unmount } = renderHook(() => useActiveDelays(), { wrapper: createWrapper(client, store) });
  act(() => result.current.refetch());
  await act(async () => resolvers[1]([delay]));
  await act(async () => resolvers[0]([]));
  expect(result.current.activeDelays).toEqual([delay]);
  act(() => result.current.refetch());
  await act(async () => resolvers[2]([]));
  expect(result.current.activeDelays).toEqual([]);
  act(() => result.current.refetch());
  unmount();
  await act(async () => resolvers[3]([delay]));
  expect(store.getSnapshot().activeDelays.size).toBe(0);
});

it("orders HTTP snapshots across two hooks sharing the same store", async () => {
  const store = new PolpoStore();
  const delay = { group: "Old", delayName: "wait", delay: { name: "wait", afterTasks: [], blocksTasks: [], duration: "PT1M" },
    startedAt: "2026-10-11T08:00:00.000Z", expiresAt: "2026-10-11T08:01:00.000Z" };
  const resolvers: Array<(delays: typeof delay[]) => void> = [];
  const client = createMockClient({ listDelays: vi.fn().mockImplementation(() => new Promise(r => { resolvers.push(r); })) });
  const wrapper = createWrapper(client, store);
  const a = renderHook(() => useActiveDelays(), { wrapper });
  const b = renderHook(() => useActiveDelays(), { wrapper });
  await act(async () => resolvers[1]([]));
  await act(async () => resolvers[0]([delay]));
  expect(a.result.current.activeDelays).toEqual([]);
  expect(b.result.current.activeDelays).toEqual([]);
});
