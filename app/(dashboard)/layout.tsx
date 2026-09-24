import { Suspense } from "react";
import { AppTopNav } from "@/components/app-topnav";
import { DetailCrumb } from "@/components/detail-crumb";
import { NavProgressProvider, NavProgressReset, StaleWhileRefreshing } from "@/components/nav-progress";
import { RealtimeProvider } from "@/components/realtime-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <TooltipProvider delayDuration={200}>
      <NavProgressProvider>
        <RealtimeProvider>
          {/*
            GIAO DIỆN BENTO: thanh menu viên thuốc NỔI ở trên, nội dung trải hết bề ngang bên dưới —
            không còn thanh bên chiếm 256px, nên bảng rộng có thêm chỗ thở.
          */}
          <div className="flex min-h-screen flex-col">
            <AppTopNav user={user} />
            {/*
              GIỮ SỐ CŨ TRONG LÚC CHỜ SỐ MỚI. Đổi kỳ / bộ lọc trên cùng một trang không xoá nội
              dung: React giữ cây cũ trong suốt transition, còn lớp bọc này làm nó mờ đi và khoá
              thao tác — người dùng vẫn đọc được số của kỳ trước và biết chắc nó chưa phải số mới.
              Chuyển sang TRANG KHÁC thì không có số cũ để giữ, lúc đó `loading.tsx` hiện khung xương.
            */}
            <StaleWhileRefreshing asChild>
              <main className="mx-auto w-full min-w-0 max-w-[1760px] flex-1 space-y-6 px-3 pb-10 pt-3 sm:px-6">
                <DetailCrumb />
                {children}
              </main>
            </StaleWhileRefreshing>
          </div>
        </RealtimeProvider>
        {/* Chốt chặn: URL đã đổi xong ⇒ mọi điều hướng coi như kết thúc, thanh tiến trình không kẹt. */}
        <Suspense fallback={null}>
          <NavProgressReset />
        </Suspense>
      </NavProgressProvider>
    </TooltipProvider>
  );
}
