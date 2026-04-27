// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessions } from "../hooks/use-sessions.js";
import {
  createMockClient,
  createMockStore,
  createWrapper,
} from "./helpers.js";
import type { PolpoClient, PolpoStore, ChatSession } from "@polpo-ai/sdk";

function fakeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "First chat",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    messageCount: 0,
    ...overrides,
  };
}

describe("useSessions", () => {
  let client: PolpoClient;
  let store: PolpoStore;
  let wrapper: React.ComponentType<{ children: React.ReactNode }>;

  beforeEach(() => {
    client = createMockClient({
      getSessions: vi.fn().mockResolvedValue({ sessions: [fakeSession()] }),
    });
    store = createMockStore();
    wrapper = createWrapper(client, store);
  });

  it("returns sessions from the store after the initial fetch", async () => {
    const { result } = renderHook(() => useSessions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].id).toBe("s1");
  });

  /**
   * Issue #41 — when one component pushes a new session into the store
   * (e.g. `useChat` observing a sessionId mid-stream), every other
   * `useSessions()` consumer must see it without a manual refetch.
   *
   * Before the fix, `useSessions()` held a private `useState` array, so
   * the second hook never observed the upsert. Locking this behaviour
   * here so a regression resurfaces in CI rather than as a UX bug.
   */
  it("reflects sessions added to the store from elsewhere (no refetch needed)", async () => {
    const { result } = renderHook(() => useSessions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.sessions).toHaveLength(1);

    // Simulate `useChat` (or any other hook) injecting a new session
    // into the shared store while our list is mounted.
    act(() => {
      store.upsertSession(
        fakeSession({
          id: "s2",
          title: undefined,
          createdAt: "2026-04-27T10:00:00Z",
          updatedAt: "2026-04-27T10:00:00Z",
          agent: "default",
        }),
      );
    });

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions.map((s) => s.id)).toContain("s2");
  });

  it("renameSession patches the store so other consumers re-render", async () => {
    const { result, rerender } = renderHook(() => useSessions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.renameSession("s1", "Renamed");
    });

    rerender();
    expect(result.current.sessions[0].title).toBe("Renamed");
  });

  it("deleteSession removes the session from the store", async () => {
    const { result } = renderHook(() => useSessions(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.deleteSession("s1");
    });

    expect(result.current.sessions).toHaveLength(0);
  });
});
