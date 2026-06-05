"use client";

import { useState } from "react";
import Link from "next/link";
import { LayoutGrid, List } from "lucide-react";
import type { Project } from "../../../lib/api";

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours > 0) return `${hours}h ago`;
  return "just now";
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={`h-2 w-2 rounded-full shrink-0 ${
      status === "active" ? "bg-brand" : "bg-muted-foreground/30"
    }`} />
  );
}

function GridView({ projects }: { projects: Project[] }) {
  return (
    <div data-testid="projects-grid" className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((project) => (
        <Link
          key={project.id}
          href={`/projects/${project.id}`}
          data-testid={`project-card-${project.slug}`}
          className="group border border-border bg-card p-5 transition-colors hover:border-foreground/20"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{project.name}</h3>
            <StatusDot status={project.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {project.slug}
          </p>
          <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Updated {timeAgo(project.updatedAt)}</span>
            <span className="font-mono">{project.status}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

function TableView({ projects }: { projects: Project[] }) {
  return (
    <div data-testid="projects-table" className="mt-8 border border-border overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[500px]">
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Name</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Slug</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Updated</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3">
                <Link href={`/projects/${project.id}`} className="font-medium hover:text-brand transition-colors">
                  {project.name}
                </Link>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{project.slug}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <StatusDot status={project.status} />
                  <span className="text-xs text-muted-foreground">{project.status}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{timeAgo(project.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectsList({ projects }: { projects: Project[] }) {
  const [view, setView] = useState<"grid" | "table">("grid");

  if (projects.length === 0) {
    return (
      <div data-testid="projects-empty" className="mt-8 border border-border p-12 text-center">
        <p className="text-sm text-muted-foreground">No projects yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">Create your first project to get started.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mt-6 flex items-center justify-between">
        <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
          {projects.length} project{projects.length !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center border border-border">
          <button
            onClick={() => setView("grid")}
            className={`p-1.5 transition-colors ${view === "grid" ? "bg-secondary text-foreground" : "text-muted-foreground/40 hover:text-muted-foreground"}`}
            aria-label="Grid view"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setView("table")}
            className={`p-1.5 transition-colors ${view === "table" ? "bg-secondary text-foreground" : "text-muted-foreground/40 hover:text-muted-foreground"}`}
            aria-label="Table view"
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {view === "grid" ? <GridView projects={projects} /> : <TableView projects={projects} />}
    </div>
  );
}
