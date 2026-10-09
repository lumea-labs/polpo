"use client";
import type { ReactNode } from "react";

export type DataEnvironment = "local";
export type DataResponse<T> = { ok: true; data: T };
export function dataMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Database request failed";
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0)
    try {
      return JSON.parse(message.slice(jsonStart)).error ?? message;
    } catch {
      /* plain error */
    }
  if (status === 503 || message.includes("503"))
    return "Databases are unavailable on this runtime. Ask its administrator to configure the Data backend.";
  if (status === 403 || message.includes("403"))
    return "Your account does not have access to this database operation.";
  return message;
}
export function DataErrorNotice({ error }: { error: unknown }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive break-words"
    >
      {dataMessage(error)}
    </p>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium">
      {label}
      {children}
    </label>
  );
}
export const editorClass =
  "min-h-48 w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-5 focus-visible:outline-2 focus-visible:outline-ring";
