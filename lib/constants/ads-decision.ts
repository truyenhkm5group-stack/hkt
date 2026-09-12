/**
 * ───────────── NGƯỠNG RA QUYẾT ĐỊNH QUẢNG CÁO ─────────────
 *
 * MỘT nơi duy nhất giữ các con số quyết định SCALE / HOLD / WATCH / CUT. Không hard-code ở trang,
 * ở truy vấn hay ở kiểm thử — đúng luật AGENTS.md mục 3.4 (ngưỡng nghiệp vụ chỉ sửa tại một chỗ,
 * và chỉ khi chủ shop yêu cầu).
 *
 * Vì sao ngưỡng phải đứng TRƯỚC công thức: một khuyến nghị "CẮT" đưa ra trên 3 đơn không phải là
 * khuyến nghị, đó là tiếng ồn. Toàn bộ thiết kế dưới đây là để **từ chối kết luận** khi dữ liệu
 * chưa đủ, thay vì luôn luôn có ý kiến.
 */
export const ADS_DECISION_RULE = {
  /**
   * Tiền quảng cáo tối thiểu của một dòng trước khi được phép kết luận về TIỀN.
   * Dưới mức này, chênh lệch ROAS chỉ là may rủi của vài đơn.
   */
  minSpend: 300_000,
  /**
   * Số đơn ĐÃ KẾT THÚC (giao thành công + hoàn) tối thiểu để kết luận về tỷ lệ giao thành công.
   * Dưới mức này, GTC dao động quá mạnh: 2/3 đơn = 67%, mất đúng một đơn thành 33%.
   */
  minFinishedOrders: 10,
  /**
   * Tỷ lệ đơn đã kết thúc trên tổng đơn đã lên. Dưới mức này nghĩa là phần lớn đơn còn đang đi —
   * kết quả tiền của dòng này CHƯA ngã ngũ, và mọi con số lợi nhuận đang thiếu vế hoàn.
   *
   * Đây chính là "tiền đang treo ở nhóm chưa đủ dữ liệu": tiền đã tiêu thật, kết quả chưa biết.
   */
  minMaturity: 0.6,
  /**
   * Biên an toàn trên điểm hoà vốn để được khuyến nghị TĂNG NGÂN SÁCH.
   * 1,3 = ROAS thực đang cao hơn ROAS hoà vốn 30%; đủ chỗ cho sai số giá vốn và cước.
   */
  scaleAbove: 1.3,
  /** Dưới điểm hoà vốn quá mức này thì CẮT. 0,8 = đang lỗ hơn 20% so với hoà vốn. */
  cutBelow: 0.8,
  /**
   * Tỷ lệ giao thành công thấp — quảng cáo có thể vẫn ra đơn tốt, nhưng tiền chết ở khâu giao.
   * Đây là dấu hiệu "ads tốt nhưng hoàn cao": xử lý bằng chốt đơn / đóng gói / ĐVVC, KHÔNG phải
   * bằng cắt quảng cáo.
   */
  lowSuccessRate: 65,
} as const;

/** Hành động đề xuất cho một dòng. Thứ tự này cũng là thứ tự ưu tiên xử lý trên giao diện. */
export type AdsAction = "SCALE" | "HOLD" | "WATCH" | "CUT" | "FIX_DELIVERY" | "INSUFFICIENT_DATA" | "NO_SPEND_DATA";

export const ADS_ACTION_LABEL: Record<AdsAction, string> = {
  SCALE: "Tăng ngân sách",
  HOLD: "Giữ nguyên",
  WATCH: "Theo dõi",
  CUT: "Cắt",
  FIX_DELIVERY: "Sửa khâu giao",
  INSUFFICIENT_DATA: "Chưa đủ dữ liệu",
  NO_SPEND_DATA: "Không có số chi",
};

