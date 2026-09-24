import type { OrderStage, ShipmentStage } from "@/db/schema";
import type { CsKind } from "@/lib/constants/cs";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";

/**
 * ═══════════ CASE DO MÁY SINH TỪ CHỨNG TỪ — KHI NÀO CHỨNG TỪ ĐÃ ĐI TIẾP ═══════════
 *
 * `lib/constants/case-semantics.ts::CASE_ELIGIBILITY` khai điều kiện cho các loại mà TẦNG NGỮ
 * NGHĨA được phép kết luận. Hai loại dưới đây KHÔNG được có mặt ở đó — khai ở đó là mở cửa cho
 * model tự sinh "giao không thành" từ một câu chat. Nhưng chúng vẫn cần một điều kiện SỐNG, vì
 * không có nó thì chúng không bao giờ tự hết:
 *
 *  · `DELIVERY_FAILED` — sinh từ MỘT vận đơn đang ở chặng giao không thành
 *    (`lib/cs/failed-delivery.ts`, khoá `failed-delivery:<shipmentId>:<ngày>`). Việc là "liên hệ
 *    khách về lần giao hỏng ĐÓ". Kiện đã sang chặng khác (phát lại · đang hoàn · đã giao · đã
 *    chốt) thì lần hỏng đó đã qua; hỏng lần nữa thì bot mở case MỚI với khoá ngày mới.
 *  · `PHONE_VERIFY` — "xác nhận SĐT TRƯỚC KHI GỬI HÀNG" (`lib/cs/phone-verify.ts`). Hàng đã giao
 *    cho ĐVVC hoặc đơn đã huỷ thì bước trước-khi-gửi không còn tồn tại.
 *
 * Và một bổ sung cho `URGE_DELIVERY`: `CASE_ELIGIBILITY` hỏi chặng POS của đơn, nhưng POS có thể
 * trễ hơn Viettel Post — ĐVVC đã chốt MỌI kiện của đơn thì câu giục là chuyện đã qua dù POS còn ghi
 * "Đã gửi hàng". Chứng từ ĐVVC ưu tiên hơn Pancake (AGENTS.md mục 3.6). Bổ sung này KHÔNG chạm
 * `orderFinal`: `exchangeGuard` dùng `orderFinal` kèm chặng POS để phân biệt "đã giao" với "đã
 * hoàn", và đổi nghĩa nó sẽ đóng nhầm case đổi size của đơn đã giao.
 *
 * ─── CHỈ ĐÓNG, KHÔNG BAO GIỜ MỞ ───
 *
 * Hàm này chỉ trả lời "chứng từ đã đi tiếp chưa". Không trả lời được (thiếu vận đơn, thiếu đơn) ⇒
 * `null` ⇒ nơi gọi GIỮ NGUYÊN case. Chưa biết không phải bằng chứng rằng việc đã xong.
 *
 * Kết luận ở đây KHÔNG dùng cho kết quả đơn, doanh thu hay tồn kho — chỉ quyết một dòng việc CSKH
 * còn nằm trong hàng đợi hay không.
 */

export type LivenessFacts = {
  /** Vận đơn mà case `DELIVERY_FAILED` sinh ra từ nó; `null` = không tìm thấy (CHƯA BIẾT). */
  caseShipment: { stage: string; isFinal: boolean } | null;
  /** Cùng vận đơn đã có một case giao-không-thành MỚI HƠN — case này bị thay thế. */
  newerFailureCase: boolean;
  /** Chặng POS của đơn gắn với case; `null` = case không gắn đơn. */
  orderStage: string | null;
  /**
   * Ba con số dưới đây chỉ đếm vận đơn nối THẲNG vào đơn của case (theo `order_id`, KHÔNG theo SĐT
   * — một SĐT có thể có kiện của đơn khác).
   *
   * Số kiện còn đang chạy (`is_final = false`).
   */
  orderShipmentsActive: number;
  /**
   * Trong đó ĐVVC THẬT SỰ đã cầm hàng: chặng hiện tại thuộc `CARRIER_HANDOFF_STAGES` hoặc có mốc
   * lấy hàng. Vận đơn "Chờ lấy hàng" KHÔNG tính — shop vẫn còn giữ hàng (AGENTS.md mục 41).
   */
  orderShipmentsHandedOff: number;
  /**
   * Trong đó ĐVVC đã CHỐT ở chặng phát xong hoặc đã hoàn (`is_final` và chặng `DELIVERED` /
   * `RETURNED`). Kiện huỷ lấy cũng `is_final` nhưng KHÔNG nằm ở đây: hàng chưa đi thì khách giục
   * lại càng đúng. Đây là chứng từ chặng của ĐVVC, KHÔNG phải kết luận giao thành công — kết quả
   * đơn vẫn chỉ đi qua `ORDER_OUTCOME`.
   */
  orderShipmentsSettled: number;
};

