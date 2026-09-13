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
 * Đo production 13/09/2026: 2.103 vận đơn, 1.417 có `picked_up_at`, **494 đã rời kho mà cột mốc
 * vẫn rỗng** (webhook lấy hàng không về, hoặc vận đơn dựng từ tệp nhập). Lọc thẳng theo
 * `picked_up_at` sẽ âm thầm đánh rơi 494 kiện — bảng vẫn ra số, chỉ thiếu một phần tư.
 *
 * HAI BẬC CHỨNG CỨ, CẢ HAI ĐỀU TỪ ĐVVC:
 *   1. `picked_up_at`                    — ĐVVC xác nhận đã lấy hàng. Mạnh nhất.
 *   2. sự kiện ĐVVC ĐẦU TIÊN của vận đơn — kiện đã vào mạng lưới ĐVVC, chỉ thiếu mốc lấy hàng.
 *
 * ─── VÀ KHÔNG CÓ BẬC THỨ BA ───
 *
 * `shipments.created_at` CỐ Ý KHÔNG được dùng làm bậc dự phòng, dù nó luôn có giá trị. Nó là mốc
 * ERP TẠO DÒNG — người bán bấm nút tạo vận đơn — chứ không phải mốc ĐVVC cầm hàng. Hai thứ cách
 * nhau nhiều ngày, và lấy nó lấp vào chỗ trống sẽ tạo ra một cohort trông đầy đủ mà sai: kiện
 * chưa ai lấy vẫn nằm trong "lô hàng gửi tuần này".
 *
 * Dùng TÊN BẢNG ĐẦY ĐỦ `"shipments"` chứ không phải bí danh `s`: Drizzle phát ra tên bảng thật
 * trong câu lệnh, nên một chuỗi SQL thô mang bí danh sẽ hỏng với "missing FROM-clause entry".
 *
 * Không có chứng cứ ⇒ `NULL` ⇒ kiện đó KHÔNG vào cohort, và báo cáo nói rõ có bao nhiêu kiện rơi
 * ra vì lý do này. Một con số thiếu mà BIẾT là thiếu dùng được; một con số đầy đủ giả thì không.
 */
export const CARRIER_HANDOFF_AT_SQL = `coalesce(
  "shipments"."picked_up_at",
  (select min(e.occurred_at) from shipment_events e
    where e.shipment_id = "shipments"."id" and e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL') and e.normalized_stage is not null)
)`;

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