export const ADS_ACTION_HINT: Record<AdsAction, string> = {
  SCALE: `Lợi nhuận góp sau quảng cáo dương và ROAS đang cao hơn điểm hoà vốn ít nhất ${Math.round((ADS_DECISION_RULE.scaleAbove - 1) * 100)}%. Còn chỗ để tăng tiền.`,
  HOLD: "Có lãi nhưng biên mỏng: trên hoà vốn mà chưa đủ dày để tăng tiền. Giữ nguyên và tìm cách hạ giá vốn / tăng tỷ lệ giao thành công.",
  WATCH: "Đang quanh điểm hoà vốn. Chưa đáng cắt, nhưng cũng chưa kiếm được tiền — xem lại trong vài ngày tới.",
  CUT: `ROAS thấp hơn điểm hoà vốn quá ${Math.round((1 - ADS_DECISION_RULE.cutBelow) * 100)}%: càng chạy càng lỗ. Cắt hoặc làm lại từ đầu.`,
  FIX_DELIVERY: `Quảng cáo ra đơn tốt nhưng tỷ lệ giao thành công dưới ${ADS_DECISION_RULE.lowSuccessRate}%. Tiền mất ở khâu giao, không phải ở quảng cáo — cắt quảng cáo là chữa sai bệnh.`,
  INSUFFICIENT_DATA: `Chưa đủ căn cứ: cần ít nhất ${ADS_DECISION_RULE.minSpend.toLocaleString("vi-VN")}đ chi quảng cáo và ${ADS_DECISION_RULE.minFinishedOrders} đơn đã kết thúc. Kết luận lúc này là đoán.`,
  NO_SPEND_DATA: "Facebook chỉ trả số chi ở cấp CHIẾN DỊCH/ngày, nên cấp này không có tiền chi. Không có tiền thì không có ROAS, không có lợi nhuận, và do đó không có khuyến nghị về tiền.",
};

export const ADS_ACTION_TONE: Record<AdsAction, string> = {
  SCALE: "text-emerald-600 dark:text-emerald-400",
  HOLD: "text-sky-600 dark:text-sky-400",
  WATCH: "text-amber-600 dark:text-amber-400",
  CUT: "text-rose-600 dark:text-rose-400",
  FIX_DELIVERY: "text-violet-600 dark:text-violet-400",
  INSUFFICIENT_DATA: "text-muted-foreground",
  NO_SPEND_DATA: "text-muted-foreground",
};

/** Thứ tự xếp: việc cần làm ngay đứng trước, phần không kết luận được xuống cuối. */
export const ADS_ACTION_ORDER: Record<AdsAction, number> = {
  CUT: 0,
  FIX_DELIVERY: 1,
  SCALE: 2,
  WATCH: 3,
  HOLD: 4,
  INSUFFICIENT_DATA: 5,
  NO_SPEND_DATA: 6,
};

/** Cấp phân tích. `spendKnown` là thuộc tính của DỮ LIỆU, không phải lựa chọn hiển thị. */
export type AdsDimension = "campaign" | "product" | "adset" | "ad";

export const ADS_DIMENSION_LABEL: Record<AdsDimension, string> = {
  campaign: "Chiến dịch",
  product: "Mã hàng",
  adset: "Nhóm quảng cáo",
  ad: "Mẩu quảng cáo",
};

/**
 * Cấp nào CÓ số chi quảng cáo. Bảng `ad_spends` không có cột `adset_id` lẫn `ad_id` — Facebook
 * Insights được đồng bộ ở cấp chiến dịch/ngày, còn mã hàng thì ghép được từ tên chiến dịch.
 * Hai cấp còn lại chỉ có ĐƠN. Chia đều tiền chiến dịch xuống nhóm/mẩu sẽ làm tổng khớp trong khi
 * từng dòng đều sai, nên cố ý KHÔNG chia.
 */
export const ADS_DIMENSION_HAS_SPEND: Record<AdsDimension, boolean> = {
  campaign: true,
  product: true,
  adset: false,
  ad: false,
};
