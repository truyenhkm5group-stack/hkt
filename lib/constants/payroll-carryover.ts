/**
 * ═══════════ CẤU HÌNH SỔ LỖ LŨY KẾ ═══════════
 *
 * Sổ lỗ lũy kế đổi cách tính tiền của người thật, nên nó KHÔNG tự bật. Chủ shop phải khai hai
 * thứ, và cả hai đều là quyết định kinh doanh chứ không phải mặc định kỹ thuật:
 *
 *  1. **Bật hay chưa** (`enabled`). Chưa bật thì bảng lương chạy y như trước.
 *  2. **Tháng bắt đầu** (`startMonth`). Đây là mốc "mở sổ": từ tháng ấy trở đi lỗ được mang sang.
 *
 * ─── VÌ SAO PHẢI CÓ THÁNG BẮT ĐẦU, KHÔNG TỰ TÍNH NGƯỢC VỀ QUÁ KHỨ ───
 *
 * Muốn biết số dư đầu tháng 9 thì phải biết kết quả tháng 8, muốn biết tháng 8 phải biết tháng 7…
 * lùi mãi tới ngày shop mở cửa. Mà lợi nhuận của những tháng ấy được tính bằng CÔNG THỨC HÔM NAY
 * trên DỮ LIỆU HÔM NAY — không phải con số chủ shop đã dùng để trả lương lúc đó. Dựng một chuỗi
 * số dư từ đó rồi gọi nó là nghĩa vụ có thật là tự bịa ra một khoản nợ.
 *
 * Nên sổ bắt đầu ở một mốc NGƯỜI CHỌN. Số dư đầu của chính tháng ấy là 0 **theo khai báo của chủ
 * shop** (hoặc số khác nếu chủ shop khai đích danh) — một lời khẳng định có chủ, có ngày, truy
 * nguyên được; khác hẳn việc máy tự điền 0 cho mọi người rồi im lặng.
 *
 * Tháng trước mốc bắt đầu: sổ KHÔNG áp dụng, và màn hình nói thẳng là không áp dụng thay vì hiện
 * số 0 (AGENTS.md mục 42 — "chưa biết" và "không áp dụng" là hai thứ khác nhau).
 */

export const PAYROLL_CARRYOVER_KEY = "payroll.carryover";

export type PayrollCarryoverConfig = {
  /** Chưa bật ⇒ bảng lương chạy đúng như trước bản này. Mặc định TẮT. */
  enabled: boolean;
  /**
   * Tháng mở sổ, dạng `YYYY-MM`. `null` = chưa khai ⇒ coi như chưa bật, và nói rõ còn thiếu gì.
   * Số dư đầu của chính tháng này là một KHAI BÁO, không phải một phép tính.
   */
  startMonth: string | null;
  /** Vì sao chọn mốc ấy — bắt buộc có chủ và có lý do, để sáu tháng sau còn giải thích được. */
  startNote: string;
};

export const DEFAULT_PAYROLL_CARRYOVER: PayrollCarryoverConfig = {
  enabled: false,
  startMonth: null,
  startNote: "",
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(v: unknown): v is string {
  return typeof v === "string" && MONTH_RE.test(v);
}

/** Khoá tháng theo LỊCH VIỆT NAM (UTC+7) của một mốc thời gian. */
export function monthKeyOf(date: Date): string {
  const vn = new Date(date.getTime() + 7 * 3_600_000);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Tháng liền trước, vẫn theo lịch. `2027-01` ⇒ `2026-12` (không reset ở mốc năm). */
export function prevMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function compareMonthKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * MỘT KỲ BÁO CÁO CÓ PHẢI ĐÚNG MỘT THÁNG LỊCH KHÔNG.
 *
 * Sổ lỗ đi theo THÁNG. Kỳ 7 ngày, kỳ tuỳ chọn hay một quý không được tạo hay cộng lại số dư —
 * nhìn thì tiện, nhưng nó biến một chuỗi tuần tự thành một phép cộng, và phép cộng ấy làm mất
 * đúng phần lỗ mà cơ chế này sinh ra để giữ. Trả `null` ⇒ màn hình hiện "không áp dụng cho kỳ
 * này" kèm đường dẫn sang đúng tháng.
 */
export function wholeMonthKey(from: Date | null, to: Date | null): string | null {
  if (!from || !to) return null;
  const a = monthKeyOf(from);
  if (a !== monthKeyOf(to)) return null;
  const vnFrom = new Date(from.getTime() + 7 * 3_600_000);
  const vnTo = new Date(to.getTime() + 7 * 3_600_000);
  // Ngày đầu tháng và ngày cuối tháng — chặt hai đầu, nếu không "01/03..15/03" cũng lọt.
  if (vnFrom.getUTCDate() !== 1) return null;
  const cuoiThang = new Date(Date.UTC(vnTo.getUTCFullYear(), vnTo.getUTCMonth() + 1, 0)).getUTCDate();
  if (vnTo.getUTCDate() !== cuoiThang) return null;
  return a;
}

/** Tỷ lệ % ⇒ số nguyên nhân 100 (10% ⇒ 1000), để lưu mà không mất chữ số thập phân. */
export const rateToBp = (percent: number) => Math.round(Number(percent || 0) * 100);
export const bpToRate = (bp: number) => Number(bp || 0) / 100;

/**
 * KHOÁ THÀNH PHẦN CỦA HOA HỒNG MKTer TRONG SỔ LỖ.
 *
 * Từ khi có chính sách lương chung, sổ lỗ mang khoá (nhân sự, tháng, THÀNH PHẦN) — một người có
 * thể mang hai khoản cùng bù lỗ, và hai nghĩa vụ ấy là hai chuỗi số dư RIÊNG. Đường tính cũ (bốn ô
 * trên hồ sơ nhân sự) chỉ có ĐÚNG MỘT khoản bù lỗ, và nó mang khoá này — cùng giá trị với mặc định
 * của cột trong CSDL, nên mọi dòng đã ghi trước bản ấy vẫn trỏ đúng vào chuỗi số dư của chính nó.
 */
export const LEGACY_CARRY_COMPONENT = "MARKETING_PROFIT";
