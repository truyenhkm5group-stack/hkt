import { PostedCampsBlock } from "@/app/(dashboard)/marketing/creatives/approve-tab";
import { ConfigTab } from "@/app/(dashboard)/marketing/creatives/config-tab";
import { DesignTab } from "@/app/(dashboard)/marketing/creatives/design-tab";
import { LearningTab } from "@/app/(dashboard)/marketing/creatives/learning-tab";
import { LibraryTab } from "@/app/(dashboard)/marketing/creatives/library-tab";
import { LiveTab } from "@/app/(dashboard)/marketing/creatives/live-tab";
import { CreateStep, PublishStep, ReviewStep } from "@/app/(dashboard)/marketing/creatives/manual-gen-panel";
import { SourcesTab } from "@/app/(dashboard)/marketing/creatives/sources-tab";
import { CreativeTabs } from "@/app/(dashboard)/marketing/creatives/tabs";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { can, requirePermission } from "@/lib/auth/session";
import { CREATIVE_HARD_LIMITS, REVIEW_DAY, parseReviewDay } from "@/lib/constants/creative-loop";
import { vnDay } from "@/lib/constants/marketing-decision-ledger";
import { formatVND } from "@/lib/format";
import { getPendingBatch } from "@/lib/queries/creative-loop";
import { loadMediaCounts } from "@/lib/queries/creative-manual-gen";
import { param, parseListParams, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Thư viện Media" };

/** Tab đã có màn hình — cùng danh sách với thanh tab (`tabs.tsx`; không import từ tệp "use client" sang máy chủ). */
const TABS = new Set(["tao", "duyet", "dang", "dang-chay", "thu-vien", "thiet-ke", "hoc", "nguon", "cau-hinh"]);

/** Tham số chỉ tab Nguồn ảnh đọc — có chúng mà thiếu `tab` thì người ta đang mở Nguồn ảnh (link cũ). */
const SOURCE_KEYS = ["loai", "bat", "q", "page"];

/**
 * THƯ VIỆN MEDIA — luồng tay 5 bước (chủ shop 26/09/2026 bỏ lô hằng ngày, thiết kế lại luồng): ① Tạo ảnh → ② Duyệt ảnh →
 * ③ Hàng đợi & Đăng → ④ Đang chạy → ⑤ Mẫu thắng. Tab mặc định = bước SỚM NHẤT đang có việc (ảnh chờ duyệt ⇒ ②, bài chờ
 * đăng ⇒ ③, không thì ① Tạo ảnh). `?product=` (đề xuất đẩy tồn) mở ① với mã chọn sẵn — kể cả link cũ `tab=duyet&product=`.
 */
export default async function CreativesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("ideas:view");
  const raw = await searchParams;
  const db = await getDb();
  const [counts, pending] = await Promise.all([loadMediaCounts(db), getPendingBatch(db)]);
  const product = param(raw, "product") || null;
  const defaultTab = SOURCE_KEYS.some((k) => param(raw, k)) ? "nguon" : counts.review > 0 ? "duyet" : counts.queue > 0 ? "dang" : "tao";
  const tabRaw = param(raw, "tab");
  const tab = product && (tabRaw === "" || tabRaw === "duyet" || tabRaw === "tao") ? "tao" : TABS.has(tabRaw) ? tabRaw : defaultTab;
  const canEdit = can(user, "ideas:write");
  const canPublish = canEdit && can(user, "expenses:write");
  // ② Duyệt ảnh lọc kết quả theo ngày (giờ VN): mặc định hôm nay, `?ngay=` chọn ngày khác.
  const today = vnDay(new Date());
  const reviewDay = parseReviewDay(param(raw, REVIEW_DAY.param), today);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title="Thư viện Media"
        description={`① Tạo ảnh → ② Duyệt ảnh → ③ Hàng đợi & Đăng camp → ④ Đang chạy → ⑤ Mẫu thắng. Mỗi camp tối đa ${formatVND(CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd)}, tự dừng sau ${CREATIVE_HARD_LIMITS.maxTestDays} ngày.`}
        hint={
          <>
            Máy vẽ ảnh quảng cáo từ <b>ảnh sản phẩm thật</b> của shop (hoặc bạn tải mẫu tự làm), bạn duyệt ảnh, sửa câu chữ, chọn setup camp (TKQC, fanpage, mục tiêu, ngân sách, vị trí, tuổi, giới tính) rồi đăng ngay hoặc hẹn giờ. Luật
            TẮT (tab Cấu hình & luật) cho phép máy tắt sớm camp đắt; mẫu vượt ngưỡng đơn vào ⑤ Mẫu thắng; gen và số đo được giữ để máy học. Lô hằng ngày đã bỏ (26/09/2026). Đặc tả: <code>docs/creative-loop.md</code>.
          </>
        }
      />

      <CreativeTabs
        active={tab}
        defaultTab={defaultTab}
        badges={{
          tao: { n: counts.drawing, hint: `${counts.drawing} ảnh đang vẽ` },
          duyet: { n: counts.review + counts.approvedUnqueued, hint: `${counts.review} ảnh chờ duyệt · ${counts.approvedUnqueued} ảnh đã duyệt chưa soạn bài` },
          dang: { n: counts.queue, hint: `${counts.queue} bài chờ đăng` },
          "dang-chay": { n: counts.live, hint: `${counts.live} mẫu đang chạy` },
        }}
      />

      {tab === "tao" ? (
        <CreateStep canEdit={canEdit} preselectProductId={param(raw, "product") || null} />
      ) : tab === "duyet" ? (
        <ReviewStep canEdit={canEdit} canPublish={canPublish} day={reviewDay} today={today} />
      ) : tab === "dang" ? (
        <div className="space-y-4">
          <PublishStep canEdit={canEdit} canPublish={canPublish} />
          <PostedCampsBlock pending={pending?.batch.status === "PENDING_APPROVAL" ? pending : null} batchId={param(raw, "lo") || null} canApprove={can(user, "expenses:write")} canEdit={canEdit} />
        </div>
      ) : tab === "thiet-ke" ? (
        <DesignTab canEdit={canEdit} canCreateTopic={can(user, "production:write")} />
      ) : tab === "dang-chay" ? (
        <LiveTab canWrite={can(user, "expenses:write")} canKill={can(user, "expenses:write") || can(user, "settings:manage")} canRelease={can(user, "settings:manage")} />
      ) : tab === "thu-vien" ? (
        <LibraryTab productId={param(raw, "mau") || null} period={resolvePeriod(raw, "all")} />
      ) : tab === "hoc" ? (
        <LearningTab />
      ) : tab === "cau-hinh" ? (
        <ConfigTab canManage={can(user, "settings:manage")} canKill={can(user, "expenses:write") || can(user, "settings:manage")} />
      ) : (
        <SourcesTab params={parseListParams(raw, { filterKeys: ["loai", "bat"], defaultPageSize: 24, defaultPeriod: "all", sortable: [] })} canWrite={canEdit} />
      )}
    </div>
  );
}
