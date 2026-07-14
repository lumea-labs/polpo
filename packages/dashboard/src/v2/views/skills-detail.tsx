"use client";

import { useState } from "react";
import { useQuery } from "../host";
import { useParams, useRouter } from "../host";
import { Link } from "../host";
import {
  ArrowLeft,
  Users,
  Tag,
  Trash,
  WarningCircle,
  CircleNotch,
} from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { announceNavigationStart } from "../host";
import { decodeTextEntities } from "../host";
import { Markdown } from "../host";
import { Button } from "../ui/button";
import { CodeBlock } from "../ui/code-block";
import { FileDirectoryBrowser } from "../files/file-directory-browser";
import type { FileEntry } from "../files/file-browser-primitives";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

export interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  source: string;
  path: string;
  tags?: string[];
  category?: string;
  assignedTo?: string[];
  allowedTools?: string[];
}

export type { FileEntry } from "../files/file-browser-primitives";

export interface SkillsListEntry {
  name: string;
  assignedTo?: string[];
  tags?: string[];
  category?: string;
}

export function SkillDetail({
  initialSkill,
  initialFiles,
  initialSkillsList,
}: {
  initialSkill: LoadedSkill | null;
  initialFiles: FileEntry[];
  initialSkillsList: SkillsListEntry[];
}) {
  const params = useParams<{ id: string; name: string }>();
  const router = useRouter();
  const id = params.id;
  const name = decodeURIComponent(params.name);

  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingFileName, setViewingFileName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);

  const polpo = usePolpoClient(id);

  async function del() {
    setDeleting(true);
    setDelError(null);
    try {
      await polpo.deleteSkill(name);
      const href = `/projects/${id}/skills`;
      announceNavigationStart("skills", href);
      router.push(href);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
    }
  }

  const { data: baseSkill } = useQuery({
    queryKey: ["skill-detail", id, name],
    queryFn: () => polpo.getSkillContent(name) as unknown as Promise<LoadedSkill>,
    initialData: initialSkill ?? undefined,
    staleTime: 5 * 60 * 1000,
  });

  const { data: skillsList } = useQuery({
    queryKey: ["skills-with-assignments", id],
    queryFn: () => polpo.getSkills() as unknown as Promise<SkillsListEntry[]>,
    initialData: initialSkillsList,
    staleTime: 30 * 1000,
  });

  const listEntry = skillsList?.find((s) => s.name === name);
  const skill: LoadedSkill | undefined = baseSkill
    ? {
        ...baseSkill,
        assignedTo: listEntry?.assignedTo ?? baseSkill.assignedTo,
        tags: listEntry?.tags ?? baseSkill.tags,
        category: listEntry?.category ?? baseSkill.category,
      }
    : baseSkill;

  const { data: filePreview, isLoading: openingFile } = useQuery({
    queryKey: ["file-preview", id, viewingFile],
    queryFn: () => polpo.previewFile(viewingFile!),
    enabled: !!viewingFile,
  });

  if (!skill) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Skill not found.
      </div>
    );
  }

  return (
    <div>
      <Link
        href={`/projects/${id}/skills`}
        className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} />
        Skills
      </Link>

      {/* Header */}
      <div className="mt-4">
        <div className="flex items-start justify-between gap-4">
          <h1 className="min-w-0 font-mono text-[19px] font-semibold tracking-tight text-foreground">
            {skill.name}
          </h1>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash size={14} />
            Delete
          </Button>
        </div>
        {skill.description && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            {decodeTextEntities(skill.description)}
          </p>
        )}
      </div>

      {/* Metadata */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {skill.assignedTo && skill.assignedTo.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 text-[12px] text-muted-foreground">
            <Users size={13} />
            {skill.assignedTo.join(", ")}
          </span>
        )}
        {skill.category && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-brand/10 px-2.5 py-1 text-[12px] font-medium text-brand">
            <Tag size={13} />
            {skill.category}
          </span>
        )}
        {skill.allowedTools && skill.allowedTools.length > 0 && (
          <span className="rounded-md bg-secondary px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
            {skill.allowedTools.join(", ")}
          </span>
        )}
      </div>

      {skill.tags && skill.tags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Content + Files */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <h2 className="min-w-0 truncate font-mono text-[12px] font-medium text-muted-foreground">
              {viewingFileName ?? "SKILL.md"}
            </h2>
            {viewingFile && (
              <button
                onClick={() => {
                  setViewingFile(null);
                  setViewingFileName(null);
                }}
                className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Back to SKILL.md
              </button>
            )}
          </div>
          <div className="scrollbar-none max-h-[calc(100vh-16rem)] overflow-auto rounded-lg border border-border bg-card p-6">
            {viewingFile && openingFile ? (
              <OpeningFile fileName={viewingFileName ?? viewingFile} />
            ) : viewingFile && filePreview ? (
              filePreview.type === "text" && filePreview.content ? (
                isMarkdownFile(filePreview.name) ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <Markdown content={filePreview.content} />
                  </div>
                ) : isCodeFile(filePreview.name) ? (
                  <CodeBlock
                    code={filePreview.content}
                    lang={languageForFile(filePreview.name)}
                    bare
                    showCopy={false}
                    wrap
                    maxHeightClass="max-h-none"
                    className="-m-2"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-muted-foreground">
                    {filePreview.content}
                  </pre>
                )
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  Preview not available for this file type.
                </p>
              )
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <Markdown content={skill.content} />
              </div>
            )}
          </div>
        </div>

        <div className="lg:sticky lg:top-8 lg:self-start">
          <h2 className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            Files
          </h2>
          <FileDirectoryBrowser
            projectId={id}
            rootPath={`.polpo/skills/${name}`}
            compact
            initialEntries={initialFiles}
            onFileSelect={(filePath, fileName) => {
              if (fileName === "SKILL.md") {
                setViewingFile(null);
                setViewingFileName(null);
                return;
              }
              setViewingFile(filePath);
              setViewingFileName(fileName);
            }}
          />
        </div>
      </div>

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
              <DialogTitle>Delete skill</DialogTitle>
            </div>
            <DialogDescription>
              Deletes{" "}
              <span className="font-mono font-medium text-foreground">{name}</span>{" "}
              from this project and unassigns it from every agent. This can&rsquo;t
              be undone.
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
              {deleting ? (
                <>
                  <CircleNotch size={14} className="animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete skill"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const SkillDetailView = SkillDetail;

function OpeningFile({ fileName }: { fileName: string }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center">
      <div className="inline-flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-[13px] text-muted-foreground">
        <CircleNotch size={14} className="animate-spin" />
        <span>
          Opening{" "}
          <span className="font-mono text-foreground">{fileName}</span>
        </span>
      </div>
    </div>
  );
}

function isMarkdownFile(fileName: string | undefined): boolean {
  return /\.(md|mdx|markdown)$/i.test(fileName ?? "");
}

function isCodeFile(fileName: string | undefined): boolean {
  return languageForFile(fileName) !== "text";
}

function languageForFile(fileName: string | undefined): string {
  const ext = (fileName?.split(".").pop() ?? "").toLowerCase();
  const languages: Record<string, string> = {
    bash: "bash",
    cjs: "javascript",
    css: "css",
    env: "bash",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    txt: "text",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[ext] ?? "text";
}
