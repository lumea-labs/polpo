import { describe, expect, it, vi } from "vitest";
import { taskRoutes } from "./tasks.js";
import { missionRoutes } from "./missions.js";

describe.each([
  { resource: "tasks", factory: taskRoutes, method: "createTask", payload: { title: "Read", description: "Read account", assignTo: "support" } },
  { resource: "missions", factory: missionRoutes, method: "createMission", payload: { data: '{"tasks":[]}' } },
])("$resource caller metadata API", ({ factory, method, payload }) => {
  it("forwards the authenticated caller context to creation and describes it in OpenAPI", async () => {
    const create = vi.fn(async (input: unknown) => input);
    const app = factory(() => ({ [method]: create }) as any);
    const metadata = { connectionNamespace: "app-a" };
    const response = await app.request("/", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, user: "customer-a", metadata }) });
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ user: "customer-a", metadata }));
    expect((await response.json()).data.metadata).toEqual(metadata);
    const doc = app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "Fixture", version: "1" } });
    expect(JSON.stringify(doc.paths?.["/"]?.post?.requestBody)).toContain('"metadata"');
  });

  it.each([null, { connectionNamespace: 12 }, { connectionNamespace: { id: "forged" } }, { connectionNamespace: "x".repeat(513) }])(
    "rejects invalid context before creating work: %j", async metadata => {
      const create = vi.fn();
      const app = factory(() => ({ [method]: create }) as any);
      const response = await app.request("/", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, metadata }) });
      expect(response.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    });
});
