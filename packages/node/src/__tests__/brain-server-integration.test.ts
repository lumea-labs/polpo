import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function testApp(workDir: string) {
  const orchestrator = {
    isInitialized: true,
  };
  return createApp(orchestrator as never, {} as never, { workDir });
}

describe("self-hosted Brain API", () => {
  it("persists a source and retrieves it after an app restart", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "polpo-brain-server-"));
    roots.push(workDir);
    const first = testApp(workDir);
    const created = await first.request("/api/v1/brain/sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "Support runbook",
        trust: "user_provided",
        content: {
          kind: "paste",
          text: "Refunds are reviewed within five business days.",
        },
      }),
    });

    expect(created.status).toBe(201);
    const createdPayload = await created.json() as {
      data: { id: string; scope: { subjectId: string } };
    };
    expect(createdPayload.data.scope.subjectId).toBe(
      workDir.split("/").at(-1),
    );

    const restarted = testApp(workDir);
    const source = await restarted.request(
      `/api/v1/brain/sources/${encodeURIComponent(createdPayload.data.id)}`,
    );
    const search = await restarted.request("/api/v1/brain/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "refunds" }),
    });

    expect(source.status).toBe(200);
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({
      ok: true,
      data: [{
        chunk: {
          citation: {
            sourceId: createdPayload.data.id,
          },
        },
      }],
    });
    const snapshot = JSON.parse(
      readFileSync(join(workDir, ".polpo", "brain.json"), "utf8"),
    );
    expect(snapshot.sources).toHaveLength(1);
  });

  it("does not mount Brain persistence when a composition root omits it", async () => {
    const app = createApp(
      { isInitialized: true } as never,
      {} as never,
    );

    const response = await app.request("/api/v1/brain/sources");

    expect(response.status).toBe(404);
  });
});
