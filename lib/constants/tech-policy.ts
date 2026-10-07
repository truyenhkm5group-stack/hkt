/**
 * ═══════════ CHÍNH SÁCH RỦI RO R0–R4 + NGÂN SÁCH (Pha 4) ═══════════
 *
 * docs/tech-control-plane/README.md mục 11. Tệp THUẦN, CLIENT-SAFE. MỘT chỗ cho chính sách — không rải trong prompt.
 *
 * Thang R0–R4 DẪN XUẤT từ máy xếp rủi ro đã có (`classifyTechRisk`, R0–R2 + luật đã khớp) cộng loại việc và từ khoá
 * nguy hiểm. Nó không thay thang R0–R2 (cổng duyệt deploy vẫn đọc `risk`), nó trả lời câu hỏi khác: "máy được tự
 * làm tới đâu".
 *
 *   R0  tài liệu · kiểm thử · thay đổi nhỏ cô lập          → worker tự làm, PR + cổng + người duyệt
 *   R1  sửa mã thường qua PR + cổng                        → worker tự làm, PR + cổng + người duyệt
 *   R2  vận hành hoàn tác được (staging, hạ tầng, deploy)   → KHÔNG tự động — Delivery Controller
 *   R3  chạm sự thật kinh doanh / production có chính sách → KHÔNG tự động; chủ shop duyệt trước deploy
 *   R4  CẦN CHỦ SHOP: xoá dữ liệu production, secret, DNS, xác thực/quyền, thanh toán, chi lớn, không hoàn tác,
 *       tắt bảo vệ, lách CI / branch protection             → không ai làm trước khi chủ shop quyết
 */
import type { TechRisk, TechTaskType } from "@/lib/constants/tech";

export const TECH_POLICY_LEVELS = ["R0", "R1", "R2", "R3", "R4"] as const;
export type TechPolicyLevel = (typeof TECH_POLICY_LEVELS)[number];

export const TECH_POLICY_LABEL: Record<TechPolicyLevel, string> = {
  R0: "R0 · Tài liệu / kiểm thử — máy tự làm",
  R1: "R1 · Mã thường qua PR — máy tự làm",
  R2: "R2 · Vận hành hoàn tác được — không tự động",
  R3: "R3 · Chạm sự thật kinh doanh — chủ shop duyệt",
  R4: "R4 · Cần chủ shop quyết trước",
};

/** Mức máy được TỰ nhận làm (worker hàng đợi, giao agent). */
export const TECH_AUTONOMOUS_POLICY: readonly TechPolicyLevel[] = ["R0", "R1"];

/** Luật của máy xếp rủi ro mà chạm vào là R4 — danh sách đóng, khớp khoá trong `TECH_RISK_RULES`. */
export const OWNER_ONLY_RISK_RULES = ["SECRETS", "ACCESS", "DATA_FIX", "SCHEDULER"] as const;

/** Loại việc luôn R4. */
const OWNER_ONLY_TASK_TYPES: readonly TechTaskType[] = ["SECURITY", "DATA_FIX"];

/**
 * Từ khoá (không dấu, thường) đẩy thẳng lên R4 — những việc chủ shop đã kê đích danh. Chỉ để NÂNG, không bao giờ hạ.
 */
export const OWNER_ONLY_KEYWORDS = [
  "drop table",
  "truncate",
  "delete from",
  "xoa du lieu",
  "xoa production",
  "dns",
  "ten mien",
  "thanh toan",
  "payment",
  "billing",
  "branch protection",
  "ruleset",
  "bypass",
  "bo qua cong",
  "tat bao ve",
  "disable security",
  "credential",
  "mat khau",
  "oauth",
] as const;

function khongDau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export type PolicyInput = { risk: TechRisk; riskRules: readonly string[]; taskType: string; capability?: string; title: string; description?: string };
export type PolicyVerdict = { level: TechPolicyLevel; reasons: string[] };

/** Mức chính sách của một việc — hàm thuần, chỉ NÂNG theo từng chứng cứ, kèm lý do đọc được. */
export function classifyTechPolicy(input: PolicyInput): PolicyVerdict {
  const reasons: string[] = [];
  let level: TechPolicyLevel = input.risk === "R0" ? "R0" : input.risk === "R1" ? "R1" : "R3";
  if (input.risk === "R2") reasons.push("Máy xếp rủi ro R2 (chạm sự thật kinh doanh) ⇒ R3");
  const nang = (to: TechPolicyLevel, why: string) => {
    if (TECH_POLICY_LEVELS.indexOf(to) > TECH_POLICY_LEVELS.indexOf(level)) level = to;
    reasons.push(why);
  };
  if (input.riskRules.includes("INFRA") || input.capability === "deploy-production" || input.taskType === "INFRA") nang("R2", "Hạ tầng / deploy ⇒ R2 (không tự động)");
  if (input.riskRules.includes("MIGRATION") || input.taskType === "MIGRATION") nang("R3", "Migration CSDL ⇒ R3");
  for (const r of OWNER_ONLY_RISK_RULES) if (input.riskRules.includes(r)) nang("R4", `Luật ${r} ⇒ R4 (cần chủ shop)`);
  if (OWNER_ONLY_TASK_TYPES.includes(input.taskType as TechTaskType)) nang("R4", `Loại việc ${input.taskType} ⇒ R4`);
  const text = khongDau(`${input.title} ${input.description ?? ""}`);
  for (const k of OWNER_ONLY_KEYWORDS) if (text.includes(k)) nang("R4", `Nhắc “${k}” ⇒ R4`);
  if (!reasons.length) reasons.push(level === "R0" ? "Tài liệu / kiểm thử / thay đổi ít rủi ro" : "Sửa mã thường, qua PR + cổng");
  return { level, reasons: [...new Set(reasons)] };
}

