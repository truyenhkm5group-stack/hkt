/**
 * ───────────── NGƯỠNG PHÁT HIỆN QUẢNG CÁO BẤT THƯỜNG ─────────────
 *
 * Một chỗ duy nhất giữ toàn bộ ngưỡng. Đây là NGƯỠNG MỚI, không phải sửa ngưỡng nghiệp vụ đã chốt:
 * chúng chỉ quyết định KHI NÀO ERP lên tiếng, không đụng tới bất kỳ công thức tiền hay kết quả đơn
 * nào. Chủ shop nên xem lại các con số này sau vài tuần chạy thật và chỉnh cho khớp với quy mô shop.
 *
 * Nguyên tắc chọn ngưỡng: thà bỏ sót còn hơn báo bừa. Một hàng đợi đầy cảnh báo sai sẽ bị bỏ qua
 * toàn bộ, kể cả cảnh báo đúng.
 */

export const ADS_ANOMALY_RULES = {
  /** Cửa sổ so sánh: 7 ngày gần đây so với 7 ngày liền trước. */
  windowDays: 7,
  /**
   * Chi tiêu tăng từ mức này trở lên mới xét. Dưới đó là dao động bình thường của việc bật/tắt
   * quảng cáo hằng ngày.
   */
  spendSurgePct: 50,
  /**
   * Chi tăng mạnh mà doanh thu GIAO THÀNH CÔNG tăng dưới mức này ⇒ tiền đang chảy ra mà hàng không
   * ra theo. Đây là bất thường đắt nhất trong nhóm.
   */
  revenueLagPct: 10,
  /** Tỷ lệ giao thành công tụt từng này điểm phần trăm so với kỳ trước ⇒ cảnh báo. */
  successDropPoints: 15,
  /** ROAS giao thành công dưới mức này ⇒ cảnh báo. 1,0 = doanh thu giao được vừa đúng bằng tiền quảng cáo. */
  minDeliveredRoas: 1,
  /** Chỉ xét chiến dịch đã tiêu từ mức này trở lên — chiến dịch tiêu vài chục nghìn không đáng làm ồn. */
  minSpendToJudge: 500_000,
  /** Chi tiêu trong kỳ mà tỷ lệ đơn quy kết được dưới mức này ⇒ quy kết đang hỏng. */
  minAttributionPct: 20,
  /**
   * ĐỘ PHỦ QUY KẾT TỐI THIỂU ĐỂ DÁM KẾT LUẬN VỀ LỢI NHUẬN CHIẾN DỊCH.
   *
   * Lý do tồn tại, phát hiện trên dữ liệu thật: chi tiêu quảng cáo được đếm ĐỦ 100%, nhưng doanh
   * thu chỉ quy về được cho những đơn CÓ mã quảng cáo. Production đang ở mức ~46%, nghĩa là hơn một
   * nửa doanh thu do quảng cáo mang lại không được cộng vào chiến dịch nào.
   *
   * Lấy chi tiêu đủ trừ đi doanh thu thiếu rồi kết luận "chiến dịch đang lỗ" là so hai vế không
   * cùng gốc — và nó sẽ báo lỗ cho gần như MỌI chiến dịch. Với 46% độ phủ, câu trả lời trung thực
   * không phải "đang lỗ" mà là "CHƯA KẾT LUẬN ĐƯỢC".
   *
   * CỐ Ý KHÔNG suy rộng doanh thu theo tỷ lệ độ phủ: đó là bịa quy kết, đúng thứ đặc tả cấm.
   */
  minAttributionToJudgeProfit: 80,
  /** Không thấy dòng chi tiêu Facebook mới nào quá số ngày này ⇒ đồng bộ có thể đã chết. */
  staleSpendDays: 2,
} as const;

export type AdsAnomalyKind = "SPEND_SURGE_NO_REVENUE" | "SUCCESS_RATE_DROP" | "LOW_DELIVERED_ROAS" | "ATTRIBUTION_LOST" | "SPEND_SYNC_STALE" | "CAMPAIGN_LOSING_MONEY";

export const ADS_ANOMALY_LABEL: Record<AdsAnomalyKind, string> = {
  SPEND_SURGE_NO_REVENUE: "Chi tăng mạnh mà hàng không ra theo",
  SUCCESS_RATE_DROP: "Tỷ lệ giao thành công tụt",
  LOW_DELIVERED_ROAS: "ROAS giao thành công dưới ngưỡng",
  ATTRIBUTION_LOST: "Mất dấu quy kết đơn",
  SPEND_SYNC_STALE: "Đồng bộ chi tiêu Facebook đứng im",
  CAMPAIGN_LOSING_MONEY: "Chiến dịch càng chạy càng lỗ",
};

/**
 * Loại nào là cảnh báo LỢI NHUẬN (mức kinh doanh) chứ không phải trục trặc quảng cáo (mức vận hành).
 * Hai nhóm này đi vào hai loại việc khác nhau trong hàng đợi vì người xử lý khác nhau.
 */
export const PROFITABILITY_KINDS: AdsAnomalyKind[] = ["CAMPAIGN_LOSING_MONEY", "LOW_DELIVERED_ROAS"];
