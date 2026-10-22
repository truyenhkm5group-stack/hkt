/**
 * ═══════════ HÀNG RÀO GIÁ TRỊ ĐƠN CỦA BOT BÁN HÀNG (P0 22/10/2026 — đơn HSLC #8037F35A) — HẰNG SỐ ═══════════
 *
 * Ca thật: khách đã có đơn TỰ CHỐT 540.000 ₫ nhắn «Thêm 10 nem hải sản tôm bề bề» (nem bán «Hộp 10 cái», 120.000 ₫/hộp). Giỏ có thẩm quyền
 * đọc «10 nem» thành 10 GÓI khách nói tường minh ⇒ hàng rào cam kết chặn đúng 1 hộp ⇒ model ghi 10 hộp ⇒ đơn đã chốt thành 1.740.000 ₫ và
 * bot báo khách con số đó. Bốn mã dưới đây là bốn cửa CHẶN TRƯỚC KHI GHI (lib/sales-chatbot/tools.ts), không phải phát hiện hôm sau:
 *  · QUANTITY_UNIT_AMBIGUOUS — số không kèm đơn vị không quy được ra số hộp ⇒ không ghi, hỏi đúng một câu;
 *  · PACK_MULTIPLIER_MISMATCH — số suy ra được (bội quy cách) mà đơn ghi khác số hộp suy ra ⇒ không ghi (đơn đã chốt ⇒ chuyển người);
 *  · CART_TOTAL_CONFLICT — sửa đơn ĐÃ CHỐT mà tổng tăng quá `CONFIRMED_EDIT_MAX_GROWTH` lần ⇒ không ghi, chuyển người;
 *  · ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT — sửa đơn ĐÃ CHỐT tăng món mà khách không nói số lượng ở chính lượt đó ⇒ không ghi, chuyển người.
 * Mã thứ năm STAFF_AI_QUOTE_CONFLICT (tổng bot ≠ tổng nhân viên / page) do luật có sẵn `staffTotalConflict` quyết và chuyển người; 2B đếm.
 * HÀM THUẦN, client import được.
 */

export const ORDER_GUARD_CODES = ["QUANTITY_UNIT_AMBIGUOUS", "PACK_MULTIPLIER_MISMATCH", "CART_TOTAL_CONFLICT", "ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT"] as const;
export type OrderGuardCode = (typeof ORDER_GUARD_CODES)[number];

/** Tên lỗi HẰNG của công cụ (cột «Lỗi công cụ» của ops conv-money-trace đếm theo chữ này). */
export const ORDER_GUARD_SUMMARY: Record<OrderGuardCode, string> = {
  QUANTITY_UNIT_AMBIGUOUS: "Đơn nháp: số lượng không rõ đơn vị",
  PACK_MULTIPLIER_MISMATCH: "Đơn nháp: sai bội quy cách hộp",
  CART_TOTAL_CONFLICT: "Sửa đơn đã chốt: tổng tăng bất thường",
  ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT: "Sửa đơn đã chốt: chưa có lời khách cho phần thêm",
};

/**
 * Sửa đơn ĐÃ CHỐT mà tổng mới LỚN HƠN tổng đã chốt × số này ⇒ chuyển người trước khi ghi. Không phải ngưỡng kết luận đơn / doanh thu: nó chỉ
 * quyết «máy tự ghi hay người nhìn trước». Ca #8037F35A là ×3,2; mua thêm một món kèm thường dưới ×1,5. CHỦ SHOP CHƯA DUYỆT con số này:
 * 22/10/2026 Tech Lead đặt tạm ×2 theo hướng an toàn (chỉ chặn ghi tự động + chuyển người). Đổi số là việc của chủ shop, và chỉ đổi ở ĐÂY.
 */
export const CONFIRMED_EDIT_MAX_GROWTH = 2;
