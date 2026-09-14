/**
 * ───────────── HÌNH DẠNG BẮT BUỘC CỦA MỘT KHUYẾN NGHỊ ─────────────
 *
 * Một khuyến nghị không nói được nó dựa trên CHỈ SỐ nào, BẰNG CHỨNG nào, trong KHOẢNG THỜI GIAN nào
 * thì không phải khuyến nghị — nó là một câu bói. Kiểu dữ liệu này bắt buộc năm thứ đó có mặt, nên
 * không thể thêm một gợi ý mà bỏ trống phần giải thích.
 *
 * RANH GIỚI CỨNG: ERP KHÔNG bao giờ tự thực hiện khuyến nghị. Không đổi ngân sách quảng cáo, không
 * tạo đơn đặt sản xuất, không sửa tồn kho, không đổi trạng thái đơn hay vận đơn, không đụng COD.
 * Mọi thứ ở lớp này chỉ ĐỌC và chỉ ĐỀ XUẤT; người quyết định là chủ shop.
 */

export type RecommendationArea = "DATA" | "ADS" | "PRODUCT" | "INVENTORY" | "PURCHASING" | "OPERATIONS";

export const AREA_LABEL: Record<RecommendationArea, string> = {
  DATA: "Số liệu",
  ADS: "Quảng cáo",
  PRODUCT: "Mẫu mã",
  INVENTORY: "Tồn kho",
  PURCHASING: "Mua hàng",
  OPERATIONS: "Vận hành",
};

export const AREA_TONE: Record<RecommendationArea, string> = {
  DATA: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  ADS: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  PRODUCT: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  INVENTORY: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  PURCHASING: "bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300",
  OPERATIONS: "bg-muted text-muted-foreground",
};

/**
 * Mức tin cậy. CAO chỉ khi mọi chiều cần thiết đều có dữ liệu; thiếu chiều nào thì hạ xuống và
 * NÓI RA — giấu phần thiếu đi là cách nhanh nhất khiến chủ shop tin nhầm một gợi ý yếu.
 */
export const RECOMMENDATION_CONFIDENCE = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
} as const;

export type RecommendationConfidence = (typeof RECOMMENDATION_CONFIDENCE)[keyof typeof RECOMMENDATION_CONFIDENCE];

export const CONFIDENCE_LABEL: Record<RecommendationConfidence, string> = {
  HIGH: "Đủ căn cứ",
  MEDIUM: "Thiếu một phần dữ liệu",
  LOW: "Chỉ là dấu hiệu",
};

export type Recommendation = {
  area: RecommendationArea;
  title: string;
  /** Chỉ số nào dẫn tới kết luận này. */
  metric: string;
  /** Bằng chứng cụ thể: con số, nguồn dữ liệu. */
  evidence: string;
  /** Khoảng thời gian của bằng chứng — thiếu nó thì con số không có nghĩa. */
  timeRange: string;
  /** Tiền liên quan (đồng). 0 = không quy được ra tiền. */
  amount: number;
  reason: string;
  confidence: RecommendationConfidence;
  href: string;
};
