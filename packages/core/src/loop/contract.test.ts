import { describe, expect, it } from "vitest";
import { agentLoopConfigSchema, projectLoopConfigSchema } from "../schemas.js";
import { agentStep, bash, defineProjectLoop, otherwise, requireTool, toolStep, when, whileStep } from "./code.js";
import { normalizeProjectLoop } from "./normalize.js";
import type { ProjectLoopConfig } from "./types.js";

describe("agentLoopConfigSchema", () => {
  it("rejects ambiguous legacy and canonical tool restrictions", () => {
    const parsed = agentLoopConfigSchema.safeParse({
      loops: {
        work: {
          allowedTools: ["read"],
          tools: ["write"],
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
  it("accepts a loop collection with a deterministic pipeline", () => {
    const parsed = agentLoopConfigSchema.parse({
      name: "router-agent",
      runtime: "polpo-runner",
      loops: {
        classify: {
          systemPrompt: "Classify the request.",
          tools: ["read"],
          skills: ["classification"],
          output: {
            schema: {
              type: "object",
              properties: { route: { type: "string" } },
            },
          },
          stopWhen: { expression: "output.route != null" },
        },
        answer: {
          systemPrompt: "Answer the request.",
          tools: ["write"],
        },
      },
      pipeline: {
        context: "shared",
        steps: [
          { loop: "classify" },
          {
            switch: {
              cases: [
                { when: "output.route == 'answer'", steps: [{ loop: "answer" }] },
              ],
            },
          },
        ],
      },
    });

    expect(Object.keys(parsed.loops)).toEqual(["classify", "answer"]);
    expect(parsed.loops.classify.skills).toEqual(["classification"]);
    expect(parsed.pipeline?.steps).toHaveLength(2);
  });

  it("accepts structured model policies on loop model overrides", () => {
    const model = {
      primary: "anthropic/claude-sonnet-4",
      fallbacks: ["openai/gpt-4o-mini"],
    };

    const parsed = agentLoopConfigSchema.parse({
      name: "router-agent",
      model,
      loops: {
        classify: {
          model,
          systemPrompt: "Classify the request.",
        },
      },
    });

    expect(parsed.model).toEqual(model);
    expect(parsed.loops.classify.model).toEqual(model);
  });

  it("rejects pipelines that reference unknown loops", () => {
    const parsed = agentLoopConfigSchema.safeParse({
      loops: {
        classify: {},
      },
      pipeline: {
        steps: [{ loop: "missing" }],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('unknown loop "missing"');
  });

  it("accepts a project-level loop graph and normalizes it to executor shape", () => {
    const loop = projectLoopConfigSchema.parse({
      name: "coding-flow",
      context: "shared",
      start: "plan",
      steps: {
        plan: {
          type: "agent",
          systemPrompt: "Plan.",
          tools: ["read"],
          skills: ["planning"],
          next: "approve_plan",
        },
        approve_plan: {
          type: "human",
          next: [
            { when: "approve_plan.decision == 'approve'", to: "build" },
            { to: "end" },
          ],
        },
        build: {
          type: "agent",
          tools: ["read", "write", "edit"],
          toolChoice: { mode: "required", tool: "edit" },
          next: "clone_repo",
        },
        clone_repo: {
          type: "tool",
          tool: "clone_repository",
          input: {
            repoUrl: "https://github.com/acme/app.git",
            targetDir: "workspace/app",
          },
          saveAs: "repo.clone",
          next: "end",
        },
      },
    });

    const normalized = normalizeProjectLoop(loop as ProjectLoopConfig);
    expect(Object.keys(normalized.loops)).toEqual(["plan", "build"]);
    expect(normalized.loops.build.toolChoice).toEqual({ mode: "required", tool: "edit" });
    expect(normalized.pipeline?.steps).toMatchObject([
      { loop: "plan" },
      { human: "approve_plan" },
      { switch: { cases: [{ when: "approve_plan.decision == 'approve'" }] } },
    ]);
    expect(JSON.stringify(normalized.pipeline?.steps)).toContain("clone_repository");
  });

  it("preserves conditional transitions to end as empty switch branches", () => {
    const loop = defineProjectLoop({
      name: "preview-flow",
      start: "preview",
      steps: {
        preview: toolStep({
          tool: "site_preview_request",
          saveAs: "preview",
          next: [
            when("preview.ok == true", "end"),
            otherwise("report_preview_failure"),
          ],
        }),
        report_preview_failure: agentStep({
          systemPrompt: "Report the preview failure.",
          next: "end",
        }),
      },
    });

    expect(normalizeProjectLoop(loop).pipeline?.steps).toEqual([
      {
        tool: "site_preview_request",
        input: undefined,
        saveAs: "preview",
        when: undefined,
      },
      {
        switch: {
          cases: [{ when: "preview.ok == true", steps: [] }],
          default: { steps: [{ loop: "report_preview_failure", when: undefined }] },
        },
      },
    ]);
  });

  it("accepts the v1 governance contract fields without changing graph normalization", () => {
    const loop = projectLoopConfigSchema.parse({
      version: "1",
      kind: "graph",
      name: "governed-flow",
      description: "A loop with future governance metadata.",
      metadata: {
        owner: "platform",
        source: "dsl",
      },
      context: "shared",
      hooks: {
        "tool:before": [
          {
            tool: "policy_check",
            input: { mode: "strict" },
            saveAs: "policy.tool",
            onError: "fail",
          },
        ],
        "loop:end": [
          {
            tool: "audit_log",
            onError: "continue",
          },
        ],
      },
      permissions: [
        {
          id: "tools-allowlist",
          resource: "tool",
          action: "call",
          effect: "allow",
          match: { tool: ["read", "policy_check", "audit_log"] },
        },
        {
          id: "approval-for-write",
          resource: "tool",
          action: "call",
          effect: "approval",
          match: { tool: "write" },
          message: "Writing requires human approval.",
        },
      ],
      policies: [
        {
          id: "deny-dangerous-bash",
          hook: "tool:before",
          effect: "deny",
          when: "tool.name == 'bash' && args.command.includes('rm -rf')",
          message: "Dangerous shell command blocked.",
        },
      ],
      start: "work",
      steps: {
        work: {
          type: "agent",
          tools: ["read"],
          next: "end",
        },
      },
    });

    expect(loop.version).toBe("1");
    expect(loop.kind).toBe("graph");
    expect(loop.hooks?.["tool:before"]?.[0]?.tool).toBe("policy_check");
    expect(loop.permissions?.[0]?.resource).toBe("tool");
    expect(loop.permissions?.[1]?.effect).toBe("approval");
    expect(loop.policies?.[0]?.effect).toBe("deny");
    expect(normalizeProjectLoop(loop as ProjectLoopConfig).pipeline?.steps).toEqual([{ loop: "work" }]);
  });

  it("rejects unknown loop hook names", () => {
    const parsed = projectLoopConfigSchema.safeParse({
      name: "bad-hooks",
      start: "work",
      hooks: {
        "before:anything": [{ tool: "policy_check" }],
      },
      steps: {
        work: { type: "agent", next: "end" },
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('unknown loop hook "before:anything"');
  });

  it("builds code-first loop definitions without losing readable step metadata", () => {
    const loop = defineProjectLoop({
      name: "coding-flow",
      hooks: {
        "loop:start": [bash("echo start", { saveAs: "audit.start" })],
      },
      start: "plan",
      steps: {
        plan: agentStep({
          label: "Plan",
          description: "Inspect the request and prepare the implementation.",
          tools: ["read", "grep"],
          toolChoice: requireTool("grep"),
          next: "build",
        }),
        build: toolStep({
          label: "Build check",
          description: "Run the deterministic build command.",
          tool: "bash",
          input: { command: "pnpm build" },
          saveAs: "build",
          next: [when("build.exitCode != 0", "plan"), otherwise("end")],
        }),
      },
    });

    expect(loop).toMatchObject({
      version: "1",
      kind: "graph",
      context: "shared",
      hooks: {
        "loop:start": [{ tool: "bash", input: { command: "echo start" }, saveAs: "audit.start" }],
      },
      steps: {
        plan: {
          type: "agent",
          label: "Plan",
          description: "Inspect the request and prepare the implementation.",
          toolChoice: { mode: "required", tool: "grep" },
        },
        build: {
          type: "tool",
          label: "Build check",
          description: "Run the deterministic build command.",
          next: [{ when: "build.exitCode != 0", to: "plan" }, { to: "end" }],
        },
      },
    });
  });

  it("accepts explicit project-level while steps and normalizes their body", () => {
    const loop = defineProjectLoop({
      name: "retry-build",
      start: "retry_until_green",
      steps: {
        retry_until_green: whileStep({
          label: "Retry until green",
          description: "Repeat fix and build until the build passes.",
          until: "build.passed == true",
          maxIterations: 3,
          body: "fix",
          next: "finalize",
        }),
        fix: agentStep({
          systemPrompt: "Fix the failure.",
          next: "build_check",
        }),
        build_check: toolStep({
          tool: "build_check",
          saveAs: "build",
          next: "end",
        }),
        finalize: agentStep({
          systemPrompt: "Summarize.",
          next: "end",
        }),
      },
    });

    expect(normalizeProjectLoop(loop).pipeline?.steps).toMatchObject([
      {
        while: {
          until: "build.passed == true",
          maxIterations: 3,
          steps: [{ loop: "fix" }, { tool: "build_check", saveAs: "build" }],
        },
      },
      { loop: "finalize" },
    ]);
  });
});

describe("project loop agent input projection contract", () => {
  it("preserves input and inputSchema on agent steps through normalization", () => {
    const loop = projectLoopConfigSchema.parse({
      version: "1",
      kind: "graph",
      name: "repair-flow",
      start: "repair",
      steps: {
        repair: {
          type: "agent",
          input: {
            failures: { $context: "validation.failures" },
            attempt: 1,
          },
          inputSchema: {
            type: "object",
            required: ["failures", "attempt"],
          },
          next: "end",
        },
      },
    }) as ProjectLoopConfig;

    expect(normalizeProjectLoop(loop).loops.repair).toMatchObject({
      input: {
        failures: { $context: "validation.failures" },
        attempt: 1,
      },
      inputSchema: {
        type: "object",
        required: ["failures", "attempt"],
      },
    });
  });

  it("rejects inputSchema without input and malformed schemas at config load", () => {
    const base = { name: "repair-flow", start: "repair" };

    expect(projectLoopConfigSchema.safeParse({
      ...base,
      steps: {
        repair: { type: "agent", inputSchema: { type: "object" }, next: "end" },
      },
    }).success).toBe(false);

    expect(projectLoopConfigSchema.safeParse({
      ...base,
      steps: {
        repair: {
          type: "agent",
          input: {},
          inputSchema: { $ref: "https://example.com/remote.json" },
          next: "end",
        },
      },
    }).success).toBe(false);
  });
});
