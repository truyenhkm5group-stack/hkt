import { ApproveTab } from "@/app/(dashboard)/marketing/creatives/approve-tab";
import { ConfigTab } from "@/app/(dashboard)/marketing/creatives/config-tab";
import { DesignTab } from "@/app/(dashboard)/marketing/creatives/design-tab";
import { LearningTab } from "@/app/(dashboard)/marketing/creatives/learning-tab";
import { LibraryTab } from "@/app/(dashboard)/marketing/creatives/library-tab";
import { LiveTab } from "@/app/(dashboard)/marketing/creatives/live-tab";
import { SourcesTab } from "@/app/(dashboard)/marketing/creatives/sources-tab";
import { CreativeTabs } from "@/app/(dashboard)/marketing/creatives/tabs";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { can, requirePermission } from "@/lib/auth/session";
import { CREATIVE_HARD_LIMITS } from "@/lib/constants/creative-loop";
import { formatNumber, formatVND } from "@/lib/format";
import { getPendingBatch } from "@/lib/queries/creative-loop";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Vòng mẫu quảng cáo" };

/** Tab đã có màn hình. */
const TABS = new Set(["duyet", "thiet-ke", "dang-chay", "thu-vien", "hoc", "nguon", "cau-hinh"]);

/** Tham số chỉ tab Nguồn ảnh đọc — có chúng mà thiếu `tab` thì người ta đang mở Nguồn ảnh (link cũ). */
const SOURCE_KEYS = ["loai", "bat", "q", "page"];

export default async function CreativesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("ideas:view");
  const raw = await searchParams;
  const tabRaw = param(raw, "tab");
  const db = await getDb();
  // Một câu đọc rẻ quyết tab mặc định: có lô CHỜ DUYỆT thì mở thẳng vào đó — việc duy nhất có hạn chót.
  const pending = await getPendingBatch(db);
  const pendingApproval = pending?.batch.status === "PENDING_APPROVAL";
  const defaultTab = pendingApproval && !SOURCE_KEYS.some((k) => param(raw, k)) ? "duyet" : "nguon";
  const tab = TABS.has(tabRaw) ? tabRaw : defaultTab;
  const L = CREATIVE_HARD_LIMITS;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Marketing"
        title="Vòng mẫu quảng cáo"
        description={`Ảnh đầu vào → máy dựng lô → người duyệt MỘT lần → chạy test → chấm → học. Trần: ${formatNumber(L.maxBatchSize)} mẫu × ${formatVND(L.maxBudgetPerVariantVnd)} mỗi ngày.`}
        hint={
          <>
            Mỗi ngày máy dựng một lô mẫu quảng cáo từ <b>ảnh sản phẩm thật</b> của shop, người duyệt cả lô một lần, máy đăng vào chiến dịch test do người dựng sẵn và
            chạy trong khung test. Luật TẮT (người khai) cho phép máy tắt sớm mẫu đắt; mẫu vượt ngưỡng đơn vào thư viện; mẫu thua bị loại nhưng gen và số đo được giữ
            để máy học. Mô hình AI chỉ VIẾT câu lệnh và câu chữ — chọn gen, chấm mẫu, tắt mẫu đều là hàm có kiểm thử. Đặc tả: <code>docs/creative-loop.md</code>.
          </>
        }
      />

      <CreativeTabs active={tab} defaultTab={defaultTab} pendingApproval={pendingApproval} />

      {tab === "duyet" ? (
        <ApproveTab pending={pending} batchId={param(raw, "lo") || null} canApprove={can(user, "expenses:write")} canEdit={can(user, "ideas:write")} />
      ) : tab === "thiet-ke" ? (
        <DesignTab canEdit={can(user, "ideas:write")} />
      ) : tab === "dang-chay" ? (
        <LiveTab canWrite={can(user, "expenses:write")} canKill={can(user, "expenses:write") || can(user, "settings:manage")} canRelease={can(user, "settings:manage")} />
      ) : tab === "thu-vien" ? (
        <LibraryTab />
      ) : tab === "hoc" ? (
        <LearningTab />
      ) : tab === "cau-hinh" ? (
        <ConfigTab canManage={can(user, "settings:manage")} canKill={can(user, "expenses:write") || can(user, "settings:manage")} />
      ) : (
        <SourcesTab params={parseListParams(raw, { filterKeys: ["loai", "bat"], defaultPageSize: 24, defaultPeriod: "all", sortable: [] })} canWrite={can(user, "ideas:write")} />
      )}
    </div>
  );
}
