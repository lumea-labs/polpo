// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { EventSourceConfig } from "@polpo-ai/sdk";
import { PolpoProvider, type PolpoProviderProps } from "../provider/polpo-provider.js";
import { usePolpoContext, type PolpoContextValue } from "../provider/polpo-context.js";
import { fakeAgent } from "./helpers.js";

const streams = vi.hoisted(() => [] as Array<{
  config: EventSourceConfig;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}>);
vi.mock("@polpo-ai/sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@polpo-ai/sdk")>(),
  EventSourceManager: class {
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(public config: EventSourceConfig) { streams.push(this); }
  },
}));

function ok(data: unknown = []) {
  return Response.json({ ok: true, data });
}

describe("PolpoProvider environment boundary", () => {
  let current: PolpoContextValue;
  function Probe() {
    current = usePolpoContext();
    const [draft, setDraft] = useState("");
    return <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />;
  }
  const base = { baseUrl: "/api/projects/project-a", apiPrefix: "/v1" };
  function tree(props: Omit<PolpoProviderProps, "baseUrl" | "children">) {
    return <PolpoProvider {...base} {...props}><Probe /></PolpoProvider>;
  }

  beforeEach(() => { streams.length = 0; });
  afterEach(cleanup);

  it("replaces client, store, stream and child state when the environment changes", async () => {
    const fetch = vi.fn(async () => ok());
    const view = render(tree({ environment: "development", fetch }));
    const development = current!;
    act(() => development.store.setAgents([fakeAgent({ name: "dev-only" })]));
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "dev draft" } });

    view.rerender(tree({ environment: "production", fetch }));
    const production = current!;
    expect(production.client).not.toBe(development.client);
    expect(production.store).not.toBe(development.store);
    expect(production.store.getSnapshot().agents).toEqual([]);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("");
    expect(streams[0].disconnect).toHaveBeenCalledOnce();
    expect(streams[1].config.url).toContain("/environments/production/v1/events");
    await development.client.getAgents();
    await production.client.getAgents();
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/projects/project-a/environments/development/v1/agents",
      "/api/projects/project-a/environments/production/v1/agents",
    ]);
  });

  it("discards queued events, late callbacks and reconnect snapshots after switching", async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const view = render(tree({ environment: "development", fetch }));
    const old = current!;
    const oldStream = streams[0];
    const apply = vi.spyOn(old.store, "applyEventBatch");
    const setAgents = vi.spyOn(old.store, "setAgents");
    act(() => {
      oldStream.config.onStatusChange("connected");
      oldStream.config.onEvent({ id: "late", event: "log", data: { message: "dev" }, timestamp: new Date().toISOString() });
      view.rerender(tree({ environment: "production", fetch }));
    });
    await act(async () => {
      for (const resolve of pending) resolve(ok());
      oldStream.config.onStatusChange("connected");
      oldStream.config.onEvent({ id: "later", event: "log", data: {}, timestamp: new Date().toISOString() });
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(apply).not.toHaveBeenCalled();
    expect(setAgents).not.toHaveBeenCalled();
    expect(current!.store.getSnapshot().connectionStatus).toBe("disconnected");
    expect(current!.store.getSnapshot().recentEvents).toEqual([]);
  });

  it("preserves a scope on ordinary renders and user changes", () => {
    const fetch = vi.fn(async () => ok());
    const view = render(tree({ environment: "development", user: "one", fetch }));
    const initial = current!;
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "keep" } });
    view.rerender(tree({ environment: "development", user: "two", fetch }));
    expect(current!).toBe(initial);
    expect(streams).toHaveLength(1);
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("keep");
  });

  it("rebuilds for a different authenticated fetch function", async () => {
    const first = vi.fn(async () => ok());
    const second = vi.fn(async () => ok());
    const view = render(tree({ environment: "development", fetch: first }));
    const old = current!;
    view.rerender(tree({ environment: "development", fetch: second }));
    expect(current!.client).not.toBe(old.client);
    await current!.client.getAgents();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps two simultaneously mounted providers independent", async () => {
    const fetch = vi.fn(async () => ok());
    render(tree({ environment: "development", fetch }));
    const development = current!;
    render(tree({ environment: "production", fetch }));
    const production = current!;
    expect(production.store).not.toBe(development.store);
    await Promise.all([development.client.getAgents(), production.client.getAgents()]);
    expect(streams.map(({ config }) => config.url)).toEqual([
      "/api/projects/project-a/environments/development/v1/events",
      "/api/projects/project-a/environments/production/v1/events",
    ]);
  });
});
