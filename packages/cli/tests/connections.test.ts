import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  connectionDataFrom,
  parseJsonArray,
  parseJsonObject,
  projectConnectionsPath,
  registerConnectionsCommand,
} from "../src/commands/cloud/connections.js";

describe("Connections CLI", () => {
  it("encodes project and resource path segments", () => {
    expect(projectConnectionsPath("project/a", "connections", "conn b"))
      .toBe("/v1/projects/project%2Fa/connect/connections/conn%20b");
  });

  it("accepts only JSON objects for trusted scope inputs", () => {
    expect(parseJsonObject('{"tenant":{"namespace":"app","id":"tenant-1"}}', "--binding"))
      .toEqual({ tenant: { namespace: "app", id: "tenant-1" } });
    expect(() => parseJsonObject("[]", "--binding")).toThrow(/JSON object/);
    expect(() => parseJsonObject("{", "--binding")).toThrow(/valid JSON/);
    expect(parseJsonArray('[{"methods":["GET"]}]', "--operations"))
      .toEqual([{ methods: ["GET"] }]);
    expect(() => parseJsonArray("{}", "--operations")).toThrow(/JSON array/);
  });

  it("surfaces stable Cloud error codes", () => {
    expect(() => connectionDataFrom({
      status: 409,
      data: {
        ok: false,
        code: "connection_selection_ambiguous",
        error: "More than one Connection matched",
      },
    })).toThrow("More than one Connection matched");
  });

  it("exposes trusted management without credential arguments", () => {
    const program = new Command();
    program.exitOverride();
    registerConnectionsCommand(program);
    const command = program.commands.find((item) => item.name() === "connections")!;
    const names = command.commands.map((item) => item.name());
    expect(names).toEqual(expect.arrayContaining([
      "catalog",
      "list",
      "grants",
      "links",
      "link",
      "unlink",
      "setup-session",
      "setup-status",
      "capabilities",
      "events",
      "health",
      "bind",
      "grant-slot",
      "revoke-slot",
      "readiness",
    ]));
    const options = command.commands.flatMap((item) => item.options.map((option) => option.long));
    expect(options).not.toEqual(expect.arrayContaining([
      "--token",
      "--secret",
      "--password",
      "--api-key",
    ]));
  });
});
