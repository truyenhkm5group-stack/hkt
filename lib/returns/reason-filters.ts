/**
 * 2b — LỌC + ĐẾM của khối lý do hoàn trên dòng của `baseRows` (mỗi ĐƠN một dòng). HÀM THUẦN — mọi luật nằm ở đây để kiểm không cần CSDL.
 * Xem `lib/constants/return-reason-filters.ts` cho lý do từng lựa chọn.
 *
 * LỌC ở TypeScript, không ở SQL: tỉnh phải quy về tỉnh MỚI bằng CHÍNH bộ phân giải địa chỉ (`findProvince`) — viết lại bằng SQL là bảng thứ
 * hai; và bộ đếm từng lựa chọn (ô chọn in số ca) cần dòng TRƯỚC khi lọc. Các bộ lọc khác đi cùng đường để một chỗ quyết «ca nào ở trong».
 */
import { findProvince, foldVnText } from "@/lib/address/vn-address";
import { CARE_NONE, CARE_UNOWNED, CARRIER_NONE, CARRIER_UNNAMED, POST_OFFICE_QUERY_MAX, PROVINCE_UNKNOWN } from "@/lib/constants/return-reason-filters";
import { OUTCOME_GROUP, type OutcomeGroup } from "@/lib/constants/truth";
import type { OrderOutcome } from "@/lib/constants/returns";

/** Dữ kiện lọc của MỘT đơn (cột thô của `baseRows`). */
export type ReasonFilterFacts = {
  outcome: string;
  /** `ORDER_SOURCE` (lib/queries/order-source.ts). */
  source: string;
  /** `shipments.carrier` của vận đơn chính; `null` = không có vận đơn, `""` = có vận đơn mà chưa ghi ĐVVC. */
  carrier: string | null;
  /** `orders.ship_province` nguyên văn. */
  provinceRaw: string | null;
  /** Vị trí của sự kiện phát cuối (OUT_FOR_DELIVERY / DELIVERY_FAILED / DELIVERED); `null` = ĐVVC không cho. */
  postOffice: string | null;
  /** `shipment_care.owner_id` của đợt mới nhất; `careState` phân biệt «chưa ai cầm» với «không có ca». */
  careOwner: string | null;
  careState: "NONE" | "UNOWNED" | "OWNED";
};

export type ReasonFilterSelection = {
  sources?: readonly string[];
  carriers?: readonly string[];
  /** users.id · `CARE_UNOWNED` · `CARE_NONE`. */
  careOwners?: readonly string[];
  /** Tên tỉnh MỚI (`AdminProvince.name`) · `PROVINCE_UNKNOWN`. */
  provinces?: readonly string[];
  /** Chữ tìm (chứa, không dấu) trong bưu cục. Rỗng ⇒ không lọc — kiện thiếu bưu cục KHÔNG bị coi là «không khớp». */
  postOffice?: string;
  outcomes?: readonly OutcomeGroup[];
};

const memoProvince = new Map<string, string>();
/** Tỉnh MỚI của chữ trên đơn; không nhận ra ⇒ `PROVINCE_UNKNOWN`. HÀM THUẦN (nhớ trong tiến trình). */
export function provinceKeyOf(raw: string | null): string {
  const t = (raw ?? "").trim();
  if (!t) return PROVINCE_UNKNOWN;
  const hit = memoProvince.get(t);
  if (hit) return hit;
  const k = findProvince(t)?.name ?? PROVINCE_UNKNOWN;
  if (memoProvince.size < 5_000) memoProvince.set(t, k);
  return k;
}

/** `null` = không có vận đơn chính; `""` = có vận đơn mà ô ĐVVC trống. Hai chỗ trống KHÔNG gộp. */
export const carrierKeyOf = (c: string | null) => (c === null ? CARRIER_NONE : c.trim() ? c.trim() : CARRIER_UNNAMED);
export const careKeyOf = (f: Pick<ReasonFilterFacts, "careOwner" | "careState">) => (f.careState === "NONE" ? CARE_NONE : f.careState === "UNOWNED" || !f.careOwner ? CARE_UNOWNED : f.careOwner);
export const outcomeGroupOf = (outcome: string): OutcomeGroup | null => OUTCOME_GROUP[outcome as OrderOutcome] ?? null;

