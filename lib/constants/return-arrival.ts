import { WEBHOOK_CLOCK_SKEW_SECONDS } from "@/lib/constants/webhook-gap";
import { formatDateTime } from "@/lib/format";

/**
 * ═══════════ «HOÀN VỀ SHOP» MÀ VIETTEL POST GHI «PHÁT THÀNH CÔNG» TRÊN MÃ GỐC ═══════════
 *
 * Hằng số + nhãn dùng chung cho HIỂN THỊ — tệp này an toàn cho client component (không đọc CSDL).
 * Luật (bản TypeScript `detectReturnArrival` + bản SQL `returnArrivalsOf`) nằm ở
 * `lib/queries/shipment-return-arrival.ts`.
 *
 * ─── CHUYỆN GÌ XẢY RA (đo production 25/10/2026) ───
 *
 * Khi kiện HOÀN về tới shop, Viettel Post gửi webhook 501 «Phát thành công» trên MÃ GỐC với
 * `IS_RETURNING = false`, nên ERP lưu chặng `DELIVERED` (chiều đi) — đúng câu chữ của chứng từ, sai
 * về sự thật logistics. Cùng lúc VTP cho dòng CHIỀU HOÀN (mã gốc + `[số]P[số]`, vd
 * PKE15357366151P1) chặng `DELIVERED` với mốc chỉ 5–9 giây sau 501 của mã gốc (6/8 ca mẫu), hoặc
 * 2–3 ngày sau (2/8 ca). Trên 60 ngày: 146 vận đơn gốc có kiện chiều hoàn giao về — 112 trong
 * ±120 giây, 23 trong 3 ngày, 11 quá 3 ngày.
 *
 * ─── VÌ SAO ĐÂY LÀ PHÉP CHIẾU LÚC ĐỌC, KHÔNG PHẢI MỘT LẦN SỬA DỮ LIỆU ───
 *
 *  · KẾT QUẢ ĐƠN đã đúng: `ORDER_OUTCOME` cho luật tiền (0 < thực thu < RETURN_COD) và vận đơn chiều
 *    hoàn thắng chặng `DELIVERED` (xem `docs/tech/order-outcome-branch-order.md`). Tệp này KHÔNG
 *    chạm kết quả đơn, tiền hay tồn kho — chỉ chiều LOGISTICS đang hiển thị.
 *  · Chứng từ ĐVVC KHÔNG BAO GIỜ bị sửa (AGENTS 47): VTP ghi «Phát thành công» thì dòng CARRIER mãi
 *    mãi ghi như vậy; «Hoàn về shop» là một kết luận `DERIVED` đứng cạnh.
 *  · Không ghi cột, không backfill (AGENTS 8.8): kiện chiều hoàn tới sau thì nhãn tự hiện ra lúc xem.
 */

/**
 * Kiện chiều hoàn được phép giao về SỚM HƠN mốc 501 của mã gốc tối đa bấy nhiêu giây. Dùng lại đúng
 * dung sai lệch đồng hồ giữa hai hệ thống đóng dấu giờ của Viettel Post (`WEBHOOK_CLOCK_SKEW_SECONDS`
 * — đo 358/366 dòng lệch ≤ 120 giây). Ca mẫu 25/10: chiều hoàn tới SAU mã gốc 5–9 giây; 112/146 ca
 * trong 60 ngày nằm trong ±120 giây.
 */
export const RETURN_ARRIVAL_SKEW_SECONDS = WEBHOOK_CLOCK_SKEW_SECONDS;

/**
 * Kiện chiều hoàn giao về MUỘN HƠN mốc 501 của mã gốc tối đa bấy nhiêu ngày. Đo 60 ngày: 23/146 ca
 * tới sau 2–3 ngày (2/8 ca mẫu), còn 11 ca quá 3 ngày — nhóm ấy KHÔNG được nhận: kiện chiều hoàn
 * tới quá muộn thì không còn chứng minh được rằng chính lần «Phát thành công» kia là lúc hàng về shop.
 * Bỏ sót (hiện nguyên «Giao thành công» như chứng từ) là phía HẸP hơn; kết quả đơn vẫn đúng nhờ
 * `ORDER_OUTCOME`.
 */
export const RETURN_ARRIVAL_MAX_DAYS = 3;

/** Một vận đơn gốc được xác định là HOÀN VỀ SHOP — kèm hai mốc làm căn cứ. */
export type ReturnArrival = {
  /** Mốc 501 chiều đi SỚM NHẤT của mã gốc (chứng từ VTP). */
  outbound501At: Date;
  /** Mã vận đơn chiều hoàn đã giao về. */
  legCode: string;
  /** Mốc kiện chiều hoàn phát về shop — theo chặng của nó: `DELIVERED` ⇒ `delivered_at`, `RETURNED` ⇒ `returned_at`; thiếu thì `vtp_status_date`. */
  legDeliveredAt: Date;
};

export const RETURN_ARRIVAL_LABEL = "Hoàn về shop";

/** Câu căn cứ in cạnh nhãn / trong nhật ký. KHÔNG thay câu chữ của chứng từ. */
export function returnArrivalDetail(r: ReturnArrival): string {
  return `VTP ghi «Phát thành công» trên mã gốc lúc ${formatDateTime(r.outbound501At)}; kiện chiều hoàn ${r.legCode} giao về lúc ${formatDateTime(r.legDeliveredAt)}`;
}
