/**
 * ═══════════ NHÂN SỰ CÓ MẶT TRONG KỲ NÀO — MỘT LUẬT, HAI NƠI DÙNG ═══════════
 *
 * ─── LỖI MÀ TỆP NÀY SINH RA ĐỂ SỬA ───
 *
 * Hồ sơ nhân sự chỉ có một ô "Đang làm việc". Bỏ tick là người ấy biến mất khỏi MỌI kỳ lương — kể
 * cả tháng họ còn đang làm dở. Nghỉ ngày 20/09 mà chủ shop bỏ tick ngày 21/09 thì bảng lương tháng 9
 * (chốt ngày 01/10) không có dòng nào của họ: hai mươi ngày công không ai trả, và không màn hình nào
 * báo thiếu.
 *
 * Nay "đã nghỉ" đi kèm NGÀY NGHỈ. Người ấy vẫn có mặt ở mọi kỳ chạm tới những ngày họ còn làm, và
 * lương cứng chia theo ĐÚNG số ngày ấy — cùng hàm chia theo ngày mà mọi khoản chi theo thời gian dùng
 * (`prorateMonthlyAmount`, AGENTS.md mục 14 · 16).
 *
 * ─── TƯƠNG THÍCH NGƯỢC: HỒ SƠ CŨ KHÔNG ĐỔI MỘT ĐỒNG NÀO ───
 *
 * Hồ sơ không khai ngày nào thì hành vi y như trước: `active` quyết định có mặt hay không, và lương
 * cứng chia theo cả kỳ. Không backfill ngày vào / ngày nghỉ cho ai — đoán ngày làm việc của một
 * người là đoán tiền của họ (AGENTS.md mục 35).
 *
 * `lib/queries/payroll.ts` (bảng lương) và `lib/queries/payroll-cost.ts` (chi phí nhân sự của báo
 * cáo lợi nhuận) cùng gọi hàm này. Hai nơi tự viết hai mệnh đề là hai con số khác nhau cho cùng một
 * khoản lương.
 */
import { vnEndOfDay, vnStartOfDay } from "@/lib/format";

/** Phần hồ sơ mà luật này cần — cố ý hẹp để hàm thuần không kéo theo cả kiểu `Employee`. */
export type EmploymentFields = {
  active: boolean;
  /** `YYYY-MM-DD` giờ Việt Nam. Rỗng/thiếu = không khai (không phải "làm từ thuở nào"). */
  startedOn?: string;
  /** `YYYY-MM-DD` giờ Việt Nam — NGÀY LÀM CUỐI CÙNG, tính cả ngày đó. */
  leftOn?: string;
};

export type EmploymentWindow =
  | { included: false; reason: string }
  | {
      included: true;
      /** Mốc đầu/cuối của phần kỳ mà người này thật sự làm — dùng để chia lương cứng. */
      from: Date | null;
      to: Date | null;
      /** Có bị cắt bởi ngày vào / ngày nghỉ không — để màn hình nói ra "chỉ tính N ngày". */
      clipped: boolean;
    };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(v: string | undefined | null): v is string {
  return typeof v === "string" && DATE_RE.test(v);
}

/**
 * Người này có mặt trong kỳ `[from, to]` không, và nếu có thì phần nào của kỳ.
 *
 * Hàm THUẦN: không đọc CSDL, không đọc đồng hồ. `from`/`to` null (kỳ "Toàn bộ") thì chỉ xét cờ.
 */
export function employmentWindow(e: EmploymentFields, from: Date | null, to: Date | null): EmploymentWindow {
  const started = isDateKey(e.startedOn) ? vnStartOfDay(e.startedOn) : null;
  const left = isDateKey(e.leftOn) ? vnEndOfDay(e.leftOn) : null;

  // Không khai ngày nào ⇒ luật cũ, nguyên vẹn.
  if (!started && !left) {
    return e.active ? { included: true, from, to, clipped: false } : { included: false, reason: "Đã tắt “Đang làm việc” mà không khai ngày nghỉ." };
  }
  // Có ngày nghỉ thì NGÀY quyết định, không phải cờ: cờ bị tắt vẫn phải trả những ngày còn làm.
  if (!left && !e.active) return { included: false, reason: "Đã tắt “Đang làm việc” mà không khai ngày nghỉ." };
  if (left && from && left < from) return { included: false, reason: `Nghỉ từ trước kỳ (ngày làm cuối ${e.leftOn}).` };
  if (started && to && started > to) return { included: false, reason: `Bắt đầu làm sau kỳ (${e.startedOn}).` };

  const winFrom = started && (!from || started > from) ? started : from;
  const winTo = left && (!to || left < to) ? left : to;
  return { included: true, from: winFrom, to: winTo, clipped: winFrom !== from || winTo !== to };
}

/** Nhãn tình trạng đọc được — dùng chung cho bảng nhân sự và phiếu lương. */
export function employmentStatusLabel(e: EmploymentFields, today: string): string {
  if (isDateKey(e.leftOn)) return e.leftOn < today ? `Đã nghỉ (làm tới ${e.leftOn})` : `Nghỉ từ sau ${e.leftOn}`;
  return e.active ? "Đang làm" : "Đã tắt (không khai ngày nghỉ)";
}
