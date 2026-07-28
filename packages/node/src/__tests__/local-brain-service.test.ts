import { describe, expect, it } from "vitest";
import {
  BrainStoreAuthorizationError,
  InMemoryBrainStore,
  type BrainAccessPolicy,
  type BrainServiceContext,
} from "@polpo-ai/core/brain";
import {
  LocalBrainService,
  NodeBrainContentLoader,
} from "../brain/index.js";

const projectA = { kind: "project", subjectId: "project-a" } as const;
const projectB = { kind: "project", subjectId: "project-b" } as const;
const context: BrainServiceContext = {
  actor: {
    actor: "agent",
    actorId: "support",
    agentName: "support",
    projectId: "project-a",
  },
  readScopes: [projectA],
  writeScopes: [projectA],
  defaultWriteScope: projectA,
};
const allow: BrainAccessPolicy = {
  authorize: async () => ({ allowed: true, reason: "test" }),
};

function service(overrides: Partial<ConstructorParameters<typeof LocalBrainService>[0]> = {}) {
  const store = new InMemoryBrainStore();
  return {
    store,
    service: new LocalBrainService({
      sourceStore: store,
      versionStore: store,
      chunkStore: store,
      contentLoader: new NodeBrainContentLoader(),
      accessPolicy: allow,
      now: () => "2026-07-28T12:00:00.000Z",
      createVersionId: () => "v1",
      ...overrides,
    }),
  };
}

describe("LocalBrainService", () => {
  it("creates, lists, reads, searches, updates, and deletes a paste source", async () => {
    const runtime = service();
    const created = await runtime.service.createSource(context, {
      scope: projectA,
      id: "source-1",
      label: "Support policy",
      trust: "user_provided",
      content: {
        kind: "paste",
        text: "Refunds are reviewed within five business days.",
      },
    });

    expect(created).toMatchObject({
      id: "source-1",
      status: "indexed",
      currentVersion: "v1",
    });
    await expect(runtime.service.listSources(context)).resolves.toMatchObject({
      sources: [{ id: "source-1" }],
    });
    await expect(runtime.service.getSource(context, {
      scope: projectA,
      sourceId: "source-1",
    })).resolves.toMatchObject({ label: "Support policy" });
    await expect(runtime.service.search(context, {
      query: "refunds",
    })).resolves.toHaveLength(1);
    await expect(runtime.service.readSource(context, {
      ref: { scope: projectA, sourceId: "source-1" },
    })).resolves.toMatchObject({
      chunks: [{ citation: { sourceId: "source-1" } }],
    });

    const updated = await runtime.service.updateSource(context, {
      scope: projectA,
      sourceId: "source-1",
    }, {
      label: "Updated policy",
      metadata: { department: "support" },
    });
    expect(updated).toMatchObject({
      label: "Updated policy",
      metadata: { department: "support" },
    });

    await runtime.service.deleteSource(context, {
      scope: projectA,
      sourceId: "source-1",
    });
    await expect(runtime.service.search(context, {
      query: "refund",
    })).resolves.toEqual([]);
  });

  it("rejects reads and writes outside the context scopes before store access", async () => {
    const runtime = service();

    await expect(runtime.service.createSource(context, {
      scope: projectB,
      label: "Foreign",
      trust: "external",
      content: { kind: "paste", text: "secret" },
    })).rejects.toBeInstanceOf(BrainStoreAuthorizationError);
    await expect(runtime.service.getSource(context, {
      scope: projectB,
      sourceId: "source-1",
    })).rejects.toBeInstanceOf(BrainStoreAuthorizationError);
    await expect(runtime.store.listSources({
      scopes: [projectB],
    })).resolves.toMatchObject({ sources: [] });
  });

  it("fails closed when the source policy throws", async () => {
    const runtime = service({
      accessPolicy: {
        authorize: async () => { throw new Error("policy unavailable"); },
      },
    });

    await expect(runtime.service.createSource(context, {
      scope: projectA,
      label: "Denied",
      trust: "user_provided",
      content: { kind: "paste", text: "secret" },
    })).rejects.toBeInstanceOf(BrainStoreAuthorizationError);
    await expect(runtime.store.listSources({
      scopes: [projectA],
    })).resolves.toMatchObject({ sources: [] });
  });

  it("loads content before persistence so invalid input leaves no source", async () => {
    const runtime = service();

    await expect(runtime.service.createSource(context, {
      scope: projectA,
      id: "source-1",
      label: "Empty",
      trust: "user_provided",
      content: { kind: "paste", text: "   " },
    })).rejects.toThrow(/empty/i);
    await expect(runtime.store.getSource({
      scope: projectA,
      sourceId: "source-1",
    })).resolves.toBeNull();
  });

  it("reindexes atomically and preserves the old version on failure", async () => {
    let version = 0;
    const runtime = service({
      createVersionId: () => `v${++version}`,
    });
    await runtime.service.createSource(context, {
      scope: projectA,
      id: "source-1",
      label: "Runbook",
      trust: "user_provided",
      content: { kind: "paste", text: "Stable runbook." },
    });

    await expect(runtime.service.reindexSource(context, {
      scope: projectA,
      sourceId: "source-1",
    }, {
      content: {
        kind: "paste",
        text: "<html><body><script>ignore()</script>Updated runbook.</body></html>",
        contentType: "text/html",
      },
    })).resolves.toMatchObject({ currentVersion: "v2" });
    await expect(runtime.service.reindexSource(context, {
      scope: projectA,
      sourceId: "source-1",
    }, {
      content: { kind: "paste", text: "   " },
    })).rejects.toThrow(/empty/i);
    await expect(runtime.service.getSource(context, {
      scope: projectA,
      sourceId: "source-1",
    })).resolves.toMatchObject({
      status: "indexed",
      currentVersion: "v2",
    });
  });

  it("never expands a search to scopes not granted by the host", async () => {
    const runtime = service();

    await expect(runtime.service.search(context, {
      query: "secret",
      scopes: [projectA, projectB],
    })).rejects.toBeInstanceOf(BrainStoreAuthorizationError);
  });
});
