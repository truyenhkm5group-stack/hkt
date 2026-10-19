/**
 * ═══ DUYỆT HAI CẤP CHO THƯỞNG % LỢI NHUẬN — hằng số dùng chung (an toàn cho client) ═══
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9. Chủ shop giao 19/10/2026: "Thiết lập phê duyệt hai cấp cho
 * việc chốt thưởng lợi nhuận".
 *
 *  · CẤP 1 — KÝ XÁC NHẬN ĐỐI SOÁT: người quản trị lương xem bảng đối soát của tháng (từng dòng cơ sở ↔
 *    nguồn, khoản chưa đối soát, khoản ước tính) rồi ký, kèm lý do. Chữ ký mang DẤU VÂN TAY mọi con số
 *    đã thấy — số đổi (đơn chốt kết quả muộn, chi phí nhập thêm) ⇒ chữ ký cũ không còn áp.
 *  · CẤP 2 — DUYỆT KỲ LƯƠNG: bước `APPROVE` của kỳ, do MỘT NGƯỜI KHÁC người ký cấp 1.
 *
 * Chỉ bắt buộc khi tháng có thưởng % lợi nhuận ĐỦ ĐIỀU KIỆN > 0. Tháng không có khoản nào đủ điều kiện
 * (công ty còn lỗ lũy kế) thì lương cứng và hoa hồng thông thường chốt như cũ — không giữ lương của ai
 * vì một bảng đối soát.
 */
export const PAYROLL_PROFIT_SIGNOFF_KEY = "payroll.profit-reconciliation-signoffs";

export type ProfitReconSignoff = {
  id: string;
  monthKey: string;
  /** Dấu vân tay bảng đối soát lúc ký (`MonthReconciliation.fingerprint`). */
  fingerprint: string;
  fingerprintKey: string;
  /** Trạng thái và các khoản chưa đối soát người ký đã thấy — chép nguyên để tra. */
  status: "RECONCILED" | "UNRECONCILED";
  issues: { code: string; label: string; amount: number | null; count: number | null }[];
  reason: string;
  signedById: string | null;
  signedByEmail: string;
  signedAt: string;
  revokedAt?: string | null;
  revokedReason?: string | null;
  revokedById?: string | null;
};
