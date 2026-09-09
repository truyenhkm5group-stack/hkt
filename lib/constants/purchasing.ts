/**
 * Ngưỡng của phần Mua hàng & xưởng. Đổi ở ĐÂY, không rải số vào truy vấn hay giao diện.
 * Mọi ngưỡng đều là quy ước kinh doanh — chỉ đổi khi chủ shop yêu cầu.
 */
/** Nhãn dùng khi phiếu nhập / đơn sản xuất không ghi tên xưởng. CHƯA BIẾT, không phải một xưởng tên rỗng. */
export const UNKNOWN_SUPPLIER = "(chưa ghi xưởng)";

export const PURCHASING_RULE = {
  /** Giá nhập tăng từ mức này (%) so với LẦN NHẬP TRƯỚC của cùng mẫu mã thì nêu ra. */
  priceJumpPercent: 10,
  /**
   * Khoảng cách tối đa (ngày) giữa lúc gửi xưởng và lúc lập phiếu nhập để coi hai việc là MỘT lô.
   * Xa hơn khoảng này thì gần như chắc chắn là lô khác — ghép vào sẽ tạo ra thời gian giao bịa.
   */
  maxLeadDays: 180,
  /**
   * Độ phủ ghép tối thiểu (%) để được XẾP HẠNG xưởng theo thời gian giao. Dưới mức này thì con số
   * vẫn hiện nhưng kèm cảnh báo, vì so sánh trên vài lô lẻ là so sánh nhiễu.
   */
  minLeadCoveragePercent: 50,
  /** Số lô tối thiểu của một xưởng để thời gian giao của xưởng đó có nghĩa. */
  minLeadSamples: 3,
  /** Cửa sổ mặc định khi xem trang (ngày). */
  defaultWindowDays: 90,
  /** Các cửa sổ cho phép chọn trên URL. */
  windowChoices: [30, 90, 180, 365],
} as const;
