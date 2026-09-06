/** P0.1: chưa được dùng để tính ORDER_OUTCOME hoặc KPI production. */
export const PAYMENT_TYPES = ["COD_RECEIVED", "PREPAID", "BANK_TRANSFER", "REFUND", "ADJUSTMENT", "REVERSAL"] as const;
export const PAYMENT_DIRECTIONS = ["INFLOW", "OUTFLOW"] as const;
export const PAYMENT_VERIFICATION_STATUSES = ["PENDING", "VERIFIED", "REJECTED", "DISPUTED"] as const;
export const PAYMENT_REVIEW_COVERAGE = ["PARTIAL", "COMPLETE", "DISPUTED"] as const;
// Đây là loại chứng từ được phép xét duyệt, không phải tự động tin mọi dữ liệu mang tên nguồn này.
export const PAYMENT_EVIDENCE_SOURCES = ["BANK_STATEMENT", "VTP_COD_STATEMENT", "MANUAL_DOCUMENT"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];
export type PaymentCoverage = (typeof PAYMENT_REVIEW_COVERAGE)[number];
export type PaymentEvidenceSource = (typeof PAYMENT_EVIDENCE_SOURCES)[number];
