import type { DepartmentCode } from "@/lib/constants/departments";

/**
 * Hằng số hiển thị của BSC — tách khỏi `lib/queries/bsc.ts` vì cùng lý do với `lib/constants/okr.ts`:
 * client component không được kéo theo `getDb`.
 */

export const BSC_PERSPECTIVES = ["FINANCIAL", "CUSTOMER", "INTERNAL_PROCESS", "LEARNING_GROWTH"] as const;
export type BscPerspective = (typeof BSC_PERSPECTIVES)[number];

export const BSC_PERSPECTIVE_LABEL: Record<BscPerspective, string> = {
  FINANCIAL: "Tài chính",
  CUSTOMER: "Khách hàng",
  INTERNAL_PROCESS: "Quy trình nội bộ",
  LEARNING_GROWTH: "Học hỏi & phát triển",
};

export const BSC_PERSPECTIVE_HINT: Record<BscPerspective, string> = {
  FINANCIAL: "Tiền: doanh thu giao thành công, lợi nhuận góp, chi phí",
  CUSTOMER: "Khách nhận được gì: giao thành công, chất lượng phục vụ, giữ khách",
  INTERNAL_PROCESS: "Việc chạy ra sao: SLA, tồn đọng, độ chính xác",
  LEARNING_GROWTH: "Người và năng lực: đào tạo, thử nghiệm, cải tiến",
};

export const BSC_PERSPECTIVE_TONE: Record<BscPerspective, string> = {
  FINANCIAL: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  CUSTOMER: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  INTERNAL_PROCESS: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  LEARNING_GROWTH: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
};

/**
 * GỢI Ý khởi động cho từng phòng — KHÔNG phải chân lý, KHÔNG được dùng ngầm.
 *
 * Chỉ số `MANUAL` xuất hiện nhiều ở `LEARNING_GROWTH` một cách cố ý: ERP không đo được số buổi đào
 * tạo hay số thử nghiệm đã chạy. Viết một truy vấn gần đúng cho chúng là bịa; để `MANUAL` là nói
 * thật rằng con số đó do người khai.
 */
export const DEFAULT_TEMPLATES: Record<DepartmentCode, { perspective: BscPerspective; label: string; metricSource: string; weight: number }[]> = {
  MARKETING: [
    { perspective: "FINANCIAL", label: "Lợi nhuận sau quảng cáo", metricSource: "profit_after_ads", weight: 2 },
    { perspective: "FINANCIAL", label: "Chi quảng cáo", metricSource: "ads_spend", weight: 1 },
    { perspective: "CUSTOMER", label: "Đơn giao thành công từ quảng cáo", metricSource: "delivered_orders", weight: 1 },
    { perspective: "INTERNAL_PROCESS", label: "Việc quảng cáo quá hạn", metricSource: "work_overdue", weight: 1 },
    { perspective: "LEARNING_GROWTH", label: "Số thử nghiệm đã chạy trong kỳ", metricSource: "MANUAL", weight: 1 },
  ],
  SALES: [
    { perspective: "FINANCIAL", label: "Doanh thu giao thành công", metricSource: "delivered_revenue", weight: 2 },
    { perspective: "CUSTOMER", label: "Tỷ lệ giao thành công", metricSource: "delivery_success_rate", weight: 2 },
    { perspective: "INTERNAL_PROCESS", label: "Việc CSKH trong hạn", metricSource: "work_sla_on_time", weight: 2 },
    { perspective: "INTERNAL_PROCESS", label: "Case chưa ai nhận", metricSource: "work_unassigned", weight: 1 },
    { perspective: "LEARNING_GROWTH", label: "Buổi đào tạo / coaching trong kỳ", metricSource: "MANUAL", weight: 1 },
  ],
  LOGISTICS: [
    { perspective: "CUSTOMER", label: "Tỷ lệ giao thành công", metricSource: "delivery_success_rate", weight: 3 },
    { perspective: "CUSTOMER", label: "Tỷ lệ hoàn", metricSource: "return_rate", weight: 2 },
    { perspective: "INTERNAL_PROCESS", label: "Care vận đơn trong hạn", metricSource: "work_sla_on_time", weight: 2 },
    { perspective: "FINANCIAL", label: "COD đã giao mà tiền chưa về", metricSource: "cod_outstanding", weight: 1 },
    { perspective: "LEARNING_GROWTH", label: "Cải tiến quy trình đã áp dụng", metricSource: "MANUAL", weight: 1 },
  ],
  WAREHOUSE: [
    { perspective: "INTERNAL_PROCESS", label: "Kiện hoàn chờ kiểm đếm", metricSource: "return_inspection_backlog", weight: 3 },
    { perspective: "INTERNAL_PROCESS", label: "Việc kho quá hạn", metricSource: "work_overdue", weight: 2 },
    { perspective: "FINANCIAL", label: "Lợi nhuận góp", metricSource: "delivered_contribution", weight: 1 },
    { perspective: "CUSTOMER", label: "Đơn giao thành công", metricSource: "delivered_orders", weight: 1 },
    { perspective: "LEARNING_GROWTH", label: "Độ chính xác kiểm kê (tự đo)", metricSource: "MANUAL", weight: 1 },
  ],
  FINANCE: [
    { perspective: "INTERNAL_PROCESS", label: "Dòng tiền chưa phân loại", metricSource: "unclassified_bank_txns", weight: 3 },
    { perspective: "FINANCIAL", label: "COD đã giao mà tiền chưa về", metricSource: "cod_outstanding", weight: 2 },
    { perspective: "FINANCIAL", label: "Lợi nhuận góp", metricSource: "delivered_contribution", weight: 2 },
    { perspective: "CUSTOMER", label: "Đối soát đúng hạn", metricSource: "work_sla_on_time", weight: 1 },
    { perspective: "LEARNING_GROWTH", label: "Quy trình kế toán đã chuẩn hoá", metricSource: "MANUAL", weight: 1 },
  ],
  MANAGEMENT: [
    { perspective: "FINANCIAL", label: "Lợi nhuận góp", metricSource: "delivered_contribution", weight: 3 },
    { perspective: "CUSTOMER", label: "Tỷ lệ giao thành công", metricSource: "delivery_success_rate", weight: 2 },
    { perspective: "INTERNAL_PROCESS", label: "Việc quá hạn toàn shop", metricSource: "work_overdue", weight: 2 },
    { perspective: "LEARNING_GROWTH", label: "Mục tiêu quý hoàn thành", metricSource: "MANUAL", weight: 1 },
  ],
  HR: [
    { perspective: "INTERNAL_PROCESS", label: "Việc nhân sự quá hạn", metricSource: "work_overdue", weight: 1 },
    { perspective: "LEARNING_GROWTH", label: "Số buổi đào tạo trong kỳ", metricSource: "MANUAL", weight: 2 },
    { perspective: "LEARNING_GROWTH", label: "Tỷ lệ giữ người", metricSource: "MANUAL", weight: 2 },
    { perspective: "CUSTOMER", label: "Mức hài lòng nội bộ", metricSource: "MANUAL", weight: 1 },
  ],
};