/** R3 và R4 phải có NGƯỜI duyệt (cùng cổng `approval_required` đã có). */
export function policyRequiresApproval(level: TechPolicyLevel): boolean {
  return level === "R3" || level === "R4";
}

/* ═════════════════════ NGÂN SÁCH ═════════════════════ */

export const TECH_BUDGET_SCOPES = ["COMPANY", "PROJECT", "GOAL", "MISSION"] as const;
export type TechBudgetScope = (typeof TECH_BUDGET_SCOPES)[number];

/** Mỗi ô `null` = CHƯA KHAI (không phải 0). Ô hẹp hơn đè ô rộng hơn, TỪNG Ô một. */
export type TechBudgetLimits = {
  apiUsdDaily: number | null;
  apiUsdTotal: number | null;
  maxRunMinutes: number | null;
  maxAttempts: number | null;
  maxConcurrentRuns: number | null;
};

export const EMPTY_BUDGET: TechBudgetLimits = { apiUsdDaily: null, apiUsdTotal: null, maxRunMinutes: null, maxAttempts: null, maxConcurrentRuns: null };

/**
 * GIỮ CHỖ tiền cho MỘT lượt API mà chưa biết tiền thật (đang chạy, bị huỷ, quá giờ, thu hồi lease, CLI không báo).
 * Chưa biết KHÔNG phải 0 (AGENTS.md mục 42) — trần chi tính trên tiền giữ chỗ (cùng luật mục 72). Nhãn ƯỚC TÍNH.
 */
export const API_RUN_RESERVE_USD = 5;

/** Mặc định khi KHÔNG phạm vi nào khai — chỉ cho trần thời gian / lần thử / đồng thời; tiền API thì KHÔNG có mặc định. */
export const BUDGET_DEFAULTS = { maxRunMinutes: 45, maxAttempts: 3, maxConcurrentRuns: 4 } as const;

/** Gộp theo thứ tự rộng → hẹp (công ty, dự án, mục tiêu, sứ mệnh): ô khai ở tầng hẹp thắng. */
export function resolveBudget(layers: readonly (TechBudgetLimits | null | undefined)[]): TechBudgetLimits {
  const out: TechBudgetLimits = { ...EMPTY_BUDGET };
  for (const l of layers) {
    if (!l) continue;
    for (const k of Object.keys(out) as (keyof TechBudgetLimits)[]) if (l[k] !== null && l[k] !== undefined) out[k] = l[k];
  }
  return out;
}

export type ApiSpendVerdict = { ok: true } | { ok: false; reason: "NOT_DECLARED" | "DAILY_CAP" | "TOTAL_CAP"; detail: string };

/**
 * Worker trả tiền API được chạy thêm một lượt không. CHƯA KHAI trần ngày ⇒ KHÔNG chi (đóng khi thiếu — cùng luật
 * trần chi video, AGENTS.md mục 72). Tiền gói thuê bao không đi qua đây (không có tiền thật để đếm).
 */
export function apiSpendAllowed(limits: TechBudgetLimits, spentTodayUsd: number, spentTotalUsd: number): ApiSpendVerdict {
  if (limits.apiUsdDaily === null || limits.apiUsdDaily <= 0) return { ok: false, reason: "NOT_DECLARED", detail: "Chưa khai trần chi API theo ngày — worker API không chạy." };
  if (spentTodayUsd >= limits.apiUsdDaily) return { ok: false, reason: "DAILY_CAP", detail: `Đã chi $${spentTodayUsd.toFixed(2)} / trần ngày $${limits.apiUsdDaily.toFixed(2)}.` };
  if (limits.apiUsdTotal !== null && spentTotalUsd >= limits.apiUsdTotal) return { ok: false, reason: "TOTAL_CAP", detail: `Đã chi $${spentTotalUsd.toFixed(2)} / trần tổng $${limits.apiUsdTotal.toFixed(2)}.` };
  return { ok: true };
}

/** Mức cảnh báo chi API: ≥ 80% trần ngày ⇒ WARN, ≥ 100% ⇒ EXCEEDED. Chưa khai ⇒ null (không kết luận). */
export function apiSpendAlert(limits: TechBudgetLimits, spentTodayUsd: number): "OK" | "WARN" | "EXCEEDED" | null {
  if (limits.apiUsdDaily === null || limits.apiUsdDaily <= 0) return null;
  if (spentTodayUsd >= limits.apiUsdDaily) return "EXCEEDED";
  if (spentTodayUsd >= limits.apiUsdDaily * 0.8) return "WARN";
  return "OK";
}
