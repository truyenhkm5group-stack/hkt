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
 *
 * ─── XÁC NHẬN ĐÚNG THỨ ĐÃ XEM, KHÔNG PHẢI CẢ THÁNG ───
 *
 * Mỗi lời xác nhận mang DẤU VÂN TAY số đo của từng đoạn đang chờ lúc bấm (`weightFingerprint`: ai là
 * SUPPORT, trọng số đo được của từng người, phần chưa gán). Nó chỉ có hiệu lực khi số đo HIỆN TẠI
 * khớp đúng dấu ấy: thêm SUPPORT, ghép muộn một chiến dịch, hay có thêm tiền chưa gán ⇒ khoản quay
 * lại chờ với câu "số đo đã đổi". Không xác nhận trước được: phải có khoản chờ đang tồn tại.
 * Duyệt người thứ hai chỉ bắt buộc khi nhóm `PAYROLL_EDIT` bật cưỡng chế (như mọi đường ghi lương).
 */
export const PAYROLL_CODE_WEIGHT_CONFIRM_KEY = "payroll.code-weight-confirmations";

export type CodeWeightConfirmation = {
  /** Khoá BẢN GHI (nội dung + mốc ghi) — nhật ký xác nhận và huỷ cùng dùng khoá này. */
  id: string;
  /** Khoá NỘI DUNG (tháng · mã · dấu vân tay) — khớp với lời duyệt người thứ hai. */
  contentId?: string;
  monthKey: string;
  productId: string;
  /** Dấu vân tay số đo của các đoạn đã được xem lúc xác nhận. */
  fingerprints: string[];
  reason: string;
  /** Người GỬI yêu cầu xác nhận và người DUYỆT — hai khoá tài khoản, hai thư (AGENTS.md mục 34). */
  requestedById: string | null;
  requestedByEmail: string;
  approvedById: string | null;
  approvedByEmail: string;
  confirmedAt: string;
  /** Đã huỷ (có duyệt) — giữ lại để tra, không còn hiệu lực. */
  revokedAt?: string | null;
  revokedReason?: string | null;
  revokedById?: string | null;
  revokedByEmail?: string | null;
  revokeApprovedById?: string | null;
  revokeApprovedByEmail?: string | null;
};
