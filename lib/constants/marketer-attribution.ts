/**
 * ═══════════ QUY KẾT MARKETER CHO MỘT ĐƠN — ĐI BẰNG QUAN HỆ, KHÔNG ĐỌC TÊN CHIẾN DỊCH ═══════════
 *
 * ─── CÂU HỎI ───
 *
 * "Đơn này do ai chạy quảng cáo mang về?" Nó KHÁC hẳn câu hỏi mà báo cáo Quảng cáo/Lương đang trả
 * lời — chỗ đó **chia doanh số của một mã hàng theo tỷ trọng TIỀN QUẢNG CÁO** mỗi marketer đã chi
 * cho mã đó. Phép chia ấy đúng cho việc phân bổ LỢI NHUẬN (một mã có ba người cùng chạy thì doanh
 * số của mã chia ba), nhưng nó KHÔNG nói được đơn số 12345 là của ai — và báo cáo hoàn cần đúng
 * điều đó: một marketer đưa về đơn dễ hoàn phải nhìn thấy trên chính những đơn của mình.
 *
 * ─── ĐƯỜNG ĐI, VÀ VÌ SAO KHÔNG CÓ ĐƯỜNG THỨ HAI ───
 *
 *   orders.ad_id  → fb_ads.campaign_id                          (bằng chứng trực tiếp nhất)
 *   orders.post_id → fb_ads.post_id → campaign_id               (chỉ khi bài thuộc ĐÚNG 1 chiến dịch)
 *   campaign_id   → ad_spends.marketer_id                       (chỉ khi chiến dịch có ĐÚNG 1 người)
 *
 * Hai mắt xích đầu đã có sẵn ở `lib/queries/ads-attribution-link.ts` và được ROAS dùng — tệp này
 * KHÔNG viết lại chúng, chỉ nối thêm mắt xích thứ ba.
 *
 * **TUYỆT ĐỐI KHÔNG dò chữ trong `ad_spends.campaign`.** Kho mã có sẵn `Employee.aliases` (những
 * mẩu chữ như `"QA4"`, `"QUAN TA"`) và cám dỗ là `campaign ilike '%QA4%'`. Đó đúng là lớp lỗi mà
 * `lib/queries/product-code.ts` đã ghi lại bằng số đo: bốn mã hàng của chính shop này có bốn quy
 * ước đặt tên khác nhau, và không có ngưỡng chuỗi nào vừa đủ rộng vừa đủ hẹp. Quy kết sai ở đây
 * không chỉ làm lệch một báo cáo — nó ghi tỷ lệ hoàn của người này lên thẻ điểm của người kia.
 *
 * ─── BỐN TÌNH TRẠNG, VÀ BA TRONG SỐ ĐÓ LÀ "CHƯA XÁC ĐỊNH" ───
 *
 * `RESOLVED` là tình trạng DUY NHẤT cho phép ghi tên một người. Ba tình trạng còn lại đều hiện ra
 * màn hình dưới cùng một nhãn "Chưa xác định" nhưng được ĐẾM RIÊNG, vì cách sửa của chúng khác
 * nhau: thiếu mắt xích quảng cáo thì phải đồng bộ Facebook, thiếu khai báo thì chủ shop khai ở
 * trang Quảng cáo, còn nhập nhằng thì phải tách chiến dịch.
 *
 * ─── LUẬT BẤT BIẾN: BẬT CHIỀU MARKETER KHÔNG ĐƯỢC LÀM ĐỔI TỔNG ───
 *
 * Mỗi đơn thuộc ĐÚNG MỘT nhóm marketer (kể cả nhóm "Chưa xác định"), nên cộng mọi nhóm phải ra
 * đúng con số khi không bật chiều nào. Không chia một đơn cho hai người, không bỏ rơi đơn không
 * quy kết được. `tests/marketer-attribution.test.ts` khoá điều này.
 */

/** Khoá nhóm của đơn KHÔNG quy kết được. Là một nhóm thật, luôn hiện, không bao giờ bị lọc mất. */
export const MARKETER_UNRESOLVED = "__unresolved__" as const;
export const MARKETER_UNRESOLVED_LABEL = "Chưa xác định";

export const MARKETER_LINK_STATES = ["RESOLVED", "NO_CAMPAIGN", "CAMPAIGN_NO_MARKETER", "AMBIGUOUS"] as const;
export type MarketerLinkState = (typeof MARKETER_LINK_STATES)[number];

export const MARKETER_LINK_LABEL: Record<MarketerLinkState, string> = {
  RESOLVED: "Quy kết được một marketer",
  NO_CAMPAIGN: "Đơn không nối được về chiến dịch nào",
  CAMPAIGN_NO_MARKETER: "Chiến dịch chưa khai marketer phụ trách",
  AMBIGUOUS: "Chiến dịch có nhiều marketer — nhập nhằng",
};

/** Việc phải làm để lấp từng loại chỗ trống. Một bảng chỉ in con số là bảng không ai mở lần thứ hai. */
export const MARKETER_LINK_FIX: Record<MarketerLinkState, string> = {
  RESOLVED: "",
  NO_CAMPAIGN: "Đơn không có ad_id và cũng không có post_id nối được về đúng một chiến dịch. Chạy đồng bộ Facebook (job facebook-ad-index) để bổ sung mối nối bài viết → chiến dịch.",
  CAMPAIGN_NO_MARKETER: "Chiến dịch đã nối được nhưng chưa ai khai người phụ trách. Khai ở Quảng cáo → Ghép chiến dịch với marketer.",
  AMBIGUOUS: "Cùng một chiến dịch đang mang hai marketer khác nhau trong bảng chi tiêu. Chọn một người ở Quảng cáo → Ghép chiến dịch, hoặc tách chiến dịch.",
};

/** Độ phủ quy kết — số và tỷ lệ, kèm tách theo lý do thiếu. `pct` là `null` khi không có đơn nào. */
export type MarketerCoverage = {
  total: number;
  resolved: number;
  pct: number | null;
  byState: Record<MarketerLinkState, number>;
};

/**
 * NGƯỠNG CẢNH BÁO ĐỘ PHỦ. Dưới ngưỡng thì mọi con số theo marketer phải đi kèm cảnh báo: con số
 * đúng cho phần quy kết được, nhưng phần quy kết được có thể không đại diện cho toàn shop.
 *
 * 70% không phải con số đẹp: đó là mức mà nhóm "Chưa xác định" vẫn còn nhỏ hơn nhóm lớn nhất
 * trong ba marketer — trên mức đó, xếp hạng giữa các marketer còn có nghĩa.
 */
export const MARKETER_COVERAGE_WARN_PCT = 70;
