/**
 * ═══════════ LƯƠNG TỰ ĐỘNG — LỊCH, HẠN, VÀ MÁY ĐƯỢC LÀM GÌ ═══════════
 *
 * Đặc tả: `docs/payroll-autopilot.md`. Chủ shop chốt 25/09/2026:
 *   · CHỐT SỐ ngày 01 hằng tháng (kỳ lương = trọn tháng trước);
 *   · TRẢ LƯƠNG ngày 15;
 *   · khiếu nại KHÔNG chặn trả lương — trả đúng hạn theo số đã tính, phần sai sửa bằng khoản điều
 *     chỉnh ở kỳ sau;
 *   · phiếu lương gửi riêng từng người (hộp thư ERP), không vào nhóm chung.
 *
 * Tệp này là hàm THUẦN: không đọc CSDL, không đọc đồng hồ (giờ hiện tại luôn là THAM SỐ). Nhờ vậy
 * "hôm nay máy sẽ làm gì" kiểm được bằng một bài kiểm không phụ thuộc ngày chạy (AGENTS.md mục 50).
 *
 * ─── MÁY LÀM, NGƯỜI KÝ ───
 *
 * Máy tự: mở kỳ, quyết toán kỳ trước, tính, gửi phiếu, nhắc, lập lệnh chuyển, khớp tiền ra với sao
 * kê. Máy KHÔNG BAO GIỜ: duyệt, khoá, mở khoá, hay tự khai "đã trả" khi chưa có dòng sao kê. Duyệt là
 * một chữ ký; và "đã trả" không có chứng từ là đúng loại khẳng định mà AGENTS.md mục 8.7 cấm.
 */
import { vnDateKey } from "@/lib/format";

/** Ngày chốt số (01) và ngày trả lương (15) — theo lịch Việt Nam. Chủ shop chốt 25/09/2026. */
export const PAYROLL_CLOSE_DAY = 1;
export const PAYROLL_PAY_DAY = 15;
/**
 * Máy bắt đầu thử tính từ 09:00 ngày chốt, không từ 00:00: đồng bộ quảng cáo đối chiếu 30 ngày lúc
 * 04:00 và phiếu kho cuối tháng thường nhập buổi sáng. Tính lúc nửa đêm là chụp một con số mà vài
 * giờ sau đã khác.
 */
export const PAYROLL_AUTOPILOT_START_HOUR = 9;
/** Nhân viên có 48 giờ để xác nhận / khiếu nại kể từ lúc phiếu tới hộp thư. */
export const PAYSLIP_CONFIRM_WINDOW_HOURS = 48;
/** Từ ngày này, kỳ còn chưa duyệt thì mỗi ngày nhắc chủ shop một lần — còn 2 ngày tới hạn trả. */
export const PAYROLL_APPROVAL_REMIND_DAY = 13;
/** Cơ sở DUY NHẤT được chốt lương (`PAYROLL_BASIS_ELIGIBILITY`) — máy không chọn cơ sở nào khác. */
export const PAYROLL_AUTOPILOT_BASIS = "profit1" as const;

/** Công tắc bật lương tự động. Mặc định TẮT — bật là một lần chủ shop bấm, có nhật ký. */
export const PAYROLL_AUTOPILOT_KEY = "payroll.autopilot";
export type PayrollAutopilotConfig = { enabled: boolean };
export const DEFAULT_PAYROLL_AUTOPILOT: PayrollAutopilotConfig = { enabled: false };

/** Chuỗi nhật ký cho mọi việc máy làm — `audit.userEmail` (AGENTS.md mục 34: máy khác "chưa biết ai"). */
export const PAYROLL_AUTOPILOT_ACTOR = "job:payroll-autopilot";

const VN_OFFSET_MS = 7 * 3600_000;

/** Ngày/giờ theo lịch Việt Nam của một thời điểm. */
export function vnParts(now: Date): { year: number; month: number; day: number; hour: number; dateKey: string } {
  const v = new Date(now.getTime() + VN_OFFSET_MS);
  return { year: v.getUTCFullYear(), month: v.getUTCMonth() + 1, day: v.getUTCDate(), hour: v.getUTCHours(), dateKey: vnDateKey(now) };
}

export type MonthPeriod = { monthKey: string; fromKey: string; toKey: string; periodKey: string; label: string };

/** Kỳ lương của một tháng `YYYY-MM`: trọn tháng, mốc theo lịch Việt Nam. */
export function monthPeriod(monthKey: string): MonthPeriod {
  const [y, m] = monthKey.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  const fromKey = `${y}-${mm}-01`;
  const toKey = `${y}-${mm}-${String(days).padStart(2, "0")}`;
  return { monthKey, fromKey, toKey, periodKey: `${fromKey}..${toKey}`, label: `tháng ${mm}/${y}` };
}

