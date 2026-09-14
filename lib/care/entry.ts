import { carrierSubstate, SUBSTATE_IMPLIES_PICKED_UP, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import type { ShipmentStage } from "@/db/schema";

/**
 * ═══════════ "CẦN CARE" LÀ GÌ — MỘT HÀM, HAI NƠI GỌI ═══════════
 *
 * ─── VẤN ĐỀ ───
 *
 * Trước bản này có HAI định nghĩa của cùng một câu hỏi:
 *
 *   `lib/queries/delivery-tower.ts`  — "chờ xử lý" chỉ vào rổ việc khi CÓ CHỨNG TỪ rời kho;
 *   `lib/care/lifecycle.ts`          — mọi sự kiện mã 102 đều MỞ một đợt chăm sóc.
 *
 * Đo production 13/09/2026: 106 đợt đang mở ở trạng thái NEW, TẤT CẢ do mã 102 "Đơn hàng chờ xử
 * lý" mở — tức gói hàng còn nằm trong chính kho của shop, chưa bưu tá nào cầm. Đó không phải việc
 * của đội chăm sóc, và hàng đợi 106 dòng như vậy là hàng đợi không ai mở lần thứ hai. Cùng lúc,
 * 43 kiện "Chờ xử lý" không có mã (nhiều kiện đã lấy hàng) KHÔNG có đợt nào, vì webhook của chúng
 * đến trước khi luật này tồn tại.
 *
 * ─── ĐỊNH NGHĨA (chủ shop chốt) ───
 *
 * CẦN CARE = ĐVVC ĐANG CẦM HÀNG và đang chờ một quyết định / một lượt phát lại:
 *
 *   · `WAITING_REDELIVERY`  — bưu tá phát hụt và sẽ quay lại. Đã phát hụt thì chắc chắn đã cầm hàng
 *                             ⇒ luôn mở.
 *   · `WAITING_PROCESSING`  — kiện nằm chờ ở bưu cục. Nhưng cùng câu chữ này xuất hiện ở cả hai
 *                             phía mốc lấy hàng (mã 102 = còn trong kho) ⇒ CHỈ mở khi có chứng từ
 *                             rời kho. Chứng từ đó lấy từ `SUBSTATE_IMPLIES_PICKED_UP` +
 *                             `leftWarehouse` — cùng luật với `getOrderFulfillmentBucket()`.
 *   · `DELIVERY_EXCEPTION`  — "Tồn - khách nghỉ / không có nhà" (506/507). Đặc tả của chủ shop chỉ
 *                             nêu hai trạng thái trên, nhưng về vận hành "tồn" chính là "phát hụt,
 *                             chưa hẹn được lần sau" — cùng việc với chờ phát lại, chỉ khác là
 *                             chưa có giờ hẹn. Tháp giao vận đã xếp nó vào rổ việc từ trước; bỏ nó
 *                             khỏi tập này là 16 kiện "tồn" đang có trên production lặng lẽ rơi
 *                             khỏi hàng đợi. Giữ, và nói rõ ở đây để không ai tưởng là sơ suất.
 *
 * KHÔNG nằm trong tập: kiện đang đi bình thường, kiện đã kết thúc, và mọi sự kiện thuộc CHIỀU HOÀN
 * (bưu tá đang mang hàng về shop thì không còn khách nào để gọi).
 */
export const CARE_ENTRY_SUBSTATES: readonly CarrierSubstate[] = ["WAITING_PROCESSING", "WAITING_REDELIVERY", "DELIVERY_EXCEPTION"];

/**
 * Chặng của một sự kiện hành trình chứng minh gói hàng ĐÃ RỜI KHO. Dùng chung cho SQL của tháp
 * giao vận và cho vòng đời care — hai nơi phải đọc cùng một danh sách, nếu không một kiện "đã rời
 * kho" ở màn hình này lại "còn trong kho" ở màn hình kia.
 */
export const LEFT_WAREHOUSE_EVENT_STAGES: readonly ShipmentStage[] = ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURNING", "RETURNED"];

/** Chặng KẾT THÚC của chiều ĐVVC — đợt chăm sóc không mở ở đây, chỉ chốt. */
export const CARE_TERMINAL_STAGES: readonly ShipmentStage[] = ["DELIVERED", "RETURNED", "CANCELLED"];

export type CareEntryVerdict = {
  /** Kiện có đang trong điều kiện cần care không. */
  enters: boolean;
  substate: CarrierSubstate;
  /** Vì sao — một câu, hiện trong nhật ký. */
  reason: string;
};

/**
 * "Kiện này có cần care không?" — đúng một câu hỏi, đúng một câu trả lời.
 *
 * `leftWarehouse` là CHỨNG TỪ (mốc lấy hàng hoặc một sự kiện hành trình mang chặng sau mốc lấy),
 * không phải câu chữ trạng thái. Với trạng thái con mà `SUBSTATE_IMPLIES_PICKED_UP` nói "đã cầm
 * hàng" thì chứng từ là thừa; với trạng thái MƠ HỒ thì chứng từ là bắt buộc.
 */
export function careEntryFor(substate: CarrierSubstate, leftWarehouse: boolean): CareEntryVerdict {
  if (!CARE_ENTRY_SUBSTATES.includes(substate)) return { enters: false, substate, reason: `trạng thái ${substate} không phải điều kiện cần care` };
  const camHang = SUBSTATE_IMPLIES_PICKED_UP[substate];
  if (camHang === "YES") return { enters: true, substate, reason: `ĐVVC báo ${substate} — đã cầm hàng theo chính trạng thái đó` };
  if (leftWarehouse) return { enters: true, substate, reason: `ĐVVC báo ${substate} và có chứng từ rời kho` };
  return { enters: false, substate, reason: `ĐVVC báo ${substate} nhưng chưa có chứng từ rời kho — hàng còn trong kho, không phải việc của đội chăm sóc` };
}

/**
 * CÙNG MỘT MÃ, HAI Ý NGHĨA TRÁI NGƯỢC — tuỳ chiều đi hay chiều hoàn.
 *
 * Viettel Post ghi 501 "Phát thành công" cho cả phát tới khách lẫn phát hàng hoàn về shop. Cờ
 * `IS_RETURNING` (lưu ở `shipment_events.leg_type`) là thứ phân biệt. Hàm này chép đúng phép quy
 * đổi của `deriveShipmentState()` (lib/integrations/viettelpost/state.ts) để mọi quyết định care
 * nhìn thấy cùng một chặng với ảnh chụp vận đơn.
 */
export function legAwareStage(stage: ShipmentStage, legType: "OUTBOUND" | "RETURN" | null | undefined): ShipmentStage {
  if (legType !== "RETURN") return stage;
  if (stage === "DELIVERED") return "RETURNED";
  if (stage === "PICKED_UP" || stage === "IN_TRANSIT" || stage === "OUT_FOR_DELIVERY" || stage === "DELIVERY_FAILED") return "RETURNING";
  return stage;
}

/**
 * Trạng thái con dùng để MỞ / mô tả đợt: mã + chữ như mọi nơi khác, nhưng nếu chặng leg-aware nói
 * kiện đã quay đầu thì trạng thái con phải nói cùng một điều — 501 chiều hoàn là `RETURNED`, không
 * phải `DELIVERED`.
 */
export function legAwareSubstate(input: { code: number | null; text: string | null; stage: ShipmentStage }): CarrierSubstate {
  const { substate } = carrierSubstate({ code: input.code, text: input.text, stage: input.stage });
  if (input.stage === "RETURNED" && substate === "DELIVERED") return "RETURNED";
  if (input.stage === "RETURNING" && (substate === "DELIVERED" || substate === "OUT_FOR_DELIVERY" || substate === "DELIVERY_EXCEPTION" || substate === "WAITING_REDELIVERY" || substate === "WAITING_PROCESSING")) return "RETURNING";
  return substate;
}
