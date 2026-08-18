import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/util/auth.js", () => ({
  requireAuth: vi.fn(async () => ({
    apiKey: "test-key",
    baseUrl: "https://api.example.test",
  })),
}));

import {
  deployExitCode,
  hasDeployFailures,
  runDeploy,
  type DeployResult,
} from "../src/commands/cloud/deploy.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function deployFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "polpo-deploy-test-"));
  roots.push(root);
  const polpoDir = join(root, ".polpo");
  await mkdir(join(polpoDir, "tools"), { recursive: true });
  await mkdir(join(polpoDir, "loops"), { recursive: true });
  await writeFile(join(polpoDir, "project.json"), JSON.stringify({
    schemaVersion: 2,
    project: "deploy-order",
    projectId: "project-1",
    projectSlug: "deploy-order-project",
  }));
  await writeFile(join(polpoDir, "tools", "project_checkout.ts"), `
    export default {
      name: "project_checkout",
      description: "Checkout a project",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    };
  `);
  await writeFile(join(polpoDir, "loops", "build.json"), JSON.stringify({
    name: "build",
    start: "checkout",
    steps: {
      checkout: {
        type: "tool",
        tool: "project_checkout",
        next: "end",
      },
    },
  }));
  return root;
}

describe("cloud deploy dependency order", () => {
  it("deploys custom tools before loops that reference them", async () => {
    const root = await deployFixture();
    const calls: string[] = [];
    let toolAvailable = false;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (method === "GET" && url.pathname === "/v1/tools") {
        return Response.json({ ok: true, data: [] });
      }
      if (method === "POST" && url.pathname === "/v1/tools") {
        toolAvailable = true;
        return Response.json({ ok: true, data: { name: "project_checkout" } });
      }
      if (method === "POST" && url.pathname === "/v1/loops") {
        if (!toolAvailable) {
          return Response.json(
            { ok: false, error: "references unknown tool project_checkout" },
            { status: 400 },
          );
        }
        return Response.json({ ok: true, data: { name: "build" } });
      }
      return Response.json({ ok: false, error: "unexpected request" }, { status: 500 });
    }));

    const report = await runDeploy({
      dir: root,
      yes: true,
      force: true,
      silent: true,
    });

    expect(report.total.failed).toBe(0);
    expect(calls).toEqual([
      "GET /v1/tools",
      "POST /v1/tools",
      "POST /v1/loops",
    ]);
  });

  it("returns a non-zero exit decision for every partial-failure shape", () => {
    const result = (patch: Partial<DeployResult>): DeployResult => ({
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
      details: [],
      ...patch,
    });

    expect(hasDeployFailures(result({}))).toBe(false);
    expect(deployExitCode(result({}))).toBe(0);
    expect(deployExitCode(result({ failed: 1 }))).toBe(1);
    expect(deployExitCode(result({ errors: ["loop failed"] }))).toBe(1);
  });

  it("keeps a dependency failure visible and returns a failed deploy", async () => {
    const root = await deployFixture();
    const calls: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (method === "GET" && url.pathname === "/v1/tools") {
        return Response.json({ ok: true, data: [] });
      }
      if (method === "POST" && url.pathname === "/v1/tools") {
        return Response.json(
          { ok: false, error: "tool compilation failed" },
          { status: 400 },
        );
      }
      if (method === "POST" && url.pathname === "/v1/loops") {
        return Response.json(
          { ok: false, error: "references unknown tool project_checkout" },
          { status: 400 },
        );
      }
      return Response.json({ ok: false, error: "unexpected request" }, { status: 500 });
    }));

    const report = await runDeploy({
      dir: root,
      yes: true,
      force: true,
      silent: true,
    });

    expect(calls).toEqual([
      "GET /v1/tools",
      "POST /v1/tools",
      "POST /v1/loops",
    ]);
    expect(report.total.failed).toBe(2);
    expect(report.total.errors).toEqual([
      'tool "project_checkout": tool compilation failed',
      'loop "build": deploy failed — references unknown tool project_checkout',
    ]);
    expect(deployExitCode(report.total)).toBe(1);
  });
});

describe("cloud deploy skill bundles", () => {
  async function skillFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "polpo-skill-deploy-test-"));
    roots.push(root);
    const skillDir = join(root, ".polpo", "skills", "frontend-design");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await writeFile(join(root, ".polpo", "project.json"), JSON.stringify({
      schemaVersion: 2,
      project: "skill-bundle",
      projectId: "project-1",
      projectSlug: "skill-bundle-project",
    }));
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: frontend-design\ndescription: Design interfaces\n---\n\nUse the guide.",
    );
    await writeFile(join(skillDir, "references", "guide.md"), "# Guide\n");
    await writeFile(join(skillDir, "assets", "palette.bin"), Buffer.from([0, 1, 2, 255]));
    return root;
  }

  it("deploys every nested text and binary file in a skill bundle", async () => {
    const root = await skillFixture();
    let payload: any;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/v1/skills") {
        return Response.json({ ok: true, data: [] });
      }
      if (method === "PUT" && url.pathname === "/v1/skills/frontend-design/bundle") {
        payload = JSON.parse(String(init?.body));
        return Response.json({ ok: true, data: { name: "frontend-design" } });
      }
      return Response.json({ ok: false, error: `unexpected ${method} ${url.pathname}` }, { status: 500 });
    }));

    const report = await runDeploy({ dir: root, yes: true, force: true, silent: true });

    expect(report.total.failed).toBe(0);
    expect(payload.files.map((file: any) => file.path)).toEqual([
      "assets/palette.bin",
      "references/guide.md",
      "SKILL.md",
    ]);
    const binary = payload.files.find((file: any) => file.path === "assets/palette.bin");
    expect(Buffer.from(binary.content, "base64")).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("fails closed instead of following symlinks outside the skill bundle", async () => {
    const root = await skillFixture();
    const outside = join(root, "secret.txt");
    await writeFile(outside, "do not upload");
    await symlink(outside, join(root, ".polpo", "skills", "frontend-design", "secret.txt"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const report = await runDeploy({ dir: root, yes: true, force: true, silent: true });

    expect(report.total.failed).toBe(1);
    expect(report.total.errors.join("\n")).toContain("symbolic link");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });
});
