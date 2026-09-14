import { PANCAKE_ORDER_STATUS } from "@/lib/constants/pancake";
import type { OrderStage } from "@/db/schema";

/**
 * ═══════════ "ĐƠN ĐÃ ĐƯỢC TẠO CHƯA" — MỘT CÂU HỎI, MỘT CÂU TRẢ LỜI ═══════════
 *
 * Chủ shop chốt 14/09/2026: **POS ở trạng thái "Đã xác nhận" nghĩa là đơn ĐÃ ĐƯỢC TẠO.** Đó là
 * một luật nghiệp vụ, và như mọi luật nghiệp vụ trong kho này, nó phải có đúng MỘT chỗ khai.
 *
 * ─── VÌ SAO KHÔNG SO CHUỖI HIỂN THỊ ───
 *
 * Cám dỗ đầu tiên là `status_name === "Đã xác nhận"`. Sai ở ba tầng cùng lúc:
 *
 *  · chuỗi hiển thị là thứ Pancake được phép đổi bất cứ lúc nào mà không báo ai — đổi thành
 *    "Đã xác nhận đơn" là mọi phép so bằng im lặng trả `false`, và hàng đợi CSKH lại đầy việc giả;
 *  · dấu tiếng Việt phụ thuộc cách chuẩn hoá Unicode của phía gửi (NFC hay NFD) — hai chuỗi trông
 *    hệt nhau trên màn hình vẫn khác nhau khi so bằng;
 *  · nó bỏ sót mọi trạng thái ĐI SAU "Đã xác nhận". Đơn đã in, đã đóng, đã gửi, đã giao thì lại
 *    càng chắc chắn là đã được tạo — nhưng tên của chúng không phải chuỗi ấy.
 *
 * API Pancake có **mã số ổn định** (`PANCAKE_ORDER_STATUS`): "Đã xác nhận" là mã `1`. Mã số là
 * hợp đồng; chuỗi hiển thị là giao diện. Luật này bám vào mã.
 *
 * ─── DANH SÁCH: "ĐÃ XÁC NHẬN" TRỞ ĐI ───
 *
 * Suy ra TỪ `PANCAKE_ORDER_STATUS` chứ không gõ lại, nên thêm một mã mới vào bảng kia là tự động
 * được xét ở đây — không có đường nào để hai nơi lệch nhau.
 *
 * ─── BỐN TRẠNG THÁI CỐ Ý NẰM NGOÀI ───
 *
 *  · `NEW` (mã 0) và "Chờ xác nhận" (17) — nhân viên mới gõ vào, chưa ai xác nhận. Chính chủ shop
 *    vạch ranh giới ở "Đã xác nhận", nên vạch đúng chỗ đó.
 *  · `WAITING` (11 "Chờ hàng", 20 "Đã đặt hàng") — đứng TRƯỚC xác nhận trong `ORDER_STAGE_ORDER`.
 *  · `CANCELLED` (6) và `DELETED` (7) — đơn TỪNG được tạo rồi bị huỷ. Đọc thành lời: khách này có
 *    thể đang cần một đơn MỚI, nên việc CSKH vẫn còn thật. Xếp chúng vào "đã tạo" là đóng đúng
 *    những case đáng làm — cùng cái bẫy mà `lib/cs/reconcile-order-created.ts` đã mô tả.
 *
 * Lề an toàn nghiêng về GIỮ CASE MỞ: một việc giả làm người trực mất một cuộc gọi, một việc bị
 * đóng nhầm làm shop mất một đơn hàng.
 */

/** Các chặng chứng minh đơn đã tồn tại thật. Bằng "Đã xác nhận" trở đi, KHÔNG gồm huỷ/xoá. */
export const ORDER_MATERIALIZED_STAGES: readonly OrderStage[] = [
  "CONFIRMED",
  "PACKING",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "PAID",
  "RETURNING",
  "PARTIAL_RETURN",
  "RETURNED",
] as const;

const STAGE_SET = new Set<string>(ORDER_MATERIALIZED_STAGES);

/**
 * Mã trạng thái Pancake tương ứng — **SINH RA** từ `PANCAKE_ORDER_STATUS`, không gõ lại.
 *
 * Gõ lại là tạo một danh sách thứ hai phải nhớ sửa cùng lúc, và kho mã này đã mất một bản phát
 * hành vì đúng chuyện đó ("Đã gửi" gõ nguyên văn ở bốn chỗ).
 */
