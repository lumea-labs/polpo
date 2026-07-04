import { describe, it, expect } from "vitest";
import { resolveExecutionMode } from "../execution-mode.js";

describe("resolveExecutionMode — adaptive isolation precedence", () => {
  it("defaults to subprocess with nothing set", () => {
    expect(resolveExecutionMode()).toBe("subprocess");
    expect(resolveExecutionMode({}, {}, {})).toBe("subprocess");
  });

  it("settings tier applies when task and agent are silent", () => {
    expect(resolveExecutionMode({}, {}, { taskExecution: "in-process" })).toBe("in-process");
  });

  it("agent beats settings", () => {
    expect(resolveExecutionMode({}, { executionMode: "subprocess" }, { taskExecution: "in-process" })).toBe("subprocess");
    expect(resolveExecutionMode({}, { executionMode: "in-process" }, { taskExecution: "subprocess" })).toBe("in-process");
  });

  it("task beats agent and settings", () => {
    expect(
      resolveExecutionMode(
        { executionMode: "in-process" },
        { executionMode: "subprocess" },
        { taskExecution: "subprocess" },
      ),
    ).toBe("in-process");
    expect(
      resolveExecutionMode(
        { executionMode: "subprocess" },
        { executionMode: "in-process" },
        { taskExecution: "in-process" },
      ),
    ).toBe("subprocess");
  });

  it("invalid values fall through to the next tier", () => {
    expect(resolveExecutionMode({ executionMode: "warp-drive" }, { executionMode: "in-process" })).toBe("in-process");
    expect(resolveExecutionMode({ executionMode: "" }, {}, { taskExecution: "in-process" })).toBe("in-process");
    expect(resolveExecutionMode({ executionMode: "warp" }, { executionMode: "nope" }, { taskExecution: "bad" })).toBe("subprocess");
  });
});
