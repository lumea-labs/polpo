import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { addEnvironmentOptions, resolveCliEnvironment } from "../../src/commands/cloud/environment.js";

describe("CLI environment selection", () => {
  it("defaults to Development on every invocation", () => {
    expect(resolveCliEnvironment({})).toBe("development");
    expect(resolveCliEnvironment({ prod: true })).toBe("production");
    expect(resolveCliEnvironment({})).toBe("development");
  });
  it.each(["development", "production"])("accepts an explicit %s target", env => {
    expect(resolveCliEnvironment({ env })).toBe(env);
  });
  it.each(["test", "live", "dev", "", "Production", null])("rejects %j", env => {
    expect(() => resolveCliEnvironment({ env: env as string })).toThrow();
  });
  it("rejects a conflicting selector before the action (including authentication)", async () => {
    const program = new Command().exitOverride();
    const action = vi.fn();
    addEnvironmentOptions(program.command("deploy")).action(action);
    await expect(program.parseAsync(["deploy", "--env", "development", "--prod"], { from: "user" }))
      .rejects.toThrow(/conflict/i);
    expect(action).not.toHaveBeenCalled();
  });
});
