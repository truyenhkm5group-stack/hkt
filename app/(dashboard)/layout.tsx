import { Suspense } from "react";
import type { Metadata } from "next";
import { AppTopNav } from "@/components/app-topnav";
import { DetailCrumb } from "@/components/detail-crumb";
import { NavProgressProvider, NavProgressReset, StaleWhileRefreshing } from "@/components/nav-progress";
import { PageVisitBeacon } from "@/components/page-visit-beacon";
import { RealtimeProvider } from "@/components/realtime-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { can, getCurrentUser, requireUser } from "@/lib/auth/session";
import { orgTabMetadata } from "@/lib/branding/copy";
import { getOrgBrand } from "@/lib/branding/service";
import Link from "next/link";
import { loadDynamicNav } from "@/lib/pages/nav-loader";
import { findOrganization } from "@/lib/platform/organizations";
import { orgBillingStanding } from "@/lib/billing/standing";
import { billingNotice as billingNoticeOf } from "@/lib/billing/rules";
import { planKeyOf } from "@/lib/entitlements/check";
import { SalesAgentShell } from "@/components/saas-shell";
import { isSalesAgentUser, SALES_AGENT_NAV } from "@/lib/constants/saas-nav";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Tiêu đề tab + favicon của tổ chức KHÔNG phải nhà mang tên / logo CỦA HỌ (Phase 10 · §4, Phase 11 · H4) — không để
 * "VNXcommerce ERP" và biểu tượng của bố cục gốc lộ ra ở ERP của khách. Tổ chức nhà trả `{}` ⇒ giữ nguyên.
 */
export async function generateMetadata(): Promise<Metadata> {
  const user = await getCurrentUser();
  if (!user?.organization || user.organization.isHome) return {};
  const brand = await getOrgBrand(user);
  return orgTabMetadata({ name: brand?.name ?? user.organization.name, logoUrl: brand?.logoUrl ?? null });
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Menu động (Phase 4 · G12): trang tuỳ biến đã xuất bản, lọc theo người xem ở MÁY CHỦ — menu cũ không đổi.
  const dynamicPages = await loadDynamicNav(user);
  // Thương hiệu (Phase 10 · §4): chỉ tổ chức KHÔNG phải nhà — nhà nhận `null` và giữ nguyên giao diện.
  const brand = await getOrgBrand(user);
  // BẢN NHÁP (0180): tổ chức tự tạo chưa bấm Xuất bản — ERP đang dùng chính là bản xem trước. Chỉ đọc sổ tổ chức (đệm).
  const org = user.organization && !user.organization.isHome ? await findOrganization(user.organization.code) : null;
  const draft = org?.publishState === "DRAFT";
  // THU PHÍ (0187): nhắc khi còn ≤ 7 ngày / đang ân hạn / đã chỉ xem. Đọc sổ thuê bao qua đệm 10 giây — tổ chức nhà không hỏi.
  const billing = org ? await orgBillingStanding(org) : null;
  // Gói `trial` (cửa hàng tự đăng ký, `TRIAL_DAYS` ngày) ⇒ luôn hiện số ngày dùng thử còn lại; gói trả tiền chỉ nhắc khi gần / quá hạn.
  const billingNotice = billing && org ? billingNoticeOf(billing, planKeyOf(org) === "trial") : null;
  const canPay = can(user, "settings:manage");
  /*
    VỎ APP CHỐT ĐƠN TỰ ĐỘNG (lib/constants/saas-nav.ts): workspace «Sales Agent» thấy tám mục, không thấy menu ERP. Trang ERP ngoài
    vỏ đã bị chặn ở máy chủ trước khi tới đây (`resolveCurrentUser`), nên bố cục này chỉ còn việc VẼ. Mọi workspace khác: y như cũ.
  */
  const shell = isSalesAgentUser(user);
  const topBrand = brand ? { name: brand.name, logoUrl: brand.logoUrl } : null;
  /*
    Vỏ app: thanh dưới cố định trên điện thoại ⇒ chừa đáy `pb-24`; `overflow-x-clip` (không phải `hidden` — `hidden` biến <main>
    thành khung cuộn và làm hỏng mọi phần tử `sticky` bên trong) để một bảng rộng không bao giờ kéo cả trang tràn ngang.
  */
  const mainContent = (
    <StaleWhileRefreshing asChild>
      <main className={cn("w-full min-w-0 flex-1 space-y-6 px-3 pt-3 sm:px-5 lg:px-6 2xl:px-8", shell ? "overflow-x-clip pb-24 lg:pb-10 lg:pt-6" : "pb-24 md:pb-10")}>
        {draft ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="draft-banner">
            BẢN NHÁP — {shell ? "cửa hàng" : "ERP này"} chưa xuất bản: chưa có tên miền riêng, trang chat công khai chưa nhận khách.{" "}
            <Link href="/setup" className="font-semibold underline underline-offset-2">
              Thiết lập & xuất bản
            </Link>
          </p>
        ) : null}
        {billingNotice ? (
          <p
            className={
              billingNotice.tone === "info"
                ? "rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
                : billingNotice.tone === "warn"
                  ? "rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                  : "rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            }
            data-testid="billing-banner"
            data-billing-standing={billing?.kind}
          >
            {billingNotice.text}{" "}
            {canPay ? (
              <Link href="/settings/plan" className="font-semibold underline underline-offset-2">
                {billingNotice.cta}
              </Link>
            ) : (
              "Báo quản trị của tổ chức."
            )}
          </p>
        ) : null}
        <DetailCrumb skip={shell ? SALES_AGENT_NAV.map((i) => i.href) : undefined} />
        {children}
      </main>
    </StaleWhileRefreshing>
  );
  return (
    <TooltipProvider delayDuration={200}>
      <NavProgressProvider>
        <RealtimeProvider>
          {/*
            GIAO DIỆN BENTO: thanh menu viên thuốc NỔI ở trên, nội dung trải hết bề ngang bên dưới —
            không còn thanh bên chiếm 256px, nên bảng rộng có thêm chỗ thở.
          */}
          <div className={shell ? "min-h-screen" : "flex min-h-screen flex-col"}>
            {/* Màu nhấn: CSS dựng từ tập ĐÓNG tám màu (lib/branding/accents.ts), không phải chuỗi người dùng gõ. */}
            {brand?.accentCss ? <style>{brand.accentCss}</style> : null}
            {shell ? (
              <SalesAgentShell user={user} brand={topBrand}>
                {mainContent}
              </SalesAgentShell>
            ) : (
              <AppTopNav user={{ ...user, dynamicPages }} brand={topBrand} />
            )}
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
            {shell ? null : mainContent}
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
