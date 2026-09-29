import { AdsTabs } from "@/app/(dashboard)/ads/ads-tabs";
import { PostResolverPanel } from "@/app/(dashboard)/ads/post-resolver/resolver-panel";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { can } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getAdPostCoverage } from "@/lib/queries/meta-ad-post";

export const metadata = { title: "Ad → Bài viết" };

/**
 * ───────────── MẨU QUẢNG CÁO → BÀI VIẾT ─────────────
 *
 * Dán Ad ID (hoặc link xem trước `feed_demo_ad=…`) → ERP hỏi Meta → creative → bài viết, kể cả bài
 * ẩn của "Tạo quảng cáo". Đây là công cụ KIỂM TRA / DỰ PHÒNG: đường chính là job `facebook-ads` hằng
 * giờ, đã tự điền cùng mối nối này cho mọi mẩu có đơn hoặc có chi tiêu (dải số phía trên).
 */
export default async function AdPostResolverPage() {
  const { user, decision } = await requireResource("ADS", "expenses:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Quảng cáo" reason={decision.reason} fix={decision.fix} />;
  const coverage = await getAdPostCoverage();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Quảng cáo"
        hint={
          <>
            <p>Dán Ad ID → ERP hỏi Meta Marketing API để ra Creative, Page và Post — kể cả bài ẩn (dark post) tạo bằng “Tạo quảng cáo”.</p>
            <p className="mt-1">ERP không đoán Post ID: chỉ nhận effective_object_story_id, rồi object_story_id nếu trường đầu vắng. Không có hai trường đó thì báo “chưa ra được bài”.</p>
          </>
        }
      />
      <AdsTabs />
      <p className="text-xs text-muted-foreground" title="Job “Chi tiêu quảng cáo Facebook” chạy hằng giờ và tự tra bài viết cho mẩu có đơn hoặc có chi tiêu — không cần dán tay từng mã.">
        Tự đồng bộ: {formatNumber(coverage.withPost)}/{formatNumber(coverage.total)} mẩu trong sổ đã có bài viết
        {coverage.withoutCreativeInfo > 0 ? ` · ${formatNumber(coverage.withoutCreativeInfo)} mẩu chưa được hỏi creative` : ""}
        {coverage.lastResolvedAt ? ` · lần ra bài gần nhất ${formatDateTime(coverage.lastResolvedAt)}` : ""}
      </p>
      <PostResolverPanel canSync={can(user, "expenses:write")} />
    </div>
  );
}
