"use client";

import { lazy, Suspense, useEffect, useState, type ComponentProps, type Dispatch, type SetStateAction } from "react";
import { useTheme } from "next-themes";
import {
  CircleNotch,
  Rocket,
  Check,
  X,
  Copy,
  Terminal,
  CaretRight,
  Info,
} from "@phosphor-icons/react/dist/ssr";
import { mutateControlPlane, runtimeUrl } from "../host.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { extractDescription, extractName } from "./source-parsing.js";

// Monaco is heavy — dynamically imported (ssr:false) so it only loads when the
// dialog opens, keeping the Tools page itself light.
const LazyEditor = lazy(() =>
  import("@monaco-editor/react").then((module) => ({ default: module.default })),
);
function Editor(props: ComponentProps<typeof LazyEditor>) {
  return (
    <Suspense fallback={
      <div className="flex h-full min-h-[320px] items-center justify-center text-sm text-muted-foreground">
        <CircleNotch className="mr-2 h-4 w-4 animate-spin" /> Loading editor…
      </div>
    }>
      <LazyEditor {...props} />
    </Suspense>
  );
}

const TEMPLATE = `import { defineTool } from "@polpo-ai/tools";
import { Type } from "@sinclair/typebox";

export default defineTool({
  name: "my_tool",
  description: "Describe what your tool does for the model",
  parameters: Type.Object({
    input: Type.String({ description: "The input to process" }),
  }),
  async execute(ctx, params) {
    // ctx: { fs, shell, connections, env, workDir, polpo }
    return \`processed: \${params.input}\`;
  },
});
`;

/** Copy-paste prompt: hand this to a coding agent with your scope filled in and
 *  it produces a ready `defineTool` file. */
const CODING_AGENT_PROMPT = `You are writing a CUSTOM TOOL for Polpo (a backend for AI agents). A tool is a single TypeScript file that default-exports \`defineTool({...})\`. It runs inside a sandbox; an AI agent decides when to call it.

Produce EXACTLY this shape:

import { defineTool } from "@polpo-ai/tools";
import { Type } from "@sinclair/typebox";

export default defineTool({
  name: "snake_case_name",            // unique, lowercase snake_case
  description: "what it does — so the model knows when to call it",
  parameters: Type.Object({           // TypeBox schema = the tool's arguments
    // example: query: Type.String({ description: "..." }),
  }),
  async execute(ctx, params) {
    return "a string result";         // or a ToolResult
  },
});

\`ctx\` injects all capabilities (no other globals):
- ctx.fs      sandbox filesystem: readFile/writeFile/exists/readdir/mkdir/remove
- ctx.shell   run commands: await ctx.shell.execute("ls", { cwd })
- ctx.connections project Connections granted to this tool: ctx.connections.getToken("github") or ctx.connections.getHeaders("github")
- ctx.env     safe environment variables
- ctx.workDir absolute working directory in the sandbox
- ctx.polpo   the project's Polpo SDK client

CONSTRAINTS: TypeScript with type annotations only (no enum/namespace). Import ONLY @polpo-ai/tools, @sinclair/typebox and Node built-ins. HTTP via global fetch.

NOW WRITE THE TOOL FOR:
<<DESCRIBE WHAT YOUR TOOL SHOULD DO — inputs, what it calls/computes, what it returns>>

Output ONLY the final TypeScript file.`;

/** Ambient types fed to Monaco so `@polpo-ai/tools` + typebox resolve and you
 *  get autocomplete for `ctx` (no "cannot find module" squiggles). */
const POLPO_TOOLS_DTS = `
declare module "@sinclair/typebox" {
  export const Type: {
    Object(props: Record<string, any>, opts?: any): any;
    String(opts?: any): any; Number(opts?: any): any; Boolean(opts?: any): any;
    Integer(opts?: any): any; Array(item: any, opts?: any): any;
    Optional(t: any): any; Union(items: any[]): any; Literal(v: any): any; Any(): any;
  };
}
declare module "@polpo-ai/tools" {
  export interface CustomToolContext {
    fs: { readFile(p: string): Promise<string>; writeFile(p: string, c: string): Promise<void>; exists(p: string): Promise<boolean>; readdir(p: string): Promise<string[]>; mkdir(p: string): Promise<void>; remove(p: string): Promise<void> };
    shell: { execute(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> };
    connections: {
      get(ref: string): { id: string; providerId: string; name?: string; authType?: string; kind?: string; scopes?: string[]; grantedScopes?: string[]; tokenType?: string; expiresAt?: string; metadata?: Record<string, unknown> } | undefined;
      getToken(ref: string): string | undefined;
      getKey(ref: string): string | undefined;
      getHeaders(ref: string): Record<string, string> | undefined;
      has(ref: string): boolean;
      list(): Array<{ id: string; providerId: string; name?: string; authType?: string; kind?: string; scopes?: string[]; grantedScopes?: string[]; tokenType?: string; expiresAt?: string; metadata?: Record<string, unknown> }>;
    };
    env: Record<string, string | undefined>;
    workDir: string;
    polpo: any;
  }
  export type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details?: any };
  export function defineTool<T = any>(spec: {
    name: string; description: string; parameters: any; label?: string; clientSide?: boolean;
    execute: (ctx: CustomToolContext, params: T) => string | ToolResult | Promise<string | ToolResult>;
  }): any;
}
`;

