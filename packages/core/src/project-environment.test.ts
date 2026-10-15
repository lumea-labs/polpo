import { describe, expect, it } from "vitest";
import {
  parseProjectEnvironment,
  projectEnvironmentBaseUrl,
  readProjectEnvironmentPath,
} from "./project-environment.js";

describe("project environment transport contract", () => {
  it.each(["development", "production"])("accepts only the canonical name %s", name => {
    expect(parseProjectEnvironment(name)).toBe(name);
  });

  it.each([undefined, null, "", "dev", "test", "live", "sandbox", "Production", " production", {}, 1])(
    "rejects an invalid environment without inferring a target (%j)", value => {
      expect(() => parseProjectEnvironment(value)).toThrow(/development.*production/);
    },
  );

  it("preserves project proxy paths and uses a route old servers cannot ignore", () => {
    expect(projectEnvironmentBaseUrl("https://api.polpo.sh/", "development"))
      .toBe("https://api.polpo.sh/environments/development");
    expect(projectEnvironmentBaseUrl("/api/projects/project-a", "production"))
      .toBe("/api/projects/project-a/environments/production");
    expect(projectEnvironmentBaseUrl("https://api.polpo.sh/environments/development/", "development"))
      .toBe("https://api.polpo.sh/environments/development");
  });

  it.each([
    "https://api.polpo.sh/environments/production",
    "https://api.polpo.sh/environments/test",
    "https://api.polpo.sh/environments/development/environments/development",
    "https://api.polpo.sh?environment=production",
    "https://api.polpo.sh#production",
  ])("rejects an ambiguous or conflicting base URL (%s)", url => {
    expect(() => projectEnvironmentBaseUrl(url, "development")).toThrow();
  });

  it("unwraps a namespaced path without trusting the selector as authorization", () => {
    expect(readProjectEnvironmentPath("/environments/development/v1/chat/completions"))
      .toEqual({ environment: "development", path: "/v1/chat/completions" });
    expect(readProjectEnvironmentPath("/v1/chat/completions")).toBeUndefined();
    expect(readProjectEnvironmentPath("/environments/development/v1/agents/environments"))
      .toEqual({ environment: "development", path: "/v1/agents/environments" });
    expect(readProjectEnvironmentPath("/environments/production"))
      .toEqual({ environment: "production", path: "/" });
    expect(() => readProjectEnvironmentPath("/environments/test/v1/agents")).toThrow();
    expect(() => readProjectEnvironmentPath("/environments/development/environments/production/v1/agents"))
      .toThrow();
  });
});
