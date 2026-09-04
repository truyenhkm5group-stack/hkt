import { cookies } from "next/headers";
import { AppSidebar } from "@/components/app-sidebar";
import { RealtimeProvider } from "@/components/realtime-provider";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";
  return (
    <TooltipProvider delayDuration={200}>
      <RealtimeProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <AppSidebar user={user} />
          <SidebarInset className="min-w-0">
            <SiteHeader />
            <main className="flex-1 space-y-6 p-4 sm:p-6">{children}</main>
          </SidebarInset>
        </SidebarProvider>
      </RealtimeProvider>
    </TooltipProvider>
  );
}