function configureMonaco(monaco: any) {
  const ts = monaco?.languages?.typescript;
  if (!ts) return;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
  });
  ts.typescriptDefaults.addExtraLib(
    POLPO_TOOLS_DTS,
    "file:///node_modules/@polpo-ai/tools/index.d.ts",
  );
}

/** Ordered build steps shown in the deploy panel. */
const DEPLOY_STEPS: { key: string; label: string }[] = [
  { key: "detect", label: "Detecting dependencies" },
  { key: "install", label: "Installing dependencies" },
  { key: "bundle", label: "Bundling with esbuild" },
  { key: "validate", label: "Validating in sandbox" },
  { key: "deployed", label: "Deployed" },
];

type StepStatus = "running" | "done" | "error";
type Steps = Record<string, StepStatus>;
type SetSteps = Dispatch<SetStateAction<Steps>>;

// Mark the named step running (rolling any in-flight step → done).
function startStep(setSteps: SetSteps, step: string) {
  setSteps((prev) => {
    const next = { ...prev };
    for (const k of Object.keys(next)) if (next[k] === "running") next[k] = "done";
    next[step] = step === "deployed" ? "done" : "running";
    return next;
  });
}
function failRunning(setSteps: SetSteps) {
  setSteps((prev) => {
    const next = { ...prev };
    for (const k of Object.keys(next)) if (next[k] === "running") next[k] = "error";
    return next;
  });
}
function finishSteps(setSteps: SetSteps) {
  setSteps((prev) => {
    const next = { ...prev };
    for (const k of Object.keys(next)) if (next[k] === "running") next[k] = "done";
    next.deployed = "done";
    return next;
  });
}

/**
 * POST a JSON body and consume the Hono SSE stream, invoking `onEvent` per
 * `event:`/`data:` frame. Falls back to an "error" event on a non-stream reply.
 */
async function streamDeploy(
  url: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = `Deploy failed (${res.status})`;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    onEvent("error", { errors: [msg] });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
      }
      if (data) {
        try {
          onEvent(event, JSON.parse(data));
        } catch {}
      }
    }
  }
}

