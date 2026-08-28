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

  it("preserves human metadata and logical groups on inline pipeline steps", () => {
    const parsed = agentLoopConfigSchema.parse({
      loops: {
        classify: {},
        process: {},
      },
      pipeline: {
        groups: {
          invoice_processing: {
            label: "Processing invoice",
            description: "Extract and validate invoice data.",
          },
        },
        steps: [
          {
            key: "classify_invoice",
            label: "Classify invoice",
            description: "Determine the invoice route.",
            group: "invoice_processing",
            loop: "classify",
          },
          {
            label: "Choose processing route",
            group: "invoice_processing",
            switch: {
              cases: [{
                label: "New customer",
                description: "The invoice belongs to a new customer.",
                when: "classification.customer == 'new'",
                steps: [{
                  label: "Process new customer invoice",
                  group: "invoice_processing",
                  loop: "process",
                }],
              }],
              default: {
                label: "Existing customer",
                steps: [{ loop: "process", group: "invoice_processing" }],
              },
            },
          },
        ],
      },
    });

    expect(parsed.pipeline?.groups?.invoice_processing).toEqual({
      label: "Processing invoice",
      description: "Extract and validate invoice data.",
    });
    expect(parsed.pipeline?.steps[0]).toMatchObject({
      key: "classify_invoice",
      label: "Classify invoice",
      description: "Determine the invoice route.",
      group: "invoice_processing",
    });
    expect((parsed.pipeline?.steps[1] as any).switch.cases[0]).toMatchObject({
      label: "New customer",
      description: "The invoice belongs to a new customer.",
    });
    expect((parsed.pipeline?.steps[1] as any).switch.default).toMatchObject({
      label: "Existing customer",
    });
  });

  it("rejects inline steps that reference an unknown logical group", () => {
    const parsed = agentLoopConfigSchema.safeParse({
      loops: { classify: {} },
      pipeline: {
        steps: [{ loop: "classify", group: "missing" }],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) =>
      issue.message.includes('unknown group "missing"'))).toBe(true);
  });

  it("rejects unknown logical groups in nested inline branches", () => {
    const parsed = agentLoopConfigSchema.safeParse({
      loops: { classify: {} },
      pipeline: {
        groups: { known: { label: "Known" } },
        steps: [{
          switch: {
            cases: [{
              when: "true",
              steps: [{ loop: "classify", group: "missing" }],
            }],
          },
        }],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) =>
      issue.message.includes('unknown group "missing"'))).toBe(true);
  });

  it("rejects empty logical group display metadata", () => {
    const parsed = projectLoopConfigSchema.safeParse({
      name: "invalid-group-label",
      groups: { processing: { label: "" } },
      start: "work",
      steps: { work: { type: "agent", next: "end" } },
    });

    expect(parsed.success).toBe(false);
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

  it("preserves project-loop groups and human transition labels when normalizing", () => {
    const loop = projectLoopConfigSchema.parse({
      name: "invoice-flow",
      groups: {
        invoice_processing: {
          label: "Processing invoice",
          description: "Extract, validate, and reconcile.",
        },
      },
      start: "classify",
      steps: {
        classify: {
          type: "agent",
          label: "Classify invoice",
          group: "invoice_processing",
          next: [
            {
              when: "classification.customer == 'new'",
              label: "New customer",
              description: "Start customer onboarding.",
              to: "process",
            },
            { label: "Existing customer", to: "end" },
          ],
        },
        process: {
          type: "tool",
          label: "Process invoice",
          group: "invoice_processing",
          tool: "invoice_process",
          next: "end",
        },
      },
    }) as ProjectLoopConfig;

    const normalized = normalizeProjectLoop(loop);

    expect(normalized.pipeline?.groups).toEqual(loop.groups);
    expect(normalized.pipeline?.steps[0]).toMatchObject({
      key: "classify",
      label: "Classify invoice",
      group: "invoice_processing",
    });
    expect((normalized.pipeline?.steps[1] as any).switch.cases[0]).toMatchObject({
      label: "New customer",
      description: "Start customer onboarding.",
    });
    expect((loop.steps.classify.next as any[])[1]).toMatchObject({
      label: "Existing customer",
      to: "end",
    });
  });

  it("rejects project steps that reference an unknown logical group", () => {
    const parsed = projectLoopConfigSchema.safeParse({
      name: "invalid-group",
      start: "work",
      steps: {
        work: { type: "agent", group: "missing", next: "end" },
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) =>
      issue.message.includes('unknown group "missing"'))).toBe(true);
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
        key: "preview",
        tool: "site_preview_request",
        input: undefined,
        saveAs: "preview",
        when: undefined,
      },
      {
        switch: {
          cases: [{ when: "preview.ok == true", steps: [] }],
          default: { steps: [{ key: "report_preview_failure", loop: "report_preview_failure", when: undefined }] },
        },
      },
    ]);
  });

  it("accepts the v1 governance contract fields while preserving graph identity", () => {
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
    expect(normalizeProjectLoop(loop as ProjectLoopConfig).pipeline?.steps).toEqual([
      { key: "work", loop: "work", when: undefined },
    ]);
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
          next: [
            when("build.exitCode != 0", "plan", { label: "Retry planning" }),
            otherwise("end", { label: "Build passed" }),
          ],
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
          next: [
            { when: "build.exitCode != 0", to: "plan", label: "Retry planning" },
            { to: "end", label: "Build passed" },
          ],
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

describe("project loop agent output contract", () => {
  it("rejects malformed output schemas at config load", () => {
    const parsed = projectLoopConfigSchema.safeParse({
      name: "structured-flow",
      start: "implement",
      steps: {
        implement: {
          type: "agent",
          output: {
            schema: { $ref: "https://example.com/remote.json" },
          },
          next: "end",
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects boolean output schemas that providers cannot enforce portably", () => {
    const parsed = projectLoopConfigSchema.safeParse({
      name: "structured-flow",
      start: "implement",
      steps: {
        implement: {
          type: "agent",
          output: { schema: true },
          next: "end",
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
