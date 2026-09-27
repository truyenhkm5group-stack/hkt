import { Suspense } from "react";
import { AppTopNav } from "@/components/app-topnav";
import { DetailCrumb } from "@/components/detail-crumb";
import { NavProgressProvider, NavProgressReset, StaleWhileRefreshing } from "@/components/nav-progress";
import { PageVisitBeacon } from "@/components/page-visit-beacon";
import { RealtimeProvider } from "@/components/realtime-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requireUser } from "@/lib/auth/session";
import { loadDynamicNav } from "@/lib/pages/nav-loader";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Menu động (Phase 4 · G12): trang tuỳ biến đã xuất bản, lọc theo người xem ở MÁY CHỦ — menu cũ không đổi.
  const dynamicPages = await loadDynamicNav(user);
  return (
    <TooltipProvider delayDuration={200}>
      <NavProgressProvider>
        <RealtimeProvider>
          {/*
            GIAO DIỆN BENTO: thanh menu viên thuốc NỔI ở trên, nội dung trải hết bề ngang bên dưới —
            không còn thanh bên chiếm 256px, nên bảng rộng có thêm chỗ thở.
          */}
          <div className="flex min-h-screen flex-col">
            <AppTopNav user={{ ...user, dynamicPages }} />
            {/*
              GIỮ SỐ CŨ TRONG LÚC CHỜ SỐ MỚI. Đổi kỳ / bộ lọc trên cùng một trang không xoá nội
              dung: React giữ cây cũ trong suốt transition, còn lớp bọc này làm nó mờ đi và khoá
              thao tác — người dùng vẫn đọc được số của kỳ trước và biết chắc nó chưa phải số mới.
              Chuyển sang TRANG KHÁC thì không có số cũ để giữ, lúc đó `loading.tsx` hiện khung xương.
            */}
            {/*
              TRẢI HẾT BỀ NGANG, KHÔNG CĂN GIỮA TRONG MỘT KHUNG CỐ ĐỊNH. Bản đầu giới hạn 1760px:
              trên màn 2560px của chủ shop hai bên trống ~400px trong khi bảng rộng vẫn phải cuộn
              ngang. Lề co theo màn hình (12px điện thoại → 32px màn lớn) — cùng thang với thanh menu
              để mép thẻ và mép viên thuốc thẳng một hàng.
            */}
            <StaleWhileRefreshing asChild>
              <main className="w-full min-w-0 flex-1 space-y-6 px-3 pb-10 pt-3 sm:px-5 lg:px-6 2xl:px-8">
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
        {/* Đếm lượt mở trang theo mục menu (không ghi ai mở) — số liệu để rút gọn menu, xem Hệ thống → Module. */}
        <PageVisitBeacon />
      </NavProgressProvider>
    </TooltipProvider>
  );
}
