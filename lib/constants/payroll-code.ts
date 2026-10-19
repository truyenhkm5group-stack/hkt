/**
 * ═══ HẰNG SỐ DÙNG CHUNG CỦA THƯỞNG THEO MÃ (Payroll V2) — an toàn cho client component ═══
 *
 * Đặc tả: `docs/payroll-code-ledger.md`.
 */

/** Khoá khoản thưởng theo mã: `${nhân sự}:CODE:${mã}:${vai trò}:${đoạn}` (`lib/payroll/code-ledger.ts`). */
export const CODE_CLAIM_MARKER = ":CODE:";
export const isCodeClaimKey = (key: string) => key.includes(CODE_CLAIM_MARKER);

/**
 * ═══ XÁC NHẬN TRỌNG SỐ CỦA MỘT MÃ TRONG MỘT THÁNG ═══
 *
 * Lối ra CÓ NGƯỜI DUYỆT cho khoản chờ loại "thiếu một phần trọng số": một SUPPORT có số đo 0 trong
 * đoạn, hoặc mã còn chi phí QC / doanh thu chưa gán cho MKTer nào. ERP không biết số 0 ấy là thật
 * (người đó nghỉ chạy cả tháng) hay là chiến dịch chưa ghép, nên nó CHỜ. Người có quyền xác nhận
 * "số đo hiện có là đủ" cho ĐÚNG một mã × một tháng, kèm lý do, qua duyệt người thứ hai — khi ấy số 0
 * là 0 thật và phần chưa gán đứng ngoài phép chia. Không ngưỡng nào ghi cứng (AGENTS.md mục 38), và
 * lời xác nhận không chạm tháng đã khoá: ảnh chụp đã mang khoản đã tính.
 *
 * Lời xác nhận KHÔNG gỡ được các khoản chờ khác (chưa có Y%, trọng số tay Σ ≠ 100%, không SUPPORT
 * nào có số đo, hai OWNER…): những thứ ấy sửa bằng phân công / điều khoản, không bằng một cú bấm.
 */
export const PAYROLL_CODE_WEIGHT_CONFIRM_KEY = "payroll.code-weight-confirmations";

export type CodeWeightConfirmation = {
  id: string;
  monthKey: string;
  productId: string;
  reason: string;
  confirmedById: string | null;
  confirmedByEmail: string;
  confirmedAt: string;
};
