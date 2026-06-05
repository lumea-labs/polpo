"use client";

/**
 * First-visit Get-started banner — rendered at the top of the project
 * dashboard when the URL carries `?welcome=1`.
 *
 * Two steps matching the first two tabs of the ConnectDialog:
 *   1. CLI — `polpo link --project-id <uuid>`
 *   2. Coding Agent — `polpo install --client <selected>`
 *
 * The ClientPicker and CopyCard are shared with ConnectDialog (DRY).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { CopyCard } from "../../../../components/dashboard/copy-card";
import { ClientPicker, buildInstallCommand } from "../../../../components/dashboard/client-picker";

interface Props {
  projectId: string;
  projectName: string;
  projectSlug: string | undefined;
  agentName: string | null;
}

// Per-project localStorage key — skip is scoped to this project so a user
// can still see the banner on a freshly created project even after
// dismissing it elsewhere.
const skipKey = (projectId: string) => `polpo:welcome-skipped:${projectId}`;

export default function WelcomeBanner({ projectId }: Props) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [clients, setClients] = useState<string[]>(["claude-code"]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Permanent skip wins over ?welcome=1 — if the user previously chose
    // "Don't show again", we never re-render the banner for this project
    // even when they re-land here via a welcome=1 link.
    if (localStorage.getItem(skipKey(projectId))) {
      setShow(false);
      return;
    }
    const hasFlag = new URLSearchParams(window.location.search).get("welcome") === "1";
    setShow(hasFlag);
  }, [projectId]);

  function clearWelcomeParam() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("welcome");
    window.history.replaceState({}, "", url.toString());
  }

  function handleDismiss() {
    setDismissed(true);
    clearWelcomeParam();
    router.refresh();
  }

  // Permanent skip — sets the localStorage flag so the banner never shows
  // again on this project, even if the user re-visits with ?welcome=1.
  function handleSkipForever() {
    if (typeof window !== "undefined") {
      localStorage.setItem(skipKey(projectId), "1");
    }
    setDismissed(true);
    clearWelcomeParam();
    router.refresh();
  }

  if (!show || dismissed) return null;

  const linkCmd = `npx @polpo-ai/cli link --project-id ${projectId}`;
  const installCmd = buildInstallCommand(clients);

  return (
    <div className="mb-8 w-full max-w-2xl border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl tracking-tight text-foreground">
            Get started
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect your codebase and set up your coding agent.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss"
          className="p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-5">
        {/* Step 1: Link */}
        <div className="flex gap-4">
          <div className="flex flex-col items-center gap-2 pt-0.5 shrink-0">
            <div className="flex size-5 items-center justify-center rounded-full bg-secondary">
              <span className="text-xs font-medium leading-4 text-foreground">1</span>
            </div>
            <div className="w-px flex-1 bg-border" />
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-2 pb-2">
            <div>
              <p className="text-sm font-medium leading-6 text-foreground">Link project</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Connect this cloud project to a local folder.
              </p>
            </div>
            <CopyCard label="terminal" value={linkCmd} />
          </div>
        </div>

        {/* Step 2: Install coding agent skills */}
        <div className="flex gap-4">
          <div className="flex flex-col items-center gap-2 pt-0.5 shrink-0">
            <div className="flex size-5 items-center justify-center rounded-full bg-secondary">
              <span className="text-xs font-medium leading-4 text-foreground">2</span>
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium leading-6 text-foreground">Set up your coding agent</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Install Polpo skills so your coding agent knows how to work with the project.
              </p>
            </div>
            <ClientPicker value={clients} onChange={setClients} />
            <CopyCard label="terminal" value={installCmd} />
          </div>
        </div>
      </div>

      {/* Footer — explicit "don't show again". The X above is a one-shot
          dismiss (banner returns if the user revisits with ?welcome=1);
          this is the permanent opt-out. */}
      <div className="mt-5 flex justify-end border-t border-border pt-3">
        <button
          type="button"
          onClick={handleSkipForever}
          data-testid="welcome-skip-forever"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Skip — don&apos;t show again
        </button>
      </div>
    </div>
  );
}
