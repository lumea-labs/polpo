import type { AgentLoopConfig, LoopNext, Pipeline, ProjectLoopConfig, Step } from "./types.js";

function transitionSteps(next: LoopNext | undefined, loop: ProjectLoopConfig, seen: Set<string>): Step[] {
  if (!next || next === "end") return [];
  if (typeof next === "string") return stepFor(next, loop, new Set(seen));

  const cases = next
    .filter((t) => t.to !== "end" && t.when)
    .map((t) => ({ when: t.when!, steps: stepFor(t.to, loop, new Set(seen)) }));
  const fallback = next.find((t) => !t.when);

  if (cases.length === 0) {
    return fallback && fallback.to !== "end" ? stepFor(fallback.to, loop, new Set(seen)) : [];
  }

  return [
    {
      switch: {
        cases,
        ...(fallback && fallback.to !== "end" ? { default: { steps: stepFor(fallback.to, loop, new Set(seen)) } } : {}),
      },
    },
  ];
}

function stepFor(id: string, loop: ProjectLoopConfig, seen = new Set<string>()): Step[] {
  if (id === "end" || seen.has(id)) return [];
  seen.add(id);

  const node = loop.steps[id];
  if (!node) return [];

  if (node.type === "human") {
    return [
      {
        human: id,
        when: node.when,
        output: node.output,
        notify: node.notify,
      },
      ...transitionSteps(node.next, loop, seen),
    ];
  }

  if (node.type === "parallel") {
    return [
      {
        parallel: node.branches.map((branch) => {
          const nested = stepFor(branch, loop, new Set(seen));
          return nested.length ? nested : [{ loop: branch }];
        }),
        join: node.join,
        when: node.when,
      },
      ...transitionSteps(node.next, loop, seen),
    ];
  }

  if (node.type === "while") {
    const body = (Array.isArray(node.body) ? node.body : [node.body])
      .flatMap((entry) => stepFor(entry, loop, new Set(seen)));
    return [
      {
        while: {
          condition: node.condition,
          until: node.until,
          maxIterations: node.maxIterations,
          steps: body,
        },
        when: node.when,
      },
      ...transitionSteps(node.next, loop, seen),
    ];
  }

  if (node.type === "tool") {
    return [
      {
        tool: node.tool,
        input: node.input,
        saveAs: node.saveAs,
        when: node.when,
      },
      ...transitionSteps(node.next, loop, seen),
    ];
  }

  return [
    { loop: id, when: node.when },
    ...transitionSteps(node.next, loop, seen),
  ];
}

/** Convert the canonical project-level loop graph to the legacy executor shape. */
export function normalizeProjectLoop(loop: ProjectLoopConfig): AgentLoopConfig {
  const loops: AgentLoopConfig["loops"] = {};
  for (const [id, step] of Object.entries(loop.steps)) {
    if (step.type === "human" || step.type === "parallel" || step.type === "while" || step.type === "tool") continue;
    const { type: _type, when: _when, next: _next, ...config } = step;
    loops[id] = config;
  }

  const pipeline: Pipeline = {
    context: loop.context ?? "shared",
    steps: stepFor(loop.start, loop),
  };

  return {
    name: loop.name,
    loops,
    pipeline,
  };
}