export const ORDER_MATERIALIZED_STATUS_CODES: readonly number[] = Object.entries(PANCAKE_ORDER_STATUS)
  .filter(([, v]) => STAGE_SET.has(v.stage))
  .map(([code]) => Number(code))
  .sort((a, b) => a - b);

const CODE_SET = new Set<number>(ORDER_MATERIALIZED_STATUS_CODES);

/** Mã số của "Đã xác nhận" — nêu tên để đọc được, và để kiểm thử ghim đúng con số chủ shop nói. */
export const PANCAKE_STATUS_CONFIRMED = 1;

/**
 * ĐƠN NÀY ĐÃ ĐƯỢC TẠO THẬT CHƯA?
 *
 * Nhận `stage` (enum của ERP) hoặc `status` (mã Pancake thô) — bên nào có thì dùng bên đó. Nơi gọi
 * nào cũng có ít nhất một trong hai, và không nơi nào phải tự dịch qua lại.
 *
 * `null` / `undefined` ⇒ `false`: CHƯA BIẾT không phải "đã tạo" (AGENTS.md mục 3.3). Lề an toàn
 * nghiêng về giữ case mở.
 */
export function isOrderMaterialized(input: { stage?: OrderStage | string | null; status?: number | null }): boolean {
  if (typeof input.status === "number" && CODE_SET.has(input.status)) return true;
  return typeof input.stage === "string" && STAGE_SET.has(input.stage);
}

/** Dạng dùng được trong `in (...)` của SQL. Sinh từ chính mảng trên. */
export const ORDER_MATERIALIZED_STAGES_SQL = ORDER_MATERIALIZED_STAGES.map((s) => `'${s}'`).join(",");

/**
 * ═══════════ CỬA SỔ "ĐƠN NÀY LÀ ĐƠN CASE ĐANG CHỜ" ═══════════
 *
 * Một đơn đã xác nhận trong CÙNG hội thoại vẫn chưa đủ để đóng case, vì hội thoại Pancake sống
 * rất lâu: khách mua tháng trước rồi tháng này nhắn mua tiếp thì vẫn là một `conversation_id`.
 *
 * ─── ĐO TRÊN CẢ 10 CASE ĐANG MỞ (production 14/09/2026) ───
 *
 * Bốn case có đơn "Đã xác nhận" trong cùng hội thoại. Khoảng cách từ lúc tạo đơn tới mốc case:
 *
 *   **3 giờ**    `CONFIRMED`  ← đúng đơn case đang chờ
 *   **5 giờ**    `CONFIRMED`  ← đúng đơn ấy
 *   83 giờ       `CONFIRMED`  ← 3,5 ngày: KHÔNG kết luận được
 *   298 giờ      `DELIVERED`  ← 12,4 ngày: KHÁCH MUA LẠI, đóng là đóng một việc thật
 *
 * Và một phép đo nữa đã loại bỏ cách làm tưởng như hiển nhiên: ở **cả bốn** case, đơn đã xác nhận
 * của hội thoại CHÍNH LÀ `cs_cases.order_id`. Không có case nào mà hai thứ đó khác nhau. Nên luật
 * "chỉ đóng khi đơn KHÁC đơn máy quét đã thấy" nghe rất chắc nhưng đóng được đúng 0 case — nó
 * không phân biệt được gì trên dữ liệu thật.
 *
 * Thứ duy nhất phân biệt được là KHOẢNG CÁCH THỜI GIAN, và nó phân tách rất rõ: hai đơn thật cách
 * 3–5 giờ, hai đơn không kết luận được cách 83 và 298 giờ. Không có gì ở giữa.
 *
 * ─── HAI NGÀY ───
 *
 * Một đơn chốt trong chat thì lên POS trong ngày, chậm lắm là hôm sau — nên 48 giờ đã rộng gấp
 * mười lần khoảng cách thật đo được. Chọn 48 thay vì 72 để chừa khoảng trống rõ ràng với ca 83
 * giờ: một ngưỡng chỉ cách dữ liệu thật 11 giờ là một ngưỡng sẽ tự lật khi có thêm vài đơn.
 *
 * Quá cửa sổ mà case vẫn mở thì cái đang mở là một LƯỢT MUA KHÁC, và máy KHÔNG đủ căn cứ để kết
 * luận — chỗ đó dành cho người, hoặc cho tầng ngữ nghĩa.
 */
export const ORDER_MATCH_WINDOW_DAYS = 2;
