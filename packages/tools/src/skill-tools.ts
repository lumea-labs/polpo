import { Type } from "@sinclair/typebox";
import {
  assembleSkillRead,
  readSkillResource,
  SkillResourceError,
  type FileSystem,
  type LoadedSkill,
  type PolpoTool,
} from "@polpo-ai/core";

export interface SkillToolOptions {
  maxAutoReferenceBytes?: number;
}

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
  options: SkillToolOptions = {},
): PolpoTool<any> | null {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  if (byName.size === 0) return null;

  return {
    name: "skill_read",
    label: "Read Skill",
    description:
      "Read an assigned skill bundle. Omit path to load SKILL.md plus its textual references automatically. Set path only for one exact bundle resource that was omitted or is needed explicitly. Never use workspace file tools for skill resources.",
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
        if (requestedPath === undefined) {
          const assembled = await assembleSkillRead(fs, skill, {
            maxReferenceBytes: options.maxAutoReferenceBytes,
          });
          const parts = [
            `# ${skill.name}`,
            skill.description ? `\n${skill.description}` : "",
            "",
            "Resource: SKILL.md",
            "",
            assembled.entrypoint.content,
          ];
          if (assembled.references.length > 0) {
            parts.push(
              "",
              "## Bundled references (already loaded)",
              "",
              "These resources are already in context. Do not read them again with workspace file tools or shell commands.",
            );
            for (const reference of assembled.references) {
              parts.push("", `### Resource: ${reference.path}`, "", reference.content);
            }
          }
          if (assembled.omitted.length > 0) {
            parts.push("", "## Additional bundled resources", "");
            for (const omitted of assembled.omitted) {
              parts.push(`- ${omitted.path} (${omitted.reason})`);
            }
            if (assembled.omitted.some((item) => item.reason === "budget_exceeded" || item.reason === "read_failed")) {
              parts.push(
                "",
                "Use `skill_read` with this skill name and the exact bundle-relative `path` for a required textual resource listed above. Do not use workspace file tools.",
              );
            }
          }

          return {
            content: [{ type: "text" as const, text: parts.filter((part) => part !== "").join("\n") }],
            details: {
              ok: true,
              skill: skill.name,
              entrypoint: assembled.entrypoint.path,
              references: assembled.references.map((reference) => ({
                path: reference.path,
                loaded: true,
                bytes: reference.bytes,
              })),
              omitted: assembled.omitted,
              totalReferenceBytes: assembled.totalReferenceBytes,
            },
          };
        }

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
  options: SkillToolOptions = {},
): PolpoTool<any>[] {
  return [
    createSkillListTool(skills),
    createSkillReadTool(fs, skills, options),
  ].filter((tool): tool is PolpoTool<any> => tool !== null);
}
