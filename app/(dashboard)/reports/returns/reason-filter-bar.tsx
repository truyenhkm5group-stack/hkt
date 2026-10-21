import { FacetFilter, ResetFilters, type FacetDef } from "@/components/data-table/toolbar";
import { InfoHint } from "@/components/info-hint";
import { PostOfficeFilter } from "@/app/(dashboard)/reports/returns/post-office-filter";
import { CARE_FILTER_LABEL, CARE_NONE, CARE_UNOWNED, CARRIER_NONE, CARRIER_NONE_LABEL, CARRIER_UNNAMED, CARRIER_UNNAMED_LABEL, PROVINCE_UNKNOWN, PROVINCE_UNKNOWN_LABEL, REASON_FILTER_KEYS } from "@/lib/constants/return-reason-filters";
import { OUTCOME_GROUP_LABEL, type OutcomeGroup } from "@/lib/constants/truth";
import { ORDER_SOURCE_LABEL, type OrderSourceKey } from "@/lib/queries/order-source";
import type { ReasonFacets } from "@/lib/returns/reason-filters";

/**
 * 2b — HÀNG BỘ LỌC RIÊNG CỦA KHỐI LÝ DO HOÀN (E) + NGUYÊN NHÂN · GIẢI PHÁP (E2). Bộ lọc chung của trang (đầu trang) áp cho mọi khối;
 * các ô ở đây CHỈ áp cho E / E2 — câu phạm vi in ngay cạnh, vì một bảng lọc hẹp hơn bảng bên cạnh mà không nói ra là bảng nói dối bằng
 * cách im lặng. Mỗi lựa chọn mang số ca của tập trước khi lọc 2b (`facets`). Nhân viên care hiện TÊN do máy chủ đọc từ `users`.
 */
export function ReasonFilterBar({ facets, careNames, active, postOffice }: { facets: ReasonFacets; careNames: Readonly<Record<string, string>>; active: boolean; postOffice: string }) {
  const careLabel = (k: string) => (k === CARE_UNOWNED || k === CARE_NONE ? CARE_FILTER_LABEL[k] : (careNames[k] ?? "Tài khoản không còn"));
  const defs: FacetDef[] = [
    { key: REASON_FILTER_KEYS.source, label: "Nguồn đơn", options: facets.sources.map((x) => ({ value: x.key, label: ORDER_SOURCE_LABEL[x.key as OrderSourceKey] ?? x.key, count: x.count })) },
    { key: REASON_FILTER_KEYS.carrier, label: "ĐVVC", options: facets.carriers.map((x) => ({ value: x.key, label: x.key === CARRIER_NONE ? CARRIER_NONE_LABEL : x.key === CARRIER_UNNAMED ? CARRIER_UNNAMED_LABEL : x.key, count: x.count })) },
    { key: REASON_FILTER_KEYS.care, label: "Nhân viên care", options: facets.careOwners.map((x) => ({ value: x.key, label: careLabel(x.key), count: x.count })) },
    { key: REASON_FILTER_KEYS.province, label: "Tỉnh", options: facets.provinces.map((x) => ({ value: x.key, label: x.key === PROVINCE_UNKNOWN ? PROVINCE_UNKNOWN_LABEL : x.key, count: x.count })) },
    { key: REASON_FILTER_KEYS.outcome, label: "Trạng thái", options: facets.outcomes.map((x) => ({ value: x.key, label: OUTCOME_GROUP_LABEL[x.key as OutcomeGroup] ?? x.key, count: x.count })) },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2" data-testid="reason-filter-bar">
      <span className="flex items-center gap-1 text-[12px] font-medium">
        Lọc khối lý do hoàn
        <InfoHint>
          Các ô này CHỈ áp cho khối «Lý do hoàn» và «Nguyên nhân · giải pháp» bên dưới (cả danh sách đơn khi mở từng lý do). KPI tổng quan, bảng theo mã hàng, theo
          nguồn đơn và tầng quyết định vẫn tính trên bộ lọc chung đầu trang. Tỉnh được quy về tỉnh MỚI bằng bộ phân giải địa chỉ; đơn không nhận ra tỉnh nằm ở
          «{PROVINCE_UNKNOWN_LABEL}». Trạng thái theo kết quả đơn (chứng từ ĐVVC / tiền thực thu), không theo trạng thái Pancake.
        </InfoHint>
      </span>
      {defs.map((d) => (d.options.length ? <FacetFilter key={d.key} facet={d} /> : null))}
      <PostOfficeFilter value={postOffice} coverage={facets.postOffice} />
      <ResetFilters keys={Object.values(REASON_FILTER_KEYS)} />
      {active ? <span className="text-[12px] font-semibold text-primary">Đang lọc — chỉ khối lý do hoàn</span> : null}
    </div>
  );
}
