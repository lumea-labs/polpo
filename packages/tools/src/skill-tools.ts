import { Type } from "@sinclair/typebox";
import {
  readSkillResource,
  SkillResourceError,
  type FileSystem,
  type LoadedSkill,
  type PolpoTool,
} from "@polpo-ai/core";

function summarizeSkill(skill: LoadedSkill): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description || "",
    category: skill.category || undefined,
    tags: Array.isArray(skill.tags) ? skill.tags : undefined,
    allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools : undefined,
  };
}

export function createSkillListTool(skills: readonly LoadedSkill[]): PolpoTool<any> | null {
  if (skills.length === 0) return null;

  return {
    name: "skill_list",
    label: "List Skills",
    description:
      "List the skills assigned to this agent with compact descriptions. Use this before deciding which skill_read call is needed.",
    parameters: Type.Object({}, { additionalProperties: false }),
    requiresSandbox: false,
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ skills: skills.map(summarizeSkill) }, null, 2),
        },
      ],
      details: { count: skills.length },
    }),
  };
}

export function createSkillReadTool(
  fs: FileSystem,
  skills: readonly LoadedSkill[],
): PolpoTool<any> | null {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  if (byName.size === 0) return null;

  return {
    name: "skill_read",
    label: "Read Skill",
    description:
      "Read an assigned skill. Omit path to read its main SKILL.md instructions. When those instructions reference a bundled file, call skill_read again with its bundle-relative path, for example references/design-system.md. Do not use workspace file tools for skill resources.",
    parameters: Type.Object({
      name: Type.String({
        description: `Assigned skill name. Allowed values: ${[...byName.keys()].join(", ")}`,
      }),
      path: Type.Optional(Type.String({
        description: "Optional POSIX path relative to the selected skill bundle. Defaults to SKILL.md.",
      })),
    }, { additionalProperties: false }),
    requiresSandbox: false,
    execute: async (_id, args) => {
      const name = typeof args.name === "string" ? args.name : "";
      const skill = byName.get(name);
      if (!skill) {
        const message = `Skill "${name}" is not assigned to this agent`;
        return {
          content: [{ type: "text" as const, text: `Error: ${message}.` }],
          details: {
            ok: false,
            error: { code: "skill_not_assigned", message },
          },
        };
      }

      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      try {
        const resource = await readSkillResource(fs, skill, requestedPath);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `# ${skill.name}`,
                resource.path === "SKILL.md" && skill.description
                  ? `\n${skill.description}`
                  : "",
                "",
                `Resource: ${resource.path}`,
                "",
                resource.content,
              ].filter((part) => part !== "").join("\n"),
            },
          ],
          details: {
            ok: true,
            skill: skill.name,
            path: resource.path,
          },
        };
      } catch (error) {
        const code = error instanceof SkillResourceError ? error.code : "read_failed";
        const message = error instanceof SkillResourceError
          ? error.message
          : "Skill resource could not be read";
        return {
          content: [{ type: "text" as const, text: `Error [${code}]: ${message}` }],
          details: {
            ok: false,
            skill: skill.name,
            error: { code, message },
          },
        };
      }
    },
  };
}

export function createSkillTools(
  fs: FileSystem,
  skills: readonly LoadedSkill[],
): PolpoTool<any>[] {
  return [
    createSkillListTool(skills),
    createSkillReadTool(fs, skills),
  ].filter((tool): tool is PolpoTool<any> => tool !== null);
}