/** Chữ tìm bưu cục đã chuẩn (cắt trần, bỏ dấu, gộp khoảng trắng); rỗng ⇒ `""`. HÀM THUẦN. */
export function postOfficeQuery(q: string | undefined | null): string {
  return foldVnText((q ?? "").slice(0, POST_OFFICE_QUERY_MAX)).replace(/\s+/g, " ").trim();
}

/** Có bộ lọc 2b nào đang bật không. HÀM THUẦN. */
export function reasonFiltersActive(s: ReasonFilterSelection): boolean {
  return Boolean(s.sources?.length || s.carriers?.length || s.careOwners?.length || s.provinces?.length || postOfficeQuery(s.postOffice) || s.outcomes?.length);
}

/** Đơn có nằm trong tập lọc không. Bộ lọc vắng / rỗng ⇒ không lọc theo chiều đó. HÀM THUẦN. */
export function matchesReasonFilters(f: ReasonFilterFacts, s: ReasonFilterSelection): boolean {
  if (s.sources?.length && !s.sources.includes(f.source)) return false;
  if (s.carriers?.length && !s.carriers.includes(carrierKeyOf(f.carrier))) return false;
  if (s.careOwners?.length && !s.careOwners.includes(careKeyOf(f))) return false;
  if (s.provinces?.length && !s.provinces.includes(provinceKeyOf(f.provinceRaw))) return false;
  const q = postOfficeQuery(s.postOffice);
  if (q && !foldVnText(f.postOffice ?? "").replace(/\s+/g, " ").includes(q)) return false;
  if (s.outcomes?.length) {
    const g = outcomeGroupOf(f.outcome);
    if (!g || !s.outcomes.includes(g)) return false;
  }
  return true;
}

export type ReasonFacets = {
  sources: { key: string; count: number }[];
  carriers: { key: string; count: number }[];
  /** users.id · `CARE_UNOWNED` · `CARE_NONE` — tên người do nơi gọi dịch (không đưa tên vào đây). */
  careOwners: { key: string; count: number }[];
  provinces: { key: string; count: number }[];
  outcomes: { key: OutcomeGroup; count: number }[];
  /** Độ phủ bưu cục: bao nhiêu đơn có chữ bưu cục / tổng — in cạnh ô tìm. KHÔNG có danh sách giá trị (có thể mang tên / SĐT bưu tá). */
  postOffice: { withValue: number; total: number };
};

/** Số đơn của từng lựa chọn trên tập CHƯA lọc 2b (các bộ lọc khác của trang đã áp). Xếp nhiều → ít; các chỗ trống («chưa xác định», «chưa ai cầm», «không có ca») cuối, theo thứ tự khai. HÀM THUẦN. */
export function reasonFacetsOf(rows: readonly ReasonFilterFacts[]): ReasonFacets {
  const count = (keyOf: (f: ReasonFilterFacts) => string | null, last: readonly string[] = []) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = keyOf(r);
      if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    // Lựa chọn «chỗ trống» đứng cuối theo ĐÚNG thứ tự khai (không theo số đếm) — vị trí của chúng không nhảy khi số đổi.
    const rank = (k: string) => last.indexOf(k);
    return [...m.entries()].map(([key, n]) => ({ key, count: n })).sort((a, b) => rank(a.key) - rank(b.key) || b.count - a.count || a.key.localeCompare(b.key));
  };
  return {
    sources: count((f) => f.source),
    carriers: count((f) => carrierKeyOf(f.carrier), [CARRIER_UNNAMED, CARRIER_NONE]),
    careOwners: count(careKeyOf, [CARE_UNOWNED, CARE_NONE]),
    provinces: count((f) => provinceKeyOf(f.provinceRaw), [PROVINCE_UNKNOWN]),
    outcomes: count((f) => outcomeGroupOf(f.outcome)) as { key: OutcomeGroup; count: number }[],
    postOffice: { withValue: rows.filter((r) => (r.postOffice ?? "").trim()).length, total: rows.length },
  };
}
