"use client";

/**
 * Inline tab toggle — squared pill buttons in a shared border strip.
 * Used across SdkSnippetPanel, SkillStepDetail, and anywhere we need
 * a compact tab switcher inside a card or detail panel.
 */
export function TabToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="inline-flex items-center gap-1 border border-border p-0.5 w-fit">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-xs font-medium transition-colors ${
            value === opt.value
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