export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Kỳ máy đang lo ở thời điểm `now`: trọn THÁNG TRƯỚC (chốt ngày 01 của tháng này). */
export function targetMonth(now: Date): string {
  const p = vnParts(now);
  return shiftMonth(`${p.year}-${String(p.month).padStart(2, "0")}`, -1);
}

/** Mốc bắt đầu được tính của kỳ `monthKey`: 09:00 ngày chốt của tháng kế tiếp (giờ VN). */
export function closeMomentOf(monthKey: string): Date {
  const next = shiftMonth(monthKey, 1);
  const hh = String(PAYROLL_AUTOPILOT_START_HOUR).padStart(2, "0");
  return new Date(`${next}-${String(PAYROLL_CLOSE_DAY).padStart(2, "0")}T${hh}:00:00+07:00`);
}

/** Ngày trả lương của kỳ `monthKey` (`YYYY-MM-DD`, lịch VN). */
export function payDayOf(monthKey: string): string {
  return `${shiftMonth(monthKey, 1)}-${String(PAYROLL_PAY_DAY).padStart(2, "0")}`;
}

/** Ngày bắt đầu nhắc duyệt của kỳ `monthKey`. */
export function approvalRemindDayOf(monthKey: string): string {
  return `${shiftMonth(monthKey, 1)}-${String(PAYROLL_APPROVAL_REMIND_DAY).padStart(2, "0")}`;
}

/**
 * ═══ TRẠNG THÁI MỘT PHIẾU LƯƠNG ĐÃ GỬI — TÍNH LÚC ĐỌC ═══
 *
 * "Hết hạn không trả lời" KHÔNG phải một giá trị ghi vào CSDL: nó là hàm của thời gian và cái hạn,
 * nên luôn đúng tới từng giây và không cần job nào đi "cập nhật trạng thái" (cùng luật với mức leo
 * thang SLA, AGENTS.md mục 26). Và nó KHÁC "đã xác nhận": im lặng không phải đồng ý — màn hình in
 * "không phản hồi", không in "đã xác nhận".
 */
export type PayslipState = "CONFIRMED" | "DISPUTED" | "PENDING" | "NO_RESPONSE" | "NOT_DELIVERED";

export const PAYSLIP_STATE_LABEL: Record<PayslipState, string> = {
  CONFIRMED: "Đã xác nhận",
  DISPUTED: "Khiếu nại",
  PENDING: "Chờ xác nhận",
  NO_RESPONSE: "Hết hạn, không phản hồi",
  NOT_DELIVERED: "Chưa gửi được (chưa nối tài khoản ERP)",
};

export function payslipState(row: { status: string; deadlineAt: Date; recipientUserId: string | null }, now: Date): PayslipState {
  if (row.status === "CONFIRMED") return "CONFIRMED";
  if (row.status === "DISPUTED") return "DISPUTED";
  if (!row.recipientUserId) return "NOT_DELIVERED";
  return now.getTime() > row.deadlineAt.getTime() ? "NO_RESPONSE" : "PENDING";
}

export type ConfirmationSummary = Record<PayslipState, number> & { total: number };

export function summarizeConfirmations(rows: readonly { status: string; deadlineAt: Date; recipientUserId: string | null }[], now: Date): ConfirmationSummary {
  const out: ConfirmationSummary = { total: rows.length, CONFIRMED: 0, DISPUTED: 0, PENDING: 0, NO_RESPONSE: 0, NOT_DELIVERED: 0 };
  for (const r of rows) out[payslipState(r, now)] += 1;
  return out;
}

/** Vòng xác nhận đã KHÉP chưa: không còn ai đang trong hạn mà chưa trả lời. */
export function confirmationsSettled(s: ConfirmationSummary): boolean {
  return s.total > 0 && s.PENDING === 0;
}

/**
 * ═══ HÔM NAY MÁY SẼ LÀM GÌ VỚI KỲ NÀY ═══
 *
 * Nhận trạng thái hiện có, trả ra danh sách VIỆC — kèm lý do đọc được cho mỗi việc KHÔNG làm. Không
 * tự làm gì cả: `lib/payroll/autopilot.ts` đọc danh sách này rồi mới đi làm, và màn hình in CHÍNH
 * danh sách này ra để chủ shop thấy máy định làm gì trước khi nó làm.
 */
