/**
 * ═══════════ «SỬA ĐƠN VTP» ĐIỀN SẴN TỪ CHÍNH VẬN ĐƠN — HÀM THUẦN, DÙNG ĐƯỢC Ở CẢ CLIENT ═══════════
 *
 * Trước bản này form điền sẵn `cod: s.codAmount || s.order?.cod || 0`. Toán tử `||` coi số 0 là
 * "thiếu", nên vận đơn COD 0 — đơn khách chuyển khoản trước, hoặc vận đơn CHIỀU HOÀN (dòng riêng,
 * `order_id NULL`, AGENTS §3.7) — được điền sẵn COD CỦA ĐƠN. Người bấm «Gửi Viettel Post» mà không
 * nhìn kỹ là gửi một khoản thu hộ sai sang ĐVVC VÀ ghi đè `shipments.cod_amount`.
 *
 * Luật ở đây:
 *  · COD lấy ĐÚNG `shipments.cod_amount`. Cột này `NOT NULL DEFAULT 0` nên không có nhánh "chưa biết"
 *    để mà lùi về COD của đơn: 0 trên vận đơn là con số vận đơn đang mang, không phải chỗ trống.
 *    COD của đơn KHÔNG BAO GIỜ được dùng làm giá trị điền sẵn — đơn và vận đơn là hai grain (một đơn
 *    có thể có nhiều lần gửi, và chiều hoàn không thu tiền khách).
 *  · Người nhận / SĐT / địa chỉ lấy từ `receiver_*` của VẬN ĐƠN — đó là thứ đang nằm trên Viettel
 *    Post. Ba cột này `NOT NULL DEFAULT ''`; chỉ khi CHUỖI RỖNG (vận đơn Pancake tạo mà chưa nhận
 *    được chi tiết người nhận từ ĐVVC) mới lùi về địa chỉ giao của đơn, vì khi đó đơn là nguồn duy
 *    nhất có chữ. Địa chỉ lùi về `ship_full_address` (đủ phường/quận/tỉnh) — không phải
 *    `ship_address` (chỉ số nhà, tên đường) như bản cũ: gửi phần đường lên ĐVVC là cắt cụt địa chỉ.
 */

export type VtpEditShipmentFacts = {
  codAmount: number;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  order: {
    shipFullName: string | null;
    billFullName: string | null;
    shipPhone: string | null;
    billPhone: string | null;
    shipFullAddress: string | null;
    note: string | null;
  } | null;
};

export type VtpEditDefaults = { name: string; phone: string; address: string; cod: number; note: string };

const firstText = (...values: (string | null | undefined)[]) => values.find((v) => typeof v === "string" && v.trim() !== "")?.trim() ?? "";

export function vtpEditDefaults(s: VtpEditShipmentFacts): VtpEditDefaults {
  const o = s.order;
  return {
    name: firstText(s.receiverName, o?.shipFullName, o?.billFullName),
    phone: firstText(s.receiverPhone, o?.shipPhone, o?.billPhone),
    address: firstText(s.receiverAddress, o?.shipFullAddress),
    // KHÔNG `||`: 0 là giá trị thật của vận đơn (trả trước / chiều hoàn), không phải chỗ trống.
    cod: s.codAmount,
    note: firstText(o?.note),
  };
}

/**
 * Đổi tiền thu hộ trên ĐVVC là đổi số tiền khách phải trả ở cửa — phải có xác nhận TƯỜNG MINH.
 * Máy chủ so với `shipments.cod_amount` HIỆN TẠI (đọc lúc gửi), không so với số form đã điền sẵn.
 */
export function codChangeRequiresConfirmation(currentCod: number, nextCod: number): boolean {
  return currentCod !== nextCod;
}

/**
 * «ĐÃ THU» CHỈ HIỆN SỐ KHI CÓ BẰNG CHỨNG TIỀN (AGENTS luật 42, §0.3; ORDER_OUTCOME.md mục 7).
 *
 * `shipments.cod_collected` là `NOT NULL DEFAULT 0`, nên 0 ở cột này vừa có thể là "bảng kê ghi thu
 * 0 ₫" vừa có thể là "chưa có chứng từ nào". Bằng chứng do `HAS_CASH_EVIDENCE` của
 * `lib/queries/return-rate.ts` quyết — đúng mệnh đề mà `ORDER_OUTCOME` dùng (có số thực thu > 0,
 * HOẶC vận đơn có dòng chi tiết bảng kê phần COD). `cod_status` KHÔNG phải bằng chứng (mục 8).
 *
 * `null` = CHƯA XÁC MINH — màn hình in chữ, không in "0 ₫".
 */
export function collectedCodShown(codCollected: number, hasCashEvidence: boolean): number | null {
  return hasCashEvidence ? codCollected : null;
}

export const COD_UNVERIFIED_TEXT = "Chưa xác minh";
