"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Users, Tag } from "lucide-react";
import { usePolpoClient } from "@/lib/polpo-client";
import { Markdown } from "@/components/dashboard/markdown";
import { ManualRefreshButton } from "@/components/dashboard/manual-refresh-button";
import { FileBrowser } from "@/components/dashboard/file-browser";

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

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

export interface SkillsListEntry {
  name: string;
  assignedTo?: string[];
  tags?: string[];
  category?: string;
}

export default function SkillDetailView({
  initialSkill,
  initialFiles,
  initialSkillsList,
}: {
  initialSkill: LoadedSkill | null;
  initialFiles: FileEntry[];
  initialSkillsList: SkillsListEntry[];
}) {
  const { id, name } = useParams<{ id: string; name: string }>();

  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [viewingFileName, setViewingFileName] = useState<string | null>(null);

  const polpo = usePolpoClient(id);
  const { data: baseSkill, isFetching: skillFetching, refetch: refetchSkill } = useQuery({
    queryKey: ["skill-detail", id, name],
    queryFn: () => polpo.getSkillContent(name) as unknown as Promise<LoadedSkill>,
    initialData: initialSkill ?? undefined,
    // SKILL.md content changes rarely (manual edit of the file in
    // the project). 5-minute stale window cuts refetch chatter
    // during a debugging/reading session; tab focus still triggers
    // a background revalidate once data is stale.
    staleTime: 5 * 60 * 1000,
  });

  // The /content endpoint doesn't join agent assignments — pull them
  // from the list endpoint (which does) and merge. Remove when
  // @polpo-ai/server includes assignments in GET /:name/content.
  const { data: skillsList, isFetching: skillsListFetching, refetch: refetchSkillsList } = useQuery({
    queryKey: ["skills-with-assignments", id],
    queryFn: () => polpo.getSkills() as unknown as Promise<SkillsListEntry[]>,
    initialData: initialSkillsList,
    // Assignments change when the user assigns/unassigns skills to
    // agents — a more frequent operation than editing SKILL.md, so
    // a tighter window (30s) keeps the pills reasonably fresh.
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

  // Load file content when a file is selected from the browser
  const { data: filePreview, isFetching: filePreviewFetching, refetch: refetchFilePreview } = useQuery({
    queryKey: ["file-preview", id, viewingFile],
    queryFn: () => polpo.previewFile(viewingFile!),
    enabled: !!viewingFile,
  });

  if (!skill) {
    return (
      <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
        Skill not found.
      </div>
    );
  }

  return (
    <div>
      {/* Back link */}
      <Link
        href={`/projects/${id}/skills`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Skills
      </Link>

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">{skill.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{skill.description}</p>
        </div>
        <ManualRefreshButton
          onRefresh={() => Promise.all([
            refetchSkill(),
            refetchSkillsList(),
            viewingFile ? refetchFilePreview() : Promise.resolve(),
          ])}
          isRefreshing={skillFetching || skillsListFetching || filePreviewFetching}
          className="mt-1 shrink-0"
        />
      </div>

      {/* Metadata pills — user-meaningful info only (tags, assignments,
          category, allowed tools). `source = "project"` is always true
          on cloud so we drop it. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {skill.assignedTo && skill.assignedTo.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
            <Users className="h-3 w-3" />
            {skill.assignedTo.join(", ")}
          </span>
        )}
        {skill.category && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 text-blue-500 px-2.5 py-1 text-xs font-medium">
            <Tag className="h-3 w-3" />
            {skill.category}
          </span>
        )}
        {skill.allowedTools && skill.allowedTools.length > 0 && (
          <span className="rounded-md bg-secondary px-2.5 py-1 text-xs text-muted-foreground font-mono">
            {skill.allowedTools.join(", ")}
          </span>
        )}
      </div>

      {/* Tags */}
      {skill.tags && skill.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Two-column layout: Content (left) + Files (right) */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Left: Content viewer */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {viewingFileName ?? "SKILL.md"}
            </h3>
            {viewingFile && (
              <button
                onClick={() => { setViewingFile(null); setViewingFileName(null); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Back to SKILL.md
              </button>
            )}
          </div>
          <div className="border border-border bg-card p-6 max-h-[calc(100vh-16rem)] overflow-auto scrollbar-thin">
            {viewingFile && filePreview ? (
              filePreview.type === "text" && filePreview.content ? (
                filePreview.name.endsWith(".md") ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <Markdown content={filePreview.content} />
                  </div>
                ) : (
                  <pre className="text-xs font-mono whitespace-pre-wrap break-words">{filePreview.content}</pre>
                )
              ) : (
                <p className="text-sm text-muted-foreground">Preview not available for this file type.</p>
              )
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <Markdown content={skill.content} />
              </div>
            )}
          </div>
        </div>

        {/* Right: File browser (sticky) */}
        <div className="lg:sticky lg:top-8 lg:self-start">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">Files</h3>
          <FileBrowser
            projectId={id}
            rootPath={`.polpo/skills/${name}`}
            compact
            initialEntries={initialFiles}
            onFileSelect={(filePath, fileName) => {
              // SKILL.md is the default view — clicking it in the browser
              // just resets to the base content, no separate preview.
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
    </div>
  );
}
