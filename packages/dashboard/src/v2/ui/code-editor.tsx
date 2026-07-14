"use client";

import { lazy, Suspense } from "react";
import { useTheme } from "next-themes";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";

const Editor = lazy(() =>
  import("@monaco-editor/react").then((module) => ({ default: module.default })),
);

function EditorLoading() {
  return (
    <div className="flex h-full min-h-[80px] items-center justify-center text-sm text-muted-foreground">
      <CircleNotch className="mr-2 h-4 w-4 animate-spin" /> Loading editor…
    </div>
  );
}

export function CodeEditor({
  value,
  onChange,
  language,
  height = 200,
  readOnly = false,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  language: string;
  height?: string | number;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const { resolvedTheme } = useTheme();

  return (
    <div
      className="overflow-hidden rounded-lg border border-border"
      style={{ height }}
    >
      <Suspense fallback={<EditorLoading />}>
        <Editor
          height="100%"
          language={language}
          theme={resolvedTheme === "light" ? "vs" : "vs-dark"}
          value={value}
          onChange={(next) => onChange(next ?? "")}
          options={{
            readOnly,
            placeholder,
            minimap: { enabled: false },
            fontSize: 12.5,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            tabSize: 2,
            padding: { top: 10, bottom: 10 },
          }}
        />
      </Suspense>
    </div>
  );
}
