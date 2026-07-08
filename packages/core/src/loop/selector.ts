import type { AgentConfig } from "../types.js";
import type { ReasoningLevel } from "../types.js";
import type { LoopConfig } from "./types.js";

export interface LoopSelection {
  name: string;
  loop: LoopConfig & { name: string };
  agent: AgentConfig;
}

export function resolveActiveLoopTools(agent: AgentConfig, loop?: LoopConfig): string[] | undefined {
  return loop?.tools ?? agent.allowedTools;
}

export function resolveActiveLoopSkills(agent: AgentConfig, loop?: LoopConfig): string[] | undefined {
  return loop?.skills ?? agent.skills;
}

export function resolveLoopSelection(agent: AgentConfig, requestedLoop?: string): LoopSelection | undefined {
  if (!requestedLoop) {
    if (agent.defaultLoop) {
      return {
        name: agent.defaultLoop,
        loop: { name: agent.defaultLoop, tools: agent.allowedTools, model: agent.model, reasoning: agent.reasoning, maxTurns: agent.maxTurns },
        agent,
      };
    }
    const defaultLoop = agent.loops?.default;
    if (!defaultLoop) {
      // No loop requested and none configured: run the agent as-is, with no
      // loop overlay. We deliberately do NOT synthesize a "default" loop — the
      // caller treats `undefined` as "no loop".
      return undefined;
    }
    return materializeLoopSelection(agent, "default", defaultLoop);
  }

  const loop = agent.loops?.[requestedLoop];
  if (!loop) {
    if (agent.assignedLoops?.includes(requestedLoop)) {
      return {
        name: requestedLoop,
        loop: { name: requestedLoop, tools: agent.allowedTools, model: agent.model, reasoning: agent.reasoning, maxTurns: agent.maxTurns },
        agent,
      };
    }
    const available = Object.keys(agent.loops ?? {});
    const assigned = agent.assignedLoops ?? [];
    const allAvailable = [...available, ...assigned];
    throw new Error(
      allAvailable.length > 0
        ? `Unknown loop "${requestedLoop}". Available loops: ${allAvailable.join(", ")}`
        : `Agent "${agent.name}" does not define configurable loops`,
    );
  }

  return materializeLoopSelection(agent, requestedLoop, loop);
}

function materializeLoopSelection(agent: AgentConfig, name: string, loop: LoopConfig): LoopSelection {
  const loopWithName = { ...loop, name: loop.name ?? name };
  const loopPrompt = loop.systemPrompt?.trim();
  const systemPrompt = loopPrompt
    ? [agent.systemPrompt, `## Active loop: ${loopWithName.name}`, loopPrompt].filter(Boolean).join("\n\n")
    : agent.systemPrompt;

  return {
    name: loopWithName.name,
    loop: loopWithName,
    agent: {
      ...agent,
      systemPrompt,
      allowedTools: resolveActiveLoopTools(agent, loop),
      skills: resolveActiveLoopSkills(agent, loop),
      model: loop.model ?? agent.model,
      reasoning: (loop.reasoning as ReasoningLevel | undefined) ?? agent.reasoning,
      maxTurns: loop.maxTurns ?? agent.maxTurns,
      toolChoice: loop.toolChoice ?? agent.toolChoice,
    },
  };
}
