import { Suspense } from "react";
import { AdSpendDialog } from "@/app/(dashboard)/expenses/ad-spend-dialog";
import { AdsTab } from "@/app/(dashboard)/expenses/ads-tab";
import { AdsCoverageSection, RoasSection } from "@/app/(dashboard)/ads/roas-section";
import { AdsDecisionSection } from "@/app/(dashboard)/ads/decision-section";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { can, requirePermission } from "@/lib/auth/session";
import { ADS_DIMENSION_LABEL, type AdsDimension } from "@/lib/constants/ads-decision";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Quảng cáo" };

function isDimension(value: string): value is AdsDimension {
  // Object.hasOwn: `in` nhận cả khoá kế thừa (?dim=toString) rồi làm vỡ trang ở bảng quyết định.
  return Object.hasOwn(ADS_DIMENSION_LABEL, value);
}

/**
 * ───────────── MÀN QUẢNG CÁO: RA QUYẾT ĐỊNH TRƯỚC, TRA CỨU SAU ─────────────
 *
 * Thứ tự trên trang là thứ tự ưu tiên, và nó cũng chính là thiết kế hiệu năng.
 *
 * **Bảng quyết định đứng đầu và được CHỜ**: nó chỉ đụng tới đơn, vận đơn và chi quảng cáo nên rẻ
 * (đo ở quy mô 3×: ~60ms, 4 câu truy vấn).
 *
 * **Ba khối còn lại nằm sau ranh giới `Suspense` riêng**, vì chúng là TRA CỨU chứ không phải quyết
 * định — và một trong số đó rất đắt. Đo 12/09/2026 ở quy mô 3×: `AdsTab` → `getAdsPerformance` →
 * `getMarketerReport` → `getNominalProfitReport` mất **477,9ms / 33 câu truy vấn**, tức 97% thời
 * gian của cả trang cũ, chỉ để dựng lại toàn bộ báo cáo lợi nhuận công ty (phân bổ chi phí cố định,
 * dự phòng rủi ro tồn kho, thuế, chia lương).
 *
 * Trước đây cả trang CHỜ khối đó rồi mới vẽ gì. Nay nó điền vào sau, còn thứ người dùng mở trang để
 * xem thì hiện ngay. Cố ý KHÔNG xoá khối đó: nó là nơi duy nhất có phân bổ theo marketer, bỏ đi là
 * lấy mất một màn hình chủ shop đang dùng.
 */
export default async function AdsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("expenses:view");
  const canWrite = can(user, "expenses:write");
  const canManageEmployees = can(user, "payroll:manage");
  const period = resolvePeriod(raw, "month");
  const dimRaw = typeof raw.dim === "string" ? raw.dim : "campaign";
  const dimension: AdsDimension = isDimension(dimRaw) ? dimRaw : "campaign";
  const adsLevel = raw.adsLevel === "ad" ? "ad" : "campaign";

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Quảng cáo"
        description="Nên tăng tiền, giữ, theo dõi hay cắt — và vì sao"
        hint="Bảng quyết định xếp theo VIỆC CẦN LÀM: cắt và sửa khâu giao đứng trước, rồi mới tới tăng ngân sách. Mỗi dòng giải thích bằng số thật của chính nó. Lợi nhuận ở đây là LỢI NHUẬN GÓP SAU QUẢNG CÁO (doanh thu giao thành công − giá vốn − cước − tiền quảng cáo), cố ý không trừ chi phí cố định và thuế vì chúng không đổi theo ngân sách một chiến dịch."
        actions={canWrite ? <AdSpendDialog /> : null}
      />

      {/* QUYẾT ĐỊNH — thứ người dùng mở trang để xem. Rẻ, nên chờ được. */}
      <AdsDecisionSection period={period} dimension={dimension} />

      {/* TRA CỨU — điền vào sau, không chặn phần trên. */}
      <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
        <RoasSection period={period} level={adsLevel} />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-48 rounded-xl" />}>
        <AdsCoverageSection period={period} />
      </Suspense>

      {/* Khối đắt nhất của trang (phân bổ theo marketer, đi qua bộ máy lương/lợi nhuận) — xuống cuối. */}
      <Suspense fallback={<Skeleton className="h-72 rounded-xl" />}>
        <AdsTab raw={raw} period={period} canWrite={canWrite} canManageEmployees={canManageEmployees} />
      </Suspense>
    </div>
  );
}
