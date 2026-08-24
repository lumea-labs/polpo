import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  findVolumeByName,
  registerVolumesCommand,
  volumeDataFrom,
  volumeGrantBody,
  volumePath,
  volumeWriteBody,
} from "../src/commands/cloud/volumes.js";

describe("Volumes CLI", () => {
  it("encodes every volume and grant path segment", () => {
    expect(volumePath("volume/a")).toBe("/v1/files/volumes/volume%2Fa");
    expect(volumePath("grants", "agent/a", "volume b"))
      .toBe("/v1/files/volume-grants/agent%2Fa/volume%20b");
  });

  it("builds canonical create and update bodies without leaking CLI-only flags", () => {
    expect(volumeWriteBody({
      access: "read-write",
      label: "Build cache",
      mountPath: "/home/daytona/project/cache",
      name: "cache",
      strategy: "hydrated",
      writeBack: "manual",
    }, true)).toEqual({
      access: "read-write",
      label: "Build cache",
      mountPath: "/home/daytona/project/cache",
      name: "cache",
      strategy: "hydrated",
      writeBack: "manual",
    });

    expect(volumeWriteBody({
      clearLabel: true,
      clearWriteBack: true,
      defaultMountPath: true,
    }, false)).toEqual({
      label: null,
      mountPath: null,
      writeBack: null,
    });
  });

  it("rejects contradictory and incomplete local policy before making an API call", () => {
    expect(() => volumeWriteBody({ label: "x", clearLabel: true }, false))
      .toThrow(/clear-label/i);
    expect(() => volumeWriteBody({ mountPath: "/tmp/x", defaultMountPath: true }, false))
      .toThrow(/default-mount-path/i);
    expect(() => volumeWriteBody({ writeBack: "auto", clearWriteBack: true }, false))
      .toThrow(/clear-write-back/i);
    expect(() => volumeWriteBody({ name: "cache" }, true))
      .toThrow(/strategy is required/i);
    expect(() => volumeWriteBody({ name: "Cache", strategy: "mounted" }, true))
      .toThrow(/volume name/i);
    expect(() => volumeWriteBody({
      access: "read-only",
      name: "cache",
      strategy: "hydrated",
      writeBack: "auto",
    }, true)).toThrow(/read-only.*writeback/i);
    expect(() => volumeWriteBody({
      name: "cache",
      strategy: "mounted",
      writeBack: "manual",
    }, true)).toThrow(/mounted.*writeback/i);
  });

  it("does not guess an ambiguous or missing volume id for grants", () => {
    const volumes = [
      { id: "volume-1", name: "workspace" },
      { id: "volume-2", name: "assets" },
    ] as any;
    expect(findVolumeByName(volumes, "assets")).toMatchObject({ id: "volume-2" });
    expect(() => findVolumeByName(volumes, "missing")).toThrow(/not found/i);
  });

  it("builds grant narrowing and validates writeback combinations", () => {
    expect(volumeGrantBody({ access: "read-only" })).toEqual({ access: "read-only" });
    expect(volumeGrantBody({ access: "read-write", writeBack: "manual" }))
      .toEqual({ access: "read-write", writeBack: "manual" });
    expect(() => volumeGrantBody({ access: "read-only", writeBack: "auto" }))
      .toThrow(/read-only.*writeback/i);
  });

  it("surfaces stable API errors and malformed success envelopes", () => {
    expect(() => volumeDataFrom({
      status: 409,
      data: { ok: false, error: "Volume already exists.", code: "volume_conflict" },
    } as any)).toThrow("Volume already exists.");
    expect(() => volumeDataFrom({ status: 200, data: { ok: true } } as any))
      .toThrow(/missing data/i);
  });

  it("exposes full catalog and per-agent grant management", () => {
    const program = new Command();
    program.exitOverride();
    registerVolumesCommand(program);
    const volumes = program.commands.find((command) => command.name() === "volumes")!;
    expect(volumes.commands.map((command) => command.name())).toEqual(expect.arrayContaining([
      "list",
      "get",
      "create",
      "update",
      "remove",
      "grants",
    ]));

    const grants = volumes.commands.find((command) => command.name() === "grants")!;
    expect(grants.commands.map((command) => command.name())).toEqual([
      "list",
      "set",
      "revoke",
    ]);
    expect(grants.commands.find((command) => command.name() === "set")!
      .options.map((option) => option.long)).toEqual(expect.arrayContaining([
        "--agent",
        "--access",
        "--write-back",
        "--json",
      ]));
    expect(volumes.commands.find((command) => command.name() === "remove")!
      .options.map((option) => option.long)).toContain("--yes");
  });
});
