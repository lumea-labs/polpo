"use client";

import { MultiSelect } from "#/components/ui/multi-select";
import {
  ClaudeCodeIcon,
  ClineIcon,
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  OpenCodeIcon,
  QoderIcon,
  RooIcon,
  TraeIcon,
  WindsurfIcon,
} from "#/components/icons/coding-agents";

/**
 * Coding agent client definitions — shared across ConnectDialog and
 * WelcomeBanner. Each entry maps to a `-a <id>` flag in `polpo install`.
 */
export const CODING_CLIENTS: Array<{
  id: string;
  label: string;
  Icon: (props: { className?: string }) => React.ReactElement;
}> = [
  { id: "claude-code", label: "Claude Code", Icon: ClaudeCodeIcon },
  { id: "cursor", label: "Cursor", Icon: CursorIcon },
  { id: "codex", label: "Codex", Icon: CodexIcon },
  { id: "copilot", label: "Copilot", Icon: CopilotIcon },
  { id: "windsurf", label: "Windsurf", Icon: WindsurfIcon },
  { id: "cline", label: "Cline", Icon: ClineIcon },
  { id: "trae", label: "Trae", Icon: TraeIcon },
  { id: "roo-code", label: "Roo Code", Icon: RooIcon },
  { id: "qoder", label: "Qoder", Icon: QoderIcon },
  { id: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
];

/**
 * MultiSelect picker for coding agents with brand icons.
 * Used in ConnectDialog "Coding Agent" tab and WelcomeBanner step 2.
 */
export function ClientPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <MultiSelect
      options={CODING_CLIENTS.map((c) => ({
        value: c.id,
        label: c.label,
        icon: <c.Icon className="h-4 w-4" />,
      }))}
      value={value}
      onChange={onChange}
      placeholder="Select coding agents…"
      minSelected={1}
      className="w-64 rounded-md px-3 py-2 text-sm font-medium text-foreground"
    />
  );
}

/** Build the install command string from selected client IDs */
export function buildInstallCommand(clients: string[]): string {
  const clientFlag = clients.length > 0 ? ` --client ${clients.join(",")}` : "";
  return `npx @polpo-ai/cli install${clientFlag}`;
}
