import { redirect } from "next/navigation";
import { Sidebar, MobileSidebar, MobileHeader } from "@/components/dashboard/sidebar";
import { TopHeader } from "@/components/dashboard/top-header";
import { Providers } from "@/components/providers";
import { MobileSidebarProvider } from "@/hooks/use-mobile-sidebar";
import { DesktopSidebarProvider } from "@/hooks/use-desktop-sidebar";
import { getOrgs } from "@/lib/api";
import { getSession } from "@/lib/auth-server";
import { CopilotLayout } from "@/components/dashboard/project-copilot";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [session, orgs] = await Promise.all([getSession(), getOrgs()]);

  // No org → user hasn't completed onboarding
  if (orgs.length === 0) {
    redirect("/onboarding");
  }

  const org = orgs[0];
  const userEmail = session?.user?.email ?? "";
  const userImage = session?.user?.image ?? undefined;

  return (
    <Providers>
      <MobileSidebarProvider>
      <DesktopSidebarProvider>
        <div className="flex h-screen flex-col overflow-hidden">
          {/* Full-width top header (desktop) — logo + breadcrumb + avatar */}
          <div className="hidden md:block">
            <TopHeader orgId={org.id} orgName={org.name} userEmail={userEmail} userImage={userImage} />
          </div>

          <div className="flex flex-1 overflow-hidden">
            {/* Desktop sidebar */}
            <Sidebar />

            {/* Mobile sidebar (sheet/drawer) */}
            <MobileSidebar />

            {/* Main content area */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* Mobile top bar (logo + hamburger) */}
              <MobileHeader />

              {/* Main content + docked context-aware Builder copilot.
                  CopilotLayout renders <main> and pushes it left when open. */}
              <CopilotLayout>{children}</CopilotLayout>
            </div>
          </div>
        </div>
      </DesktopSidebarProvider>
      </MobileSidebarProvider>
    </Providers>
  );
}
