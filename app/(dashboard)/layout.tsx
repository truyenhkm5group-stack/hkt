import { Suspense } from "react";
import { cookies } from "next/headers";
import { AppSidebar } from "@/components/app-sidebar";
import { LocalTestBanner } from "@/components/local-test-banner";
import { NavProgressProvider, NavProgressReset, StaleWhileRefreshing } from "@/components/nav-progress";
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
      <NavProgressProvider>
        <RealtimeProvider>
          <SidebarProvider defaultOpen={defaultOpen}>
            <AppSidebar user={user} />
            <SidebarInset className="min-w-0">
              {/* Bản test trên máy tự khai báo trước cả tiêu đề trang — xem `components/local-test-banner.tsx`. */}
              <LocalTestBanner />
              <SiteHeader />
              {/*
                GIỮ SỐ CŨ TRONG LÚC CHỜ SỐ MỚI. Đổi kỳ / bộ lọc trên cùng một trang không xoá nội
                dung: React giữ cây cũ trong suốt transition, còn lớp bọc này làm nó mờ đi và khoá
                thao tác — người dùng vẫn đọc được số của kỳ trước và biết chắc nó chưa phải số mới.
                Chuyển sang TRANG KHÁC thì không có số cũ để giữ, lúc đó `loading.tsx` hiện khung xương.
              */}
              <StaleWhileRefreshing asChild>
                <main className="flex-1 space-y-6 p-4 sm:p-6">{children}</main>
              </StaleWhileRefreshing>
            </SidebarInset>
          </SidebarProvider>
        </RealtimeProvider>
        {/* Chốt chặn: URL đã đổi xong ⇒ mọi điều hướng coi như kết thúc, thanh tiến trình không kẹt. */}
        <Suspense fallback={null}>
          <NavProgressReset />
        </Suspense>
      </NavProgressProvider>
    </TooltipProvider>
  );
}
