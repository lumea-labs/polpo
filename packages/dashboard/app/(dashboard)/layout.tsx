import { Sidebar, MobileSidebar, MobileHeader } from "../../components/dashboard/sidebar";
import { TopHeader } from "../../components/dashboard/top-header";
import { Providers } from "../../components/providers";
import { MobileSidebarProvider } from "../../hooks/use-mobile-sidebar";
import { DesktopSidebarProvider } from "../../hooks/use-desktop-sidebar";
import { CopilotLayout } from "../../components/dashboard/project-copilot";

/**
 * Single-tenant self-host shell. No Better Auth session, no org list, no
 * onboarding gate — those live only in the cloud build. One local instance,
 * straight into the dashboard chrome.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <MobileSidebarProvider>
        <DesktopSidebarProvider>
          <div className="flex h-screen flex-col overflow-hidden">
            <div className="hidden md:block">
              <TopHeader />
            </div>

            <div className="flex flex-1 overflow-hidden">
              <Sidebar />
              <MobileSidebar />

              <div className="flex flex-1 flex-col overflow-hidden">
                <MobileHeader />
                <CopilotLayout>{children}</CopilotLayout>
              </div>
            </div>
          </div>
        </DesktopSidebarProvider>
      </MobileSidebarProvider>
    </Providers>
  );
}
