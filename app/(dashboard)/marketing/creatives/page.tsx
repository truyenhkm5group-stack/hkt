import { ConfigTab } from "@/app/(dashboard)/marketing/creatives/config-tab";
import { SourcesTab } from "@/app/(dashboard)/marketing/creatives/sources-tab";
import { CreativeTabs } from "@/app/(dashboard)/marketing/creatives/tabs";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { CREATIVE_HARD_LIMITS } from "@/lib/constants/creative-loop";
import { formatNumber, formatVND } from "@/lib/format";
import { param, parseListParams, type SearchParams } from "@/lib/search-params";

export const metadata = { title: "Vòng mẫu quảng cáo" };

/** Tab đã có màn hình. Tab của gói sau (duyệt lô · đang chạy · thư viện · học) thêm khi nó tồn tại. */
const TABS = new Set(["nguon", "cau-hinh"]);

export default async function CreativesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("ideas:view");
  const raw = await searchParams;
  const tabRaw = param(raw, "tab");
  const tab = TABS.has(tabRaw) ? tabRaw : "nguon";
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

      <CreativeTabs active={tab} />

      {tab === "cau-hinh" ? (
        <ConfigTab canManage={can(user, "settings:manage")} />
      ) : (
        <SourcesTab params={parseListParams(raw, { filterKeys: ["loai", "bat"], defaultPageSize: 24, defaultPeriod: "all", sortable: [] })} canWrite={can(user, "ideas:write")} />
      )}
    </div>
  );
}
