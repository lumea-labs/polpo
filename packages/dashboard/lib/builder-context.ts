"use client";

/**
 * Derives the Builder/Copilot "context" from the current route, so the
 * global side panel knows what the user is looking at and the Meta Agent
 * can act accordingly (e.g. on an agent page → operate on that agent; on a
 * skill page → that skill; elsewhere → the project section).
 *
 * Returns a STABLE object (memoised by value) so consumers can use it as a
 * hook dependency without churning.
 */
import { useMemo } from "react";
import { useParams, usePathname } from "next/navigation";

export interface BuilderContext {
  type: "agent" | "skill" | "section" | "project";
  /** Human label shown in the panel's context strip, e.g. "Agent · sales-bot". */
  label: string;
  agentName?: string;
  skill?: string;
  section?: string;
}

/** Where the Meta Agent's `navigate` tool wants to send the user. */
export interface NavigateTarget {
  section: "agents" | "skills" | "tasks" | "missions" | "memory" | "playground" | "overview";
  name?: string | null;
  /** Agent Studio tab to focus (models/prompt/tools/skills/memory/vault). */
  tab?: string | null;
}

export function useBuilderContext(): {
  projectId: string | null;
  context: BuilderContext;
} {
  const params = useParams<{ id?: string; name?: string }>();
  const pathname = usePathname() ?? "";

  const projectId = params?.id ?? null;
  const name = params?.name ? decodeURIComponent(params.name) : undefined;

  // First path segment after /projects/:id/ — "agents", "skills", "tasks", …
  const rest = pathname.match(/\/projects\/[^/]+\/([^?#]*)/)?.[1] ?? "";
  const section = rest.split("/").filter(Boolean)[0];

  return useMemo(() => {
    let context: BuilderContext;
    if (section === "agents" && name) {
      context = { type: "agent", agentName: name, label: `Agent · ${name}` };
    } else if (section === "skills" && name) {
      context = { type: "skill", skill: name, label: `Skill · ${name}` };
    } else if (section) {
      const label = section.charAt(0).toUpperCase() + section.slice(1);
      context = { type: "section", section, label };
    } else {
      context = { type: "project", label: "Project" };
    }
    return { projectId, context };
  }, [projectId, section, name]);
}
