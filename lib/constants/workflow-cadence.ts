/**
 * ═══════════ NHỊP TỰ CHẠY LUẬT CỦA TỔ CHỨC KHÁCH (G-SCHED) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Quyết định của chủ nền tảng 29/09/2026, nguyên văn: «G-SCHED: Có. Cho automation của tenant khách chạy mỗi 10 phút
 * mặc định, tenant-isolated + rate limit; lịch VNX giữ nguyên. Sau này cho phép cấu hình cadence theo plan.»
 *
 * MỘT CHỖ KHAI NHỊP. Mọi nơi nói "mấy phút một lượt" — job `workflows` (`lib/workflow/scheduled.ts`), màn hình luật của
 * tổ chức khách, tài liệu vận hành — đọc từ đây; bộ lập lịch (JavaScript thuần) giữ bản sao nhịp GÕ
 * (`WORKFLOW_FANOUT_TICK_MINUTES` trong `scripts/scheduler-fanout.mjs`) và bài kiểm `tests/g-sched.test.ts` đòi nó BẰNG
 * `WORKFLOW_CADENCE_MIN_MINUTES`: bộ lập lịch gõ ở nhịp nhỏ nhất được phép, job tự quyết lượt này đã tới kỳ chưa.
 *
 *  · Mặc định 10 phút. Gói (`platform_plans.limits.workflowCadenceMinutes`) được đặt nhịp khác; KHÔNG có màn hình sửa
 *    (để sau, theo lời chủ) — người vận hành sửa dòng gói.
 *  · Nhịp < 5 phút bị TỪ CHỐI (không kẹp về 5): một con số sai trong dòng gói là lỗi cấu hình, và lỗi cấu hình phải hiện
 *    ra ở `sync_runs` chứ không lặng lẽ thành một con số khác. Bị từ chối ⇒ dùng mặc định và nói ra vì sao.
 *  · Tổ chức NHÀ không đi đường này: luật của nhà vẫn chạy ké job `alerts` (lịch VNX giữ nguyên, `ALERTS_EVERY_MINUTES`).
 */

/** Nhịp mặc định của tổ chức khách (phút). */
export const WORKFLOW_CADENCE_DEFAULT_MINUTES = 10;
/** Nhịp nhỏ nhất được nhận — nhỏ hơn bị từ chối. Cũng là nhịp gõ của bộ lập lịch. */
export const WORKFLOW_CADENCE_MIN_MINUTES = 5;
/** Nhịp lớn nhất được nhận (một ngày) — lớn hơn gần như chắc chắn là gõ nhầm đơn vị. */
export const WORKFLOW_CADENCE_MAX_MINUTES = 1440;
/** Khoá trong `platform_plans.limits`. */
export const WORKFLOW_CADENCE_PLAN_KEY = "workflowCadenceMinutes";
/**
 * Trần thời gian MỖI tổ chức MỖI lượt (mili-giây). Bộ máy dừng TRƯỚC sự kiện chưa xét khi quá trần — con trỏ không
 * nhảy qua, lượt sau xét tiếp (cùng cơ chế với trần hành động `ACTION_BUDGET`). Trần sự kiện / hành động mỗi lượt là
 * trần sẵn có của bộ máy (`EVENT_BATCH` 200 · `ACTION_BUDGET` 50), không khai lại ở đây.
 */
export const WORKFLOW_ORG_TIME_BUDGET_MS = 60_000;

export type WorkflowCadence = {
  minutes: number;
  source: "DEFAULT" | "PLAN";
  /** Giá trị trong gói bị từ chối — giá trị thô + lý do, để in ra `sync_runs`. */
  rejected?: { value: string; reason: string };
};

/** Đọc nhịp từ `limits` của gói. Thiếu ⇒ mặc định; sai ⇒ mặc định + lý do từ chối. */
export function parseWorkflowCadence(limits: unknown): WorkflowCadence {
  const obj = limits && typeof limits === "object" && !Array.isArray(limits) ? (limits as Record<string, unknown>) : {};
  const raw = obj[WORKFLOW_CADENCE_PLAN_KEY];
  if (raw === undefined || raw === null) return { minutes: WORKFLOW_CADENCE_DEFAULT_MINUTES, source: "DEFAULT" };
  const fallback = (reason: string): WorkflowCadence => ({ minutes: WORKFLOW_CADENCE_DEFAULT_MINUTES, source: "DEFAULT", rejected: { value: JSON.stringify(raw).slice(0, 40), reason } });
  if (typeof raw !== "number" || !Number.isInteger(raw)) return fallback("không phải số phút nguyên");
  if (raw < WORKFLOW_CADENCE_MIN_MINUTES) return fallback(`nhỏ hơn ${WORKFLOW_CADENCE_MIN_MINUTES} phút — bị từ chối`);
  if (raw > WORKFLOW_CADENCE_MAX_MINUTES) return fallback(`lớn hơn ${WORKFLOW_CADENCE_MAX_MINUTES} phút — bị từ chối`);
  return { minutes: raw, source: "PLAN" };
}

/**
 * Lượt gõ lúc `now` có phải lượt chạy không — theo Ô NHỊP cố định trên đồng hồ (ô thứ k = [k·nhịp, (k+1)·nhịp) tính từ
 * mốc 0 Unix): chạy khi ô hiện tại MỚI HƠN ô của lượt chạy gần nhất. Không so "đã đủ N phút chưa": lượt gõ nổ lệch vài
 * mili-giây thì phép so ấy trượt nguyên một nhịp gõ (9:59,9 < 10 phút ⇒ chờ thêm 5 phút). Chưa chạy lần nào ⇒ chạy.
 */
export function workflowRunDue(input: { now: number; lastStartedAt: number | null; cadenceMinutes: number }): boolean {
  if (input.lastStartedAt === null) return true;
  const o = input.cadenceMinutes * 60_000;
  return Math.floor(input.now / o) > Math.floor(input.lastStartedAt / o);
}

/** Luật của tổ chức này có chạy ké job `alerts` không — CHỈ tổ chức nhà (lịch VNX giữ nguyên). Khách đi job `workflows`. */
export function alertsCarriesWorkflows(org: { isHome: boolean }): boolean {
  return org.isHome;
}

/** Câu nói nhịp cho màn hình luật — một câu dựng ở một chỗ. */
export function workflowScheduleSentence(org: { isHome: boolean }, cadence: Pick<WorkflowCadence, "minutes">): string {
  if (alertsCarriesWorkflows(org)) return "Máy kiểm luật mỗi lượt của job cảnh báo (10 phút / lượt, lịch của tổ chức nhà).";
  return `Máy tự kiểm luật của tổ chức mỗi ${cadence.minutes} phút / lượt (lịch riêng của tổ chức, mỗi lượt tối đa ${WORKFLOW_ORG_TIME_BUDGET_MS / 1000} giây). Người vận hành nền tảng tạm dừng được bằng công tắc khẩn.`;
}
