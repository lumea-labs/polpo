"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  PencilSimple,
  Trash,
  WarningCircle,
  Play,
  CircleNotch,
} from "@phosphor-icons/react/dist/ssr";
import { announceNavigationStart, Link, mutateControlPlane, runtimeUrl, useRouter } from "../host.js";
import { Button } from "../ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.js";
import { Toggle } from "../ui/bits.js";
import { CodeBlock } from "../ui/code-block.js";
import { CopyButton } from "../ui/copy-button.js";
import { CodeEditor } from "../ui/code-editor.js";
import { ToolEditorDialog } from "./tool-editor-dialog.js";
import { extractDescription } from "./source-parsing.js";
import {
  schemaToFields,
  buildArgsFromForm,
  argsToFormValues,
  emptyFormValues,
  placeholderFor,
  type ParamField,
} from "./param-fields.js";
const INPUT =
  "h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none";

function formatResult(text = ""): { code: string; lang: string } {
  const trimmed = text.trim();
  if (!trimmed) return { code: "(empty result)", lang: "text" };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { code: JSON.stringify(JSON.parse(trimmed), null, 2), lang: "json" };
    } catch {
      // Fall through to plain text; some tools intentionally return fragments.
    }
  }
  return { code: text, lang: "text" };
}

export function ToolDetail({
  projectId,
  name,
  initialSource,
  parameters,
}: {
  projectId: string;
  name: string;
  initialSource: string;
  parameters: unknown;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"source" | "try">("source");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  const description = extractDescription(initialSource);

  async function del() {
    setDeleting(true);
    setDelError(null);
    try {
      await mutateControlPlane(
        `/v1/projects/${projectId}/tools/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      const href = `/projects/${projectId}/tools`;
      announceNavigationStart("tools", href);
      router.push(href);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  }

  return (
    <div>
      <Link
        href={`/projects/${projectId}/tools`}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        Tool Functions
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-[19px] font-semibold tracking-tight text-foreground">
            {name}
          </h1>
          {description && (
            <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <PencilSimple size={14} />
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash size={14} />
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-6 flex items-center gap-1 border-b border-border">
        {(["source", "try"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
              tab === t
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "source" ? "Source" : "Try it"}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === "source" ? (
          <div className="relative">
            {initialSource && (
              <CopyButton
                text={initialSource}
                className="absolute right-2 top-2 z-10"
              />
            )}
            <CodeEditor
              value={initialSource || "// Source not available."}
              onChange={() => {}}
              language="typescript"
              readOnly
              height="62vh"
            />
          </div>
        ) : (
          <TryIt projectId={projectId} name={name} parameters={parameters} />
        )}
      </div>

      {editing && (
        <ToolEditorDialog
          projectId={projectId}
          mode="edit"
          initialName={name}
          open
          onOpenChange={(o) => {
            if (!o) setEditing(false);
          }}
          onDeployed={() => router.refresh()}
        />
      )}

      <Dialog
        open={confirmDelete}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(false);
        }}
      >
        <DialogContent showCloseButton={false} className="v2">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <WarningCircle size={16} className="text-destructive" weight="fill" />
              <DialogTitle>Delete tool</DialogTitle>
            </div>
            <DialogDescription>
              Delete{" "}
              <span className="font-mono font-medium text-foreground">{name}</span>?
              Agents that reference it can no longer call it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {delError && <p className="text-[12px] text-destructive">{delError}</p>}
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={del}
            >
              {deleting ? "Deleting…" : "Delete tool"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ── Try it — guided form (from parameters) or raw JSON ────────────────── */
function TryIt({
  projectId,
  name,
  parameters,
}: {
  projectId: string;
  name: string;
  parameters: unknown;
}) {
  const fields = useMemo(() => schemaToFields(parameters), [parameters]);
  const [mode, setMode] = useState<"form" | "json">(fields ? "form" : "json");
  const [formValues, setFormValues] = useState<Record<string, string>>(() =>
    fields ? emptyFormValues(fields) : {},
  );
  const [argsText, setArgsText] = useState("{}");
  const [running, setRunning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text?: string; error?: string } | null>(
    null,
  );

  const base = runtimeUrl(`/v1/tools/${encodeURIComponent(name)}`);

  function assembleArgs(): Record<string, unknown> {
    if (mode === "form" && fields) return buildArgsFromForm(fields, formValues);
    return argsText.trim() ? JSON.parse(argsText) : {};
  }

  async function run() {
    let args: Record<string, unknown>;
    try {
      args = assembleArgs();
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Invalid arguments" });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const r = await fetch(`${base}/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
      const j = await r.json();
      if (!r.ok) {
        setResult({ error: j.error || `Run failed (${r.status})` });
        return;
      }
      const text =
        (j.data?.content ?? [])
          .map((c: { text?: string }) => c.text ?? "")
          .join("") || JSON.stringify(j.data, null, 2);
      setResult({ text });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : "Run failed" });
    } finally {
      setRunning(false);
    }
  }

  async function generate() {
    setGenerating(true);
    setGenError(null);
    try {
      const r = await fetch(`${base}/example`, {
        method: "POST",
        credentials: "include",
      });
      const j = await r.json();
      if (r.ok) {
        const args = (j.data?.args ?? {}) as Record<string, unknown>;
        if (fields) setFormValues(argsToFormValues(fields, args));
        setArgsText(JSON.stringify(args, null, 2));
      } else {
        setGenError(j.error || "Couldn't generate an example");
      }
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Failed to generate example");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {fields ? (
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <ModeChip active={mode === "form"} onClick={() => setMode("form")}>
              Form
            </ModeChip>
            <ModeChip active={mode === "json"} onClick={() => setMode("json")}>
              JSON
            </ModeChip>
          </div>
        ) : (
          <span className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
            Arguments (JSON)
          </span>
        )}
      </div>

      {mode === "form" && fields ? (
        <div className="flex flex-col gap-3.5 rounded-lg border border-border bg-card p-4">
          {fields.map((f) => (
            <Field
              key={f.name}
              field={f}
              value={formValues[f.name] ?? ""}
              onChange={(v) => setFormValues((p) => ({ ...p, [f.name]: v }))}
            />
          ))}
        </div>
      ) : (
        <CodeEditor
          language="json"
          value={argsText}
          onChange={setArgsText}
          height={160}
        />
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={running}>
          {running ? (
            <>
              <CircleNotch size={14} className="animate-spin" />
              Running…
            </>
          ) : (
            <>
              <Play size={14} weight="fill" />
              Run
            </>
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={generate} disabled={generating}>
          {generating ? (
            <>
              <CircleNotch size={14} className="animate-spin" />
              Generating…
            </>
          ) : (
            "Generate example"
          )}
        </Button>
      </div>

      {genError && <p className="text-destructive text-[12px]">{genError}</p>}

      {result && (
        <div>
          <div className="mb-1.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground/60">
            Result
          </div>
          {result.error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[13px] text-destructive">
              {result.error}
            </div>
          ) : (
            <ResultBlock text={result.text} />
          )}
        </div>
      )}
    </div>
  );
}

function ResultBlock({ text }: { text?: string }) {
  const result = formatResult(text);
  return (
    <CodeBlock
      code={result.code}
      lang={result.lang}
      maxHeightClass="max-h-[40vh]"
    />
  );
}

function ModeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-6 rounded px-2.5 text-[12px] transition-colors ${
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  field: f,
  value,
  onChange,
}: {
  field: ParamField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[12px] text-foreground">{f.name}</span>
        {f.required && <span className="text-destructive">*</span>}
        {f.type !== "string" && (
          <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground/50">
            {f.type}
          </span>
        )}
      </span>
      {f.description && (
        <span className="text-[11px] leading-snug text-muted-foreground">
          {f.description}
        </span>
      )}
      {f.type === "boolean" ? (
        <div className="pt-0.5">
          <Toggle
            checked={value === "true"}
            onChange={() => onChange(value === "true" ? "false" : "true")}
            label={f.name}
          />
        </div>
      ) : f.type === "enum" ? (
        <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {f.enumValues?.map((v) => (
              <SelectItem key={String(v)} value={String(v)}>
                {String(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : f.type === "json" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholderFor(f)}
          spellCheck={false}
          className="min-h-[60px] w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none"
        />
      ) : (
        <input
          type={f.type === "number" || f.type === "integer" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholderFor(f)}
          className={INPUT}
        />
      )}
    </label>
  );
}