export function ToolEditorDialog({
  projectId,
  mode,
  initialName,
  open,
  onOpenChange,
  onDeployed,
}: {
  projectId: string;
  mode: "create" | "edit";
  initialName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeployed: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const [source, setSource] = useState(mode === "create" ? TEMPLATE : "");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [steps, setSteps] = useState<Steps>({});
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  // Reset on open; load existing source when editing.
  useEffect(() => {
    if (!open) return;
    setStatus("idle");
    setSteps({});
    setLog("");
    setShowLog(false);
    setErrors([]);
    if (mode === "edit" && initialName) {
      setLoading(true);
      fetch(
        runtimeUrl(`/v1/tools/${encodeURIComponent(initialName)}`),
        { credentials: "include" },
      )
        .then((r) => r.json())
        .then((j) => setSource(j.data?.source ?? ""))
        .catch(() => setErrors(["Failed to load the tool source."]))
        .finally(() => setLoading(false));
    } else {
      setSource(TEMPLATE);
    }
  }, [open, mode, initialName, projectId]);

  const busy = status === "running";
  const previewName = extractName(source);
  const previewDesc = extractDescription(source);

  async function copyPrompt() {
    await navigator.clipboard.writeText(CODING_AGENT_PROMPT).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function deploy() {
    const n = extractName(source);
    if (!n) {
      setErrors(["Could not read a snake_case `name:` from the source."]);
      setStatus("error");
      return;
    }
    // Renaming: deploy under the new name, then remove the old one (v1 parity —
    // changing `name:` in the source actually renames, no orphan left behind).
    const renamedFrom =
      mode === "edit" && initialName && initialName !== n ? initialName : null;
    setStatus("running");
    setSteps({});
    setLog("");
    setShowLog(false);
    setErrors([]);
    let ok = false;
    try {
      await streamDeploy(
        runtimeUrl(`/v1/tools/${encodeURIComponent(n)}/deploy`),
        { source },
        (event, data) => {
          if (event === "progress") {
            if (data.step === "error") return failRunning(setSteps);
            if (data.step === "done") return; // bundler-internal terminal marker
            if (data.log) return setLog((l) => l + data.log);
            startStep(setSteps, data.step);
          } else if (event === "done") {
            ok = true;
            finishSteps(setSteps);
            setStatus("success");
          } else if (event === "error") {
            setErrors(
              Array.isArray(data.errors) && data.errors.length
                ? data.errors
                : ["Deploy failed."],
            );
            setStatus("error");
            setShowLog(true);
            failRunning(setSteps);
          }
        },
      );
      if (ok) {
        if (renamedFrom) {
          await mutateControlPlane(
            `/v1/projects/${projectId}/tools/${encodeURIComponent(renamedFrom)}`,
            { method: "DELETE" },
          ).catch(() => {});
        }
        onDeployed();
        setTimeout(() => onOpenChange(false), 900);
      }
    } catch (e) {
      setErrors([(e as Error).message]);
      setStatus("error");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New tool" : `Edit ${initialName}`}</DialogTitle>
          <DialogDescription>
            Author a <code>defineTool</code> file — it runs in your project
            sandbox and your agents can call it.
          </DialogDescription>
        </DialogHeader>

        {/* Live name + description read from the code (the source of truth). */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
          <span className="font-mono font-medium text-foreground">
            {previewName || "untitled"}
          </span>
          <span className="text-muted-foreground">
            {previewDesc || "no description"}
          </span>
          <span className="inline-flex items-center gap-1 text-muted-foreground/60">
            <Info size={12} /> name &amp; description come from the code
          </span>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={copyPrompt}
          >
            {copied ? <Check size={12} className="text-brand" /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy agent prompt"}
          </Button>
        </div>

        {/* Deploy status panel */}
        {status !== "idle" && (
          <div className="rounded-lg border border-border bg-card text-[13px]">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              {status === "running" ? (
                <CircleNotch className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : status === "success" ? (
                <Rocket className="h-4 w-4 text-brand" />
              ) : (
                <X className="h-4 w-4 text-destructive" />
              )}
              <span className="font-medium text-foreground">
                {status === "running"
                  ? "Deploying…"
                  : status === "success"
                    ? "Deployed to the sandbox"
                    : "Deploy failed"}
              </span>
              {log && (
                <button
                  type="button"
                  onClick={() => setShowLog((s) => !s)}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Terminal size={12} /> Build log
                  <CaretRight
                    size={11}
                    className={`transition-transform ${showLog ? "rotate-90" : ""}`}
                  />
                </button>
              )}
            </div>
            <ol className="flex flex-col gap-1 px-3 py-2.5">
              {DEPLOY_STEPS.filter((s) => steps[s.key]).map((s) => {
                const st = steps[s.key];
                return (
                  <li key={s.key} className="flex items-center gap-2">
                    {st === "running" ? (
                      <CircleNotch className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : st === "error" ? (
                      <X className="h-3.5 w-3.5 shrink-0 text-destructive" />
                    ) : (
                      <Check className="h-3.5 w-3.5 shrink-0 text-brand" />
                    )}
                    <span className={st === "done" ? "text-muted-foreground" : "text-foreground"}>
                      {s.label}
                    </span>
                  </li>
                );
              })}
            </ol>
            {errors.length > 0 && (
              <ul className="list-disc border-t border-border px-3 py-2 pl-7">
                {errors.map((e, i) => (
                  <li key={i} className="whitespace-pre-wrap font-mono text-[11px] text-destructive">
                    {e}
                  </li>
                ))}
              </ul>
            )}
            {showLog && log && (
              <pre className="max-h-48 overflow-auto border-t border-border bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {log.trim()}
              </pre>
            )}
          </div>
        )}

        {/* Editor */}
        <div className="h-[46vh] min-h-[300px] overflow-hidden rounded-lg border border-border">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <CircleNotch className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <Editor
              height="100%"
              defaultLanguage="typescript"
              path="file:///tool.tsx"
              theme={resolvedTheme === "light" ? "vs" : "vs-dark"}
              beforeMount={configureMonaco}
              value={source}
              onChange={(v) => setSource(v ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                padding: { top: 12, bottom: 12 },
              }}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || loading} onClick={deploy}>
            {busy ? (
              <CircleNotch className="animate-spin" />
            ) : status === "success" ? (
              <Check />
            ) : (
              <Rocket />
            )}
            {busy ? "Deploying…" : status === "success" ? "Deployed" : "Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