export type Liveness = { alive: true } | { alive: false; reason: string } | null;

/** Chặng POS cho thấy đơn đã rời shop — bước "trước khi gửi" không còn. */
const ORDER_LEFT_SHOP: ReadonlySet<string> = new Set<OrderStage>(["SHIPPED", "DELIVERED", "PAID", "RETURNING", "PARTIAL_RETURN", "RETURNED"]);
const ORDER_VOID: ReadonlySet<string> = new Set<OrderStage>(["CANCELLED", "DELETED"]);

const shipLabel = (stage: string) => SHIPMENT_STAGE_LABEL[stage as ShipmentStage] ?? stage;
const orderLabel = (stage: string) => ORDER_STAGE_LABEL[stage as OrderStage] ?? stage;

export const LIVENESS_RULES: Partial<Record<CsKind, (f: LivenessFacts) => Liveness>> = {
  DELIVERY_FAILED: (f) => {
    if (!f.caseShipment) return null;
    if (f.caseShipment.isFinal) return { alive: false, reason: `Kiện đã kết thúc — ĐVVC báo “${shipLabel(f.caseShipment.stage)}”, lần giao không thành này đã qua` };
    if (f.caseShipment.stage !== "DELIVERY_FAILED") return { alive: false, reason: `Kiện đã rời chặng giao không thành, đang ở “${shipLabel(f.caseShipment.stage)}”` };
    if (f.newerFailureCase) return { alive: false, reason: "Cùng kiện đã có lần giao không thành mới hơn — case mới thay case này" };
    return { alive: true };
  },
  PHONE_VERIFY: (f) => {
    if (f.orderStage && ORDER_VOID.has(f.orderStage)) return { alive: false, reason: `Đơn ${orderLabel(f.orderStage).toLowerCase()} trên POS — không còn gì để xác nhận trước khi gửi` };
    if (f.orderShipmentsHandedOff > 0) return { alive: false, reason: "ĐVVC đã lấy hàng — bước xác nhận SĐT trước khi gửi đã qua" };
    if (f.orderStage && ORDER_LEFT_SHOP.has(f.orderStage)) return { alive: false, reason: `POS ghi đơn “${orderLabel(f.orderStage)}” — bước xác nhận SĐT trước khi gửi đã qua` };
    if (!f.orderStage) return null;
    return { alive: true };
  },
  URGE_DELIVERY: (f) => {
    if (f.orderShipmentsSettled > 0 && f.orderShipmentsActive === 0) return { alive: false, reason: "ĐVVC đã chốt kiện của đơn (phát xong / đã hoàn), không còn kiện nào đang chạy — câu giục là chuyện đã qua" };
    // Còn kiện đang chạy / chưa có kiện: để `CASE_ELIGIBILITY` quyết như cũ.
    return null;
  },
};

/** `null` = loại này không khai, hoặc chứng từ không đủ để kết luận — nơi gọi đi tiếp luật cũ. */
export function checkLiveness(kind: CsKind, facts: LivenessFacts): Liveness {
  const rule = LIVENESS_RULES[kind];
  return rule ? rule(facts) : null;
}
