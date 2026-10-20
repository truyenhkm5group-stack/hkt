/**
 * ═══════════ KIỂM LỜI MỜI SAU CHỐT TRÊN KÊNH TEST — CA + BỘ CHẤM (HÀM THUẦN) ═══════════
 *
 * Dùng bởi `scripts/org-ai-cutover.ts --apply-probe --probe-set=upsell`. Tách khỏi kịch bản ops vì kịch bản đó gần trần kích thước
 * (ops gửi kịch bản qua tham số dòng lệnh). Không đọc / ghi CSDL — nơi gọi đọc trạng thái rồi đưa vào `UpsellProbeObs`.
 */
import { extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";

export type ProbeVerdict = "PASS" | "FAIL" | "N/A";

/**
 * `--apply-probe --probe-set=upsell` (Tech Lead 19/10/2026, P0 lời mời sau chốt — «xác minh trên production»): mỗi ca một hội thoại THỬ
 * (kênh TEST — không nhắn khách thật, công cụ ghi chỉ mô phỏng, KHÔNG đơn / khách thật) đi trọn đường chốt nhanh: chọn món → gửi thông
 * tin ⇒ đơn tự chốt và tin xác nhận mang MỘT lời mời. Ca «đồng ý»: «ok thêm giúp chị» (chưa gọi tên món) ⇒ bot hỏi đúng một câu ⇒
 * «đúng rồi» ⇒ món được mời vào đơn + «Tổng đơn mới». Ca «ok»: «ok» trả lời tin xác nhận ⇒ đơn KHÔNG đổi. Chữ khách, tên, số điện thoại
 * là chữ TỰ DỰNG. upsell-offer-audit bỏ kênh TEST khỏi phép đo nên ca thử không làm lệch số «SAU CHỐT».
 */
export const UPSELL_PROBE_INFO = "Nguyễn Thị Thử, 0912000111, số 12 ngõ 34 Láng Hạ, Đống Đa, Hà Nội";
export type UpsellProbeCase = { key: string; say: string[]; expectAdded: boolean };
export const UPSELL_PROBE_CASES: UpsellProbeCase[] = [
  { key: "moi-sau-chot-dong-y", say: ["cho chị 1kg chả cá thu", UPSELL_PROBE_INFO, "ok thêm giúp chị", "đúng rồi"], expectAdded: true },
  { key: "moi-sau-chot-ok-khong-them", say: ["cho chị 1kg chả cá thu", UPSELL_PROBE_INFO, "ok"], expectAdded: false },
];
/** Những gì máy đọc được sau từng lượt của một ca upsell — `afterInfo` = ngay sau lượt gửi thông tin (lượt thứ 2), `end` = lượt cuối. */
export type UpsellProbeObs = {
  confirmedAfterInfo: boolean;
  offer: { outcome: string; sent: boolean; productId: string | null; text: string | null; source?: string | null; quickReplyId?: string | null; imageStatus?: string | null } | null;
  /**
   * CÂU UPSELL SHOP ĐANG CÀI (P0 20/10/2026) — đọc từ cài đặt câu mẫu của tổ chức lúc kiểm: mã + số ảnh. `null` = shop không có câu upsell
   * đang bật. `autoEnabled` = shop bật «bot tự soạn lời mời khi chưa có câu upsell». Thiếu hai trường (bản cũ) ⇒ chấm như trước.
   */
  template?: { id: string; imageCount: number } | null;
  autoEnabled?: boolean;
  infoReply: string;
  productsAfterInfo: string[];
  productsEnd: string[];
  accepted: boolean;
  lastReply: string;
  /** Tổng tiền của đơn đã chốt sau lượt cuối (giá MÁY CHỦ — `state.confirmed.total`); `null` = không đọc được. */
  endTotal: number | null;
};
/** Chấm một ca upsell — HÀM THUẦN. Không tự chốt / không có món kèm hợp lệ ⇒ KHÔNG ÁP DỤNG (không phải ĐẠT); lời mời hỏng ⇒ TRƯỢT. */
export function judgeUpsellProbe(c: UpsellProbeCase, o: UpsellProbeObs): { verdict: ProbeVerdict; why: string } {
  if (!o.confirmedAfterInfo) return { verdict: "N/A", why: "đơn KHÔNG tự chốt sau lượt gửi thông tin (công tắc tự chốt / thiếu thông tin) — không có lời mời sau chốt để kiểm" };
  if (!o.offer) return { verdict: "FAIL", why: "đơn đã chốt mà máy chủ không ghi quyết định mời nào" };
  const before0 = [...o.productsAfterInfo].sort().join(",");
  const keptOrder = [...o.productsEnd].sort().join(",") === before0 && !o.accepted;
  // Shop KHÔNG có câu upsell và KHÔNG bật tự soạn ⇒ không mời là ĐÚNG (mặc định không tự sáng tác).
  if (o.template === null && o.autoEnabled === false) {
    if (o.offer.outcome === "NO_TEMPLATE") return keptOrder ? { verdict: "PASS", why: "shop chưa có câu upsell, không bật tự soạn ⇒ bot không tự sáng tác lời mời, đơn giữ nguyên" } : { verdict: "FAIL", why: "không có lời mời mà đơn bị đổi món" };
    if (o.offer.source === "AUTO_GENERATED") return { verdict: "FAIL", why: "shop KHÔNG bật tự soạn mà bot vẫn tự soạn lời mời" };
  }
  if (o.offer.outcome === "NO_CANDIDATE") return { verdict: "N/A", why: "không có món kèm đang bán · còn hàng · giá xác minh" };
  if (o.offer.outcome !== "OFFERED" || !o.offer.sent) return { verdict: "FAIL", why: `lời mời không tới khách (quyết định: ${o.offer.outcome}${o.offer.sent ? "" : " · chưa gắn vào tin"})` };
  if (o.offer.text && !o.infoReply.includes(o.offer.text)) return { verdict: "FAIL", why: "tin xác nhận không mang câu mời đã ghi" };
  // Shop CÓ câu upsell đang bật ⇒ lời mời phải là ĐÚNG câu đó (mã câu mẫu) + ảnh, không phải câu bot tự soạn.
  if (o.template) {
    if (o.offer.source !== "SHOP_TEMPLATE") return { verdict: "FAIL", why: `shop có câu upsell đang bật mà lời mời là ${o.offer.source ?? "câu không rõ nguồn"} — phải là đúng câu shop cài` };
    if (o.offer.quickReplyId !== o.template.id) return { verdict: "FAIL", why: "lời mời dùng câu mẫu KHÁC câu upsell shop đã chọn" };
    if (o.template.imageCount > 0 && o.offer.imageStatus !== "QUEUED") return { verdict: "FAIL", why: `câu upsell có ${o.template.imageCount} ảnh mà ảnh không được giao cho kênh gửi` };
    if (c.expectAdded && !o.offer.productId) {
      return keptOrder
        ? { verdict: "N/A", why: "câu upsell của shop nói NHIỀU món ⇒ khách phải gọi tên món mới thêm (ca «ok» kiểm phần không tự thêm); lời mời ĐÚNG câu + ảnh shop" }
        : { verdict: "FAIL", why: "câu upsell nhiều món, khách chưa gọi tên món mà đơn bị đổi" };
    }
  }
  const before = before0;
  if (c.expectAdded) {
    if (!o.offer.productId || !o.productsEnd.includes(o.offer.productId)) return { verdict: "FAIL", why: "khách đồng ý mà món được mời KHÔNG vào đơn" };
    if (!o.accepted) return { verdict: "FAIL", why: "món đã vào đơn mà lời mời không ghi «khách nhận»" };
    // Khách phải được báo ĐÚNG tổng mới (số của máy chủ), không phải một câu chữ cố định — model diễn đạt lại «tổng 480.000 ₫» là đúng
    // (production 20/10/2026, run 39370132272); báo sai số thì TRƯỢT dù có chữ «Tổng đơn mới».
    if (o.endTotal !== null ? !extractVndAmounts(o.lastReply).includes(o.endTotal) : !/Tổng đơn mới/.test(o.lastReply)) {
      return { verdict: "FAIL", why: `thêm món mà không báo khách đúng tổng đơn mới${o.endTotal !== null ? ` (${o.endTotal.toLocaleString("vi-VN")} ₫)` : ""}` };
    }
    return { verdict: "PASS", why: "mời ⇒ hỏi một câu ⇒ đồng ý ⇒ thêm đúng món + tổng mới" };
  }
  if ([...o.productsEnd].sort().join(",") !== before) return { verdict: "FAIL", why: "«ok» trả lời tin xác nhận mà đơn bị đổi món" };
  if (o.accepted) return { verdict: "FAIL", why: "«ok» bị ghi là khách nhận lời mời" };
  return { verdict: "PASS", why: "«ok» không thêm món, đơn giữ nguyên" };
}

