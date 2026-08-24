import { describe, expect, it } from "vitest";
import { agentVolumePreflightErrors } from "../src/commands/cloud/deploy.js";

const catalog = [{
  id: "volume-workspace",
  name: "workspace",
  strategy: "hydrated" as const,
  access: "read-write" as const,
  syncState: "ready" as const,
}];

describe("deploy agent volume preflight", () => {
  it("accepts an explicitly granted ready volume", () => {
    expect(agentVolumePreflightErrors({
      name: "builder",
      sandbox: {
        volumes: [{ name: "workspace", access: "read-write", writeBack: "auto" }],
      },
    }, catalog, [{
      agentName: "builder",
      volumeId: "volume-workspace",
      access: "read-write",
      writeBack: "auto",
    }])).toEqual([]);
  });

  it("fails with an actionable command when the agent has no grant", () => {
    expect(agentVolumePreflightErrors({
      name: "builder",
      sandbox: { volumes: [{ name: "workspace" }] },
    }, catalog, [])).toEqual([
      'volume "workspace" is not granted to agent "builder". Run: polpo volumes grants set workspace --agent builder',
    ]);
  });

  it("rejects missing and unavailable volumes before deploying the agent", () => {
    expect(agentVolumePreflightErrors({
      name: "builder",
      sandbox: { volumes: [{ name: "missing" }, { name: "workspace" }] },
    }, [{ ...catalog[0], syncState: "syncing" }], [{
      agentName: "builder",
      volumeId: "volume-workspace",
      access: "read-write",
      writeBack: "auto",
    }])).toEqual([
      'volume "missing" does not exist in the project catalog.',
      'volume "workspace" is syncing and cannot be deployed yet.',
    ]);
  });

  it("rejects writeback on mounted and effective read-only volumes", () => {
    expect(agentVolumePreflightErrors({
      name: "builder",
      sandbox: {
        volumes: [
          { name: "mounted", writeBack: "auto" },
          { name: "readonly", writeBack: "manual" },
        ],
      },
    }, [
      { ...catalog[0], id: "mounted-id", name: "mounted", strategy: "mounted" },
      { ...catalog[0], id: "readonly-id", name: "readonly", access: "read-only" },
    ], [
      { agentName: "builder", volumeId: "mounted-id", access: "read-write", writeBack: null },
      { agentName: "builder", volumeId: "readonly-id", access: "read-only", writeBack: null },
    ])).toEqual([
      'mounted volume "mounted" cannot configure writeBack.',
      'read-only volume "readonly" cannot configure writeBack.',
    ]);
  });

  it("does not require the volume API for agents without volume selections", () => {
    expect(agentVolumePreflightErrors({ name: "chat-only" }, [], [])).toEqual([]);
  });
});
