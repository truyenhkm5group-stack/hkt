import type { ShipmentStage } from "@/db/schema";
import type { LegType, OtherCarrierDocumentSource } from "@/lib/constants/truth";

/**
 * ═══════════ MÃ TRẠNG THÁI CỦA HÃNG KHÁC VIETTEL POST (GHN · GHTK) ═══════════
 *
 * Chủ shop chốt 04/10/2026 (ORDER_OUTCOME.md mục 4.1): trạng thái CUỐI của GHN / GHTK là chứng từ ĐVVC để kết luận kết quả
 * đơn, như mã cuối của Viettel Post. Tệp THUẦN — một bảng cho mỗi hãng, dùng ở ba chỗ và chỉ ba chỗ:
 *  · lúc nhận webhook: mã của hãng ⇒ chặng chuẩn hoá + chiều, ghi vào `shipment_events.normalized_stage / leg_type`;
 *  · `lib/integrations/viettelpost/state.ts`: cờ «trạng thái cuối» của sự kiện hãng khác (KHÔNG dịch bằng bộ dịch VTP —
 *    số `5` của GHTK không phải mã nào của Viettel Post);
 *  · `lib/queries/return-rate.ts`: danh sách mã cuối cho `ORDER_OUTCOME` (giao / hoàn / huỷ / tiêu huỷ).
 *
 * Tên trường và giá trị đọc từ tài liệu chính thức ngày 04/10/2026:
 *  · GHN — developer.ghn.vn/en/docs/master-data/order-status (cột «Final»);
 *  · GHTK — api.ghtk.vn/docs/submit-order/webhook (`status_id`).
 *
 * MỘT MÃ, MỘT NGHĨA, KHÔNG ĐOÁN: mã không có trong bảng ⇒ chặng `UNKNOWN` (sự kiện được lưu, KHÔNG được dựng chặng, không
 * kết luận gì). `exception` của GHN là «cuối» theo hãng nhưng nghĩa là «cần người xử lý» — ERP không kết luận từ nó.
 */

export type CarrierStatusMeta = {
  name: string;
  stage: ShipmentStage;
  leg: LegType;
  /** Trạng thái cuối theo hãng VÀ ERP được kết luận từ nó. */
  final: boolean;
  /** Hàng không bao giờ quay về kho (mất / hỏng / tiêu huỷ / bồi hoàn) — như mã 503 của Viettel Post. */
  destroyed?: boolean;
};

export const GHN_STATUS: Readonly<Record<string, CarrierStatusMeta>> = {
  ready_to_pick: { name: "Chờ lấy hàng", stage: "PENDING", leg: "OUTBOUND", final: false },
  picking: { name: "Đang lấy hàng", stage: "PENDING", leg: "OUTBOUND", final: false },
  money_collect_picking: { name: "Đang thu tiền người gửi", stage: "PENDING", leg: "OUTBOUND", final: false },
  picked: { name: "Đã lấy hàng", stage: "PICKED_UP", leg: "OUTBOUND", final: false },
  storing: { name: "Hàng đang nằm ở kho", stage: "IN_TRANSIT", leg: "OUTBOUND", final: false },
  sorting: { name: "Đang phân loại", stage: "IN_TRANSIT", leg: "OUTBOUND", final: false },
  transporting: { name: "Đang luân chuyển", stage: "IN_TRANSIT", leg: "OUTBOUND", final: false },
  delivering: { name: "Đang giao hàng", stage: "OUT_FOR_DELIVERY", leg: "OUTBOUND", final: false },
  money_collect_delivering: { name: "Đang thu tiền người nhận", stage: "OUT_FOR_DELIVERY", leg: "OUTBOUND", final: false },
  delivered: { name: "Giao hàng thành công", stage: "DELIVERED", leg: "OUTBOUND", final: true },
  delivery_fail: { name: "Giao hàng thất bại", stage: "DELIVERY_FAILED", leg: "OUTBOUND", final: false },
  waiting_to_return: { name: "Chờ trả hàng", stage: "RETURNING", leg: "RETURN", final: false },
  return: { name: "Trả hàng", stage: "RETURNING", leg: "RETURN", final: false },
  return_transporting: { name: "Đang luân chuyển hàng trả", stage: "RETURNING", leg: "RETURN", final: false },
  return_sorting: { name: "Đang phân loại hàng trả", stage: "RETURNING", leg: "RETURN", final: false },
  returning: { name: "Đang trả hàng về shop", stage: "RETURNING", leg: "RETURN", final: false },
  return_fail: { name: "Trả hàng thất bại", stage: "RETURNING", leg: "RETURN", final: false },
  returned: { name: "Đã trả hàng về shop", stage: "RETURNED", leg: "RETURN", final: true },
  cancel: { name: "Huỷ đơn hàng", stage: "CANCELLED", leg: "OUTBOUND", final: true },
  exception: { name: "Đơn ngoại lệ — cần xử lý tay", stage: "UNKNOWN", leg: "UNKNOWN", final: false },
  lost: { name: "Hàng bị mất", stage: "RETURNED", leg: "UNKNOWN", final: true, destroyed: true },
  damage: { name: "Hàng bị hư hỏng", stage: "RETURNED", leg: "UNKNOWN", final: true, destroyed: true },
  scrap: { name: "Hàng bị tiêu huỷ", stage: "RETURNED", leg: "UNKNOWN", final: true, destroyed: true },
};

