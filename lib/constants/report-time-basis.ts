/**
 * ═══════════ MỘT BÁO CÁO PHẢI NÓI RÕ NÓ ĐANG LỌC THEO MỐC NÀO ═══════════
 *
 * ─── ĐO TRƯỚC KHI ĐẶT LUẬT (production 13/09/2026) ───
 *
 *   1.411 vận đơn có CẢ ngày tạo đơn lẫn ngày gửi sang ĐVVC
 *     · 1.038 (73,6%) rơi vào HAI NGÀY KHÁC NHAU
 *     · lệch trung bình 4,5 ngày · lệch lớn nhất 26 ngày
 *
 * Nghĩa là "7 ngày qua" theo ngày tạo đơn và "7 ngày qua" theo ngày gửi chọn ra hai tập gần như
 * khác hẳn nhau. Một bảng có cột đầu tiên tên "Đã gửi" mà lọc theo ngày TẠO ĐƠN là một cái bẫy:
 * người đọc thấy chữ "đã gửi" và tin rằng mình đang xem những kiện gửi trong tuần này.
 *
 * ─── VÌ SAO KHÔNG CHỌN MỘT MỐC DUY NHẤT CHO MỌI BÁO CÁO ───
 *
 * Vì mỗi báo cáo trả lời một câu hỏi khác nhau, và câu hỏi quyết định mốc:
 *
 *   "Lô hàng gửi tuần này đi tới đâu rồi?"      → NGÀY GỬI SANG ĐVVC
 *   "Tuần này xử lý xong bao nhiêu ca hoàn?"    → NGÀY XỬ LÝ (mốc kết quả cuối)
 *   "Đơn chốt tuần này ra doanh thu bao nhiêu?" → NGÀY TẠO ĐƠN
 *
 * Ép cả ba về một mốc thì hai trong ba báo cáo sẽ nói dối. Nên mốc là một LỰA CHỌN CÓ TÊN, hiện
 * ngay cạnh bộ lọc, và mỗi báo cáo khai mặc định của riêng nó.
 */
export const TIME_BASES = ["SHIPPED", "ORDERED", "OUTCOME"] as const;
export type TimeBasis = (typeof TIME_BASES)[number];

export const TIME_BASIS_LABEL: Record<TimeBasis, string> = {
  SHIPPED: "Ngày gửi sang ĐVVC",
  ORDERED: "Ngày tạo đơn",
  OUTCOME: "Ngày xử lý (kết quả cuối)",
};

/** Câu hỏi mà mốc này trả lời — hiện trên tooltip để người dùng chọn đúng, không phải đoán. */
export const TIME_BASIS_QUESTION: Record<TimeBasis, string> = {
  SHIPPED: "Lô hàng gửi đi trong khoảng này đã đi tới đâu? Đúng mốc cho bảng có cột “Đã gửi”.",
  ORDERED: "Đơn chốt trong khoảng này ra kết quả thế nào? Đúng mốc khi so với chi phí quảng cáo của cùng khoảng.",
  OUTCOME: "Trong khoảng này xử lý xong bao nhiêu ca? Đúng mốc cho báo cáo lý do hoàn — ca hoàn hôm nay có thể là đơn của tháng trước.",
};

/**
 * ═══ MỐC ĐVVC TIẾP NHẬN KIỆN (`carrier_handoff_at`) ═══
 *
 * Định nghĩa nằm ở `lib/constants/carrier-handoff.ts` — một hợp đồng, một chỗ, kèm số đo
 * production và bản sinh đôi bằng TypeScript để kiểm thử được. Tệp này chỉ chuyển tiếp để những
 * nơi gọi cũ không phải đổi đường nhập.
 *
 * Bản trước định nghĩa mốc ngay tại đây bằng `coalesce(picked_up_at, <sự kiện bất kỳ có chặng>)`.
 * Vế thứ hai nhận cả `PENDING` và `CANCELLED`, nên "lấy hàng thất bại" và "shop huỷ lấy" cũng
 * được đóng dấu đã bàn giao — đo trên production ngày 13/09/2026 là 120 vận đơn.
 */
import { CARRIER_HANDOFF_AT_SQL } from "@/lib/constants/carrier-handoff";

export { CARRIER_HANDOFF_AT_SQL, CARRIER_HANDOFF_BASIS_SQL, CARRIER_HANDOFF_STAGES, HANDOFF_BASIS_LABEL, HANDOFF_BASIS_HINT, type HandoffBasis } from "@/lib/constants/carrier-handoff";

/**
 * ═══ MỐC KẾT QUẢ CUỐI (`final_outcome_at`) ═══
 *
 * Khi nào một ca đi tới kết luận: `delivered_at` cho kiện giao được, `returned_at` cho kiện hoàn,
 * rồi tới mốc trạng thái ĐVVC gần nhất — cả ba đều là chứng từ của ĐVVC.
 *
 * KHÔNG rơi về `updated_at`: cột đó bị chạm bởi mọi lần ghi, kể cả một lần đồng bộ không đổi gì.
 * Dùng nó thì "ngày xử lý" của một ca hoàn từ tháng trước sẽ nhảy sang hôm nay chỉ vì job chạy —
 * và báo cáo tháng này bỗng có thêm những ca đã đóng từ lâu.
 */
export const FINAL_OUTCOME_AT_SQL = `coalesce("shipments"."delivered_at", "shipments"."returned_at", "shipments"."vtp_status_date")`;

/**
 * CỘT MỐC CỦA MỘT CÁCH LỌC, dạng chuỗi SQL thô — MỘT bản khai cho mọi báo cáo.
 *
 * Trước bản 14/09 hàm này được chép ở hai tệp truy vấn (`return-reason-report.ts` và
 * `return-intelligence.ts`). Hai bản đang đồng ý với nhau, nhưng sửa một mốc là một lượt sửa hai
 * chỗ — và `tests/duplicate-metrics.test.ts` bắt đúng lớp lỗi đó ở mức mã nguồn.
 *
 * Dùng TÊN BẢNG ĐẦY ĐỦ (`"orders"` / `"shipments"`) vì hai biểu thức mốc kia cũng vậy: một chuỗi
 * SQL thô mang bí danh sẽ hỏng với "missing FROM-clause entry".
 */
export function timeBasisColumnSql(basis: TimeBasis): string {
  if (basis === "ORDERED") return `"orders"."inserted_at"`;
  return basis === "SHIPPED" ? CARRIER_HANDOFF_AT_SQL : FINAL_OUTCOME_AT_SQL;
}