export type AutopilotStep =
  | { kind: "WAIT"; why: string }
  | { kind: "SETTLE_PREVIOUS"; why: string }
  | { kind: "CALCULATE_AND_SEND"; why: string }
  | { kind: "NOTIFY_BLOCKED"; why: string }
  | { kind: "NOTIFY_READY"; why: string }
  | { kind: "REMIND_APPROVAL"; why: string }
  | { kind: "ENSURE_PAYOUT"; why: string }
  | { kind: "REMIND_PAYDAY"; why: string }
  | { kind: "HUMAN"; why: string }
  | { kind: "DONE"; why: string };

export type AutopilotInput = {
  now: Date;
  enabled: boolean;
  monthKey: string;
  /** `NONE` = chưa có bản ghi kỳ. Còn lại là sáu trạng thái của vòng đời (FINAL cũ đã quy về LOCKED). */
  status: "NONE" | "DRAFT" | "CALCULATED" | "UNDER_REVIEW" | "APPROVED" | "LOCKED" | "PAID";
  /** Việc còn chặn tính (`payrollFinalizeBlockers`). `null` = chưa đánh giá (máy chưa thử tính). */
  blockers: readonly string[] | null;
  confirmations: ConfirmationSummary | null;
  payout: { lines: number; pending: number; paid: number } | null;
  /** Kỳ trước đã khoá và có ảnh chụp để quyết toán không. */
  previousFrozen: boolean;
};

export function planAutopilot(input: AutopilotInput): AutopilotStep[] {
  const { now, monthKey } = input;
  const today = vnDateKey(now);
  if (!input.enabled) return [{ kind: "WAIT", why: "Lương tự động đang TẮT — mọi bước làm bằng tay ở tab Lịch sử kỳ." }];
  if (now < closeMomentOf(monthKey)) {
    return [{ kind: "WAIT", why: `Chưa tới giờ chốt (09:00 ngày ${String(PAYROLL_CLOSE_DAY).padStart(2, "0")}).` }];
  }
  const steps: AutopilotStep[] = [];
  switch (input.status) {
    case "NONE":
    case "DRAFT": {
      if (input.previousFrozen) steps.push({ kind: "SETTLE_PREVIOUS", why: "Kỳ trước đã khoá: quyết toán phần đơn có kết cục sau ngày chốt, đưa vào kỳ này." });
      if (input.blockers && input.blockers.length) {
        steps.push({ kind: "NOTIFY_BLOCKED", why: `Còn ${input.blockers.length} việc chặn tính kỳ — máy thử lại mỗi giờ, báo chủ shop mỗi ngày một lần.` });
      } else {
        steps.push({ kind: "CALCULATE_AND_SEND", why: "Tính & chụp ảnh kỳ, rồi gửi phiếu lương vào hộp thư từng người." });
      }
      return steps;
    }
    case "CALCULATED":
      return [{ kind: "HUMAN", why: "Kỳ đã được tính lại bằng tay sau khi bị trả về — người sửa bấm “Gửi phiếu cho nhân viên” khi xong. Máy không gửi thay, vì không biết người sửa đã xong chưa." }];
    case "UNDER_REVIEW":
    case "APPROVED": {
      if (input.confirmations && confirmationsSettled(input.confirmations)) {
        steps.push({ kind: "NOTIFY_READY", why: "Mọi người đã trả lời hoặc hết hạn — báo chủ shop duyệt." });
      } else {
        steps.push({ kind: "WAIT", why: "Đang chờ nhân viên xác nhận (hạn 48 giờ)." });
      }
      if (today >= approvalRemindDayOf(monthKey)) steps.push({ kind: "REMIND_APPROVAL", why: `Đã tới ngày ${PAYROLL_APPROVAL_REMIND_DAY} mà kỳ chưa duyệt — nhắc mỗi ngày một lần.` });
      return steps;
    }
    case "LOCKED": {
      steps.push({ kind: "ENSURE_PAYOUT", why: "Kỳ đã khoá: lập / cập nhật lệnh chuyển, khớp tiền ra với sao kê." });
      if (input.payout && input.payout.pending > 0 && today >= payDayOf(monthKey)) {
        steps.push({ kind: "REMIND_PAYDAY", why: `Hôm nay là ngày trả lương (hoặc đã quá): còn ${input.payout.pending} người chưa thấy tiền ra trong sổ ngân hàng.` });
      }
      return steps;
    }
    case "PAID":
      return [{ kind: "DONE", why: "Kỳ đã trả xong — mọi dòng lệnh chuyển đều khớp một dòng sao kê." }];
  }
}
