import { redirect } from "next/navigation";
import { Providers } from "@/components/providers";
import { getOrgs } from "@/lib/api";

/**
 * Isolated layout for the Playground tab. No project sidebar — this is a
 * standalone surface (opened in a new browser tab) so end-users / builders
 * can clearly see they're chatting with an agent, not poking around the
 * dashboard. The PlaygroundFrame inside the page renders its own top bar
 * with a "Back to dashboard" link.
 */
export default async function PlaygroundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const orgs = await getOrgs();
  if (orgs.length === 0) redirect("/onboarding");

  return (
    <Providers>
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {children}
      </div>
    </Providers>
  );
}