export const GHTK_STATUS: Readonly<Record<string, CarrierStatusMeta>> = {
  "-1": { name: "Huỷ đơn hàng", stage: "CANCELLED", leg: "OUTBOUND", final: true },
  "1": { name: "Chưa tiếp nhận", stage: "PENDING", leg: "OUTBOUND", final: false },
  "2": { name: "Đã tiếp nhận", stage: "PENDING", leg: "OUTBOUND", final: false },
  "12": { name: "Đang lấy hàng", stage: "PENDING", leg: "OUTBOUND", final: false },
  // «Không lấy được» / «hoãn lấy» chưa phải bàn giao (AGENTS mục 41: lấy hàng thất bại KHÔNG phải mốc bàn giao).
  "7": { name: "Không lấy được hàng", stage: "PENDING", leg: "OUTBOUND", final: false },
  "8": { name: "Hoãn lấy hàng", stage: "PENDING", leg: "OUTBOUND", final: false },
  "3": { name: "Đã lấy hàng / đã nhập kho", stage: "PICKED_UP", leg: "OUTBOUND", final: false },
  "4": { name: "Đang giao hàng", stage: "OUT_FOR_DELIVERY", leg: "OUTBOUND", final: false },
  "5": { name: "Đã giao hàng / chưa đối soát", stage: "DELIVERED", leg: "OUTBOUND", final: true },
  "6": { name: "Đã đối soát", stage: "DELIVERED", leg: "OUTBOUND", final: true },
  "9": { name: "Không giao được hàng", stage: "DELIVERY_FAILED", leg: "OUTBOUND", final: false },
  "10": { name: "Delay giao hàng", stage: "DELIVERY_FAILED", leg: "OUTBOUND", final: false },
  "20": { name: "Đang trả hàng", stage: "RETURNING", leg: "RETURN", final: false },
  "21": { name: "Đã trả hàng", stage: "RETURNED", leg: "RETURN", final: true },
  "11": { name: "Đã đối soát công nợ trả hàng", stage: "RETURNED", leg: "RETURN", final: true },
  "13": { name: "Đơn hàng bồi hoàn", stage: "RETURNED", leg: "UNKNOWN", final: true, destroyed: true },
};

export const CARRIER_STATUS_TABLES: Readonly<Record<OtherCarrierDocumentSource, Readonly<Record<string, CarrierStatusMeta>>>> = {
  GHN_WEBHOOK: GHN_STATUS,
  GHTK_WEBHOOK: GHTK_STATUS,
};

/** Tra một mã của hãng; không có trong bảng ⇒ `null` (lưu sự kiện, không dựng chặng). */
export function carrierStatusMeta(source: string, status: string): CarrierStatusMeta | null {
  const table = (CARRIER_STATUS_TABLES as Record<string, Readonly<Record<string, CarrierStatusMeta>> | undefined>)[source];
  if (!table) return null;
  const key = String(status ?? "").trim();
  return Object.hasOwn(table, key) ? table[key] : null;
}

export function isOtherCarrierSource(source: string): source is OtherCarrierDocumentSource {
  return Object.hasOwn(CARRIER_STATUS_TABLES, source);
}

export type FinalKind = "DELIVERED" | "RETURNED" | "CANCELLED" | "DESTROYED";

/**
 * Danh sách mã cuối theo loại kết luận — `ORDER_OUTCOME` đọc qua đây (một bảng, không chép mã sang SQL bằng tay).
 * `RETURNED` GỒM cả mã «tiêu huỷ / mất» (như 503 của Viettel Post nằm trong nhóm hoàn); `DESTROYED` là tập con để sổ kho
 * loại khỏi «hoàn chờ nhận».
 */
export function finalStatuses(source: OtherCarrierDocumentSource, kind: FinalKind): string[] {
  return Object.entries(CARRIER_STATUS_TABLES[source])
    .filter(([, m]) => m.final && (kind === "DESTROYED" ? m.destroyed === true : m.stage === kind))
    .map(([k]) => k);
}
