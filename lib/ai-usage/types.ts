/**
 * ═══════════ DÙNG AI & HẠN MỨC AI — KIỂU + LUẬT THUẦN (docs/platform/ai-usage.md) — CLIENT-SAFE ═══════════
 *
 * Tệp này KHÔNG import gì của máy chủ: màn hình, bài kiểm và máy chủ dùng chung cùng MỘT phép tính hạn mức
 * (`evaluateAiQuota`). Phần đọc / ghi CSDL ở `ledger.ts` · `quota.ts` · `control.ts`.
 *
 * ─── AI TRẢ TIỀN — BA NGUỒN, KHÔNG BAO GIỜ LẪN ───
 *  · `BYOK`     — khoá của CHÍNH tổ chức (kết nối `anthropic-byok` / `openai-byok`). Tiền của khách; hạn mức chủ yếu
 *                 giới hạn SỐ LƯỢT để chống lạm dụng máy chủ của nền tảng.
 *  · `PLATFORM` — khoá của NỀN TẢNG (`PLATFORM_AI_API_KEY`, KHÁC khoá của nhà). Tiền của nền tảng; giới hạn bằng TIỀN
 *                 (`platformCreditUsdPerMonth`). MẶC ĐỊNH TẮT — bật là quyết định của chủ nền tảng.
 *  · `HOME`     — khoá `.env` của tổ chức nhà (VNX), chỉ tổ chức nhà. Gói `internal`: không giới hạn.
 *
 * Mỗi nguồn đếm RIÊNG: lượt BYOK của A không bao giờ trừ vào credit PLATFORM, và không tổ chức nào trừ vào sổ của tổ
 * chức khác (câu đếm luôn lọc `org_code` + `billing_source`).
 */
import { AI_FAILURE_CLASSES, classifyAiFailure, type AiFailureClass } from "@/lib/constants/ai-incidents";

export const AI_BILLING_SOURCES = ["BYOK", "PLATFORM", "HOME"] as const;
export type AiBillingSource = (typeof AI_BILLING_SOURCES)[number];

export const AI_BILLING_SOURCE_LABEL: Record<AiBillingSource, string> = {
  BYOK: "Khoá AI của tổ chức",
  PLATFORM: "Credit AI của nền tảng",
  HOME: "AI của tổ chức nhà",
};

export const AI_USAGE_FEATURES = ["ai_builder", "copilot", "sales_chatbot", "sales_playbook", "lead_hunter", "creative_image", "creative_copy"] as const;
export type AiUsageFeature = (typeof AI_USAGE_FEATURES)[number];

/**
 * LOẠI VIỆC của Platform AI Policy (0231) — mỗi loại một chính sách model riêng được (docs/platform/ai-model-control.md §8).
 * `sales_chatbot` = bot trả lời khách · `order_sync` = ghi đơn từ hội thoại nhân viên · `quick_extract` = AI chọn câu mẫu /
 * phân loại ngắn · `vision` = đọc ảnh khách gửi.
 */
export const PLATFORM_WORKLOADS = ["sales_chatbot", "order_sync", "quick_extract", "vision"] as const;
export type PlatformWorkload = (typeof PLATFORM_WORKLOADS)[number];
export const PLATFORM_WORKLOAD_LABEL: Record<PlatformWorkload, string> = { sales_chatbot: "Sales Chat", order_sync: "Order Sync", quick_extract: "Quick Extract", vision: "Vision" };

export const AI_USAGE_FEATURE_LABEL: Record<AiUsageFeature, string> = { ai_builder: "AI Builder", copilot: "AI Copilot", sales_chatbot: "Chatbot bán hàng", sales_playbook: "Học từ hội thoại cũ", lead_hunter: "Lời chào khách sỉ", creative_image: "Vẽ ảnh quảng cáo", creative_copy: "Câu chữ quảng cáo" };

/** Loại lượt (0222): chữ · đọc ảnh khách gửi · vẽ ảnh. `NULL` trong sổ = nơi gọi chưa khai. */
export const AI_USAGE_MODALITIES = ["TEXT", "VISION", "IMAGE"] as const;
export type AiUsageModality = (typeof AI_USAGE_MODALITIES)[number];

export const AI_USAGE_STATUSES = ["OK", "ERROR", "BLOCKED_QUOTA"] as const;
export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number];

export const AI_USAGE_STATUS_LABEL: Record<AiUsageStatus, string> = { OK: "Thành công", ERROR: "Lỗi", BLOCKED_QUOTA: "Bị chặn (hạn mức)" };

/** Câu nói khi người vận hành tắt AI — MỘT câu, mọi màn hình in đúng câu này. */
export const AI_DISABLED_BY_OPERATOR = "AI đang bị tắt bởi người vận hành";

/**
 * Hạn mức AI của MỘT gói (`platform_plans.limits.ai`) hoặc ghi đè của MỘT tổ chức (`platform_organizations.settings.ai.limits`).
 * `null` = không giới hạn. Lượt = MỘT dòng sổ (một bản nháp AI Builder = 1 lượt, dù bên trong có 3 lời gọi model).
 *  · `requestsPerDay` / `requestsPerMonth` — trần CỨNG theo lượt, đếm RIÊNG từng nguồn.
 *  · `costUsdPerMonth.soft` — vượt ⇒ vẫn cho qua, báo quản trị tổ chức MỘT lần / ngày / nguồn.
 *  · `costUsdPerMonth.hard` — tới trần ⇒ từ chối TRƯỚC khi gọi model.
 *  · `platformCreditUsdPerMonth` — credit nền tảng / tháng; `0` ⇒ nguồn PLATFORM không bao giờ chạy. Với nguồn PLATFORM,
 *    trần cứng thật = min(`hard`, credit).
 *  · `softOnly` (0228 · gói AI của bảng giá có phiên bản): credit là NGÂN SÁCH MỀM — vượt chỉ cảnh báo, KHÔNG thành trần cứng
 *    (quyết định 07/10/2026: không tự tắt AI bán hàng vì dùng nhiều; thu bằng phần vượt khách AI). Ghi đè tay của người vận
 *    hành (chính sách lạm dụng / bất thường) vẫn áp như cũ.
 */
export type AiLimits = {
  requestsPerDay: number | null;
  requestsPerMonth: number | null;
  costUsdPerMonth: { soft: number | null; hard: number | null };
  platformCreditUsdPerMonth: number;
  softOnly?: boolean;
  /**
   * Trả trước theo khách AI (docs/saas/AI_BALANCE_V1.md §7 — `lib/pricing/versions.ts::prepaidAiLimits`): trần tiền CỦA GÓI để
   * giữ khi CHƯA có credit AI dùng chung (bot còn chạy khoá riêng). Có dấu này thì `applyAiOverride` quyết trần tiền SAU ghi đè.
   */
  prepaid?: { planSoftUsd: number | null; planHardUsd: number | null };
};

/**
 * Trả trước: trần CỨNG chống lạm dụng = credit × hệ số này (credit = ngưỡng CẢNH BÁO). Cổng tiền là Số dư AI, nhưng các việc
 * không đi qua cổng số dư (khách đã tính nhắn tiếp, học hội thoại, nhắc khách, Copilot / AI Builder) vẫn tiêu tiền nền tảng khi
 * số dư ≤ 0 — trần này chặn chúng ở mức có giới hạn. Chạm trần ⇒ chặn CẢ AI Bán hàng (người vận hành nâng credit).
 */
export const PREPAID_ABUSE_HARD_MULTIPLIER = 3;

/** Ghi đè THƯA của một tổ chức: ô nào có mặt thì thắng gói; ô vắng = theo gói. */
export type AiLimitsOverride = {
  requestsPerDay?: number | null;
  requestsPerMonth?: number | null;
  costUsdSoft?: number | null;
  costUsdHard?: number | null;
  platformCreditUsdPerMonth?: number;
};

export const AI_LIMIT_OVERRIDE_KEYS = ["requestsPerDay", "requestsPerMonth", "costUsdSoft", "costUsdHard", "platformCreditUsdPerMonth"] as const;
export type AiLimitOverrideKey = (typeof AI_LIMIT_OVERRIDE_KEYS)[number];

export const AI_LIMIT_OVERRIDE_LABEL: Record<AiLimitOverrideKey, string> = {
  requestsPerDay: "Lượt / ngày",
  requestsPerMonth: "Lượt / tháng",
  costUsdSoft: "Tiền / tháng — ngưỡng cảnh báo (USD)",
  costUsdHard: "Tiền / tháng — trần cứng (USD)",
  platformCreditUsdPerMonth: "Credit nền tảng / tháng (USD)",
};

/** Gói KHÔNG khai khoá `ai`: không giới hạn lượt / tiền (nói ra ở màn hình), credit nền tảng 0 — phía HẸP cho tiền nền tảng. */
export const UNDECLARED_AI_LIMITS: AiLimits = { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: null, hard: null }, platformCreditUsdPerMonth: 0 };

/** Tổ chức nhà: không giới hạn gì (và không dùng credit nền tảng — nhà có khoá riêng). */
export const HOME_AI_LIMITS: AiLimits = UNDECLARED_AI_LIMITS;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cap = (v: unknown): number | null | undefined => (v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Đọc `limits.ai` của một gói. Thiếu / sai kiểu ⇒ `undeclared: true` + `UNDECLARED_AI_LIMITS`; ô sai kiểu ⇒ `null` của ô đó. */
export function parseAiLimits(planLimits: unknown): { limits: AiLimits; undeclared: boolean } {
  const ai = isRec(planLimits) ? planLimits.ai : undefined;
  if (!isRec(ai)) return { limits: UNDECLARED_AI_LIMITS, undeclared: true };
  const cost = isRec(ai.costUsdPerMonth) ? ai.costUsdPerMonth : {};
  const credit = cap(ai.platformCreditUsdPerMonth);
  return {
    limits: {
      requestsPerDay: cap(ai.requestsPerDay) ?? null,
      requestsPerMonth: cap(ai.requestsPerMonth) ?? null,
      costUsdPerMonth: { soft: cap(cost.soft) ?? null, hard: cap(cost.hard) ?? null },
      // Credit là TIỀN CỦA NỀN TẢNG: sai kiểu / `null` ⇒ 0 (hẹp), không bao giờ "không giới hạn".
      platformCreditUsdPerMonth: typeof credit === "number" ? credit : 0,
    },
    undeclared: false,
  };
}

/** Đọc ghi đè thưa của tổ chức (`settings.ai.limits`) — chỉ giữ ô hợp lệ. */
export function parseAiOverride(raw: unknown): AiLimitsOverride {
  if (!isRec(raw)) return {};
  const out: AiLimitsOverride = {};
  for (const k of AI_LIMIT_OVERRIDE_KEYS) {
    if (!(k in raw)) continue;
    const v = cap(raw[k]);
    if (v === undefined) continue;
    if (k === "platformCreditUsdPerMonth") {
      if (v !== null) out.platformCreditUsdPerMonth = v;
    } else out[k] = v;
  }
  return out;
}

export function applyAiOverride(base: AiLimits, o: AiLimitsOverride): AiLimits {
  const out: AiLimits = {
    requestsPerDay: "requestsPerDay" in o ? (o.requestsPerDay ?? null) : base.requestsPerDay,
    requestsPerMonth: "requestsPerMonth" in o ? (o.requestsPerMonth ?? null) : base.requestsPerMonth,
    costUsdPerMonth: {
      soft: "costUsdSoft" in o ? (o.costUsdSoft ?? null) : base.costUsdPerMonth.soft,
      hard: "costUsdHard" in o ? (o.costUsdHard ?? null) : base.costUsdPerMonth.hard,
    },
    platformCreditUsdPerMonth: o.platformCreditUsdPerMonth ?? base.platformCreditUsdPerMonth,
    ...(base.softOnly ? { softOnly: true } : {}),
  };
  if (!base.prepaid) return out;
  // Trả trước: CHƯA có credit (bot còn khoá riêng — credit chỉ đặt cùng lượt org-ai-cutover) ⇒ y như gói cũ: trần tiền của gói,
  // không softOnly (AI dùng chung đóng). CÓ credit ⇒ softOnly: credit là ngưỡng CẢNH BÁO, trần cứng chống lạm dụng = credit × 3.
  // Ghi đè tường minh của người vận hành (costUsdSoft / costUsdHard) luôn thắng.
  const credit = out.platformCreditUsdPerMonth;
  const live = credit > 0;
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    requestsPerDay: out.requestsPerDay,
    requestsPerMonth: out.requestsPerMonth,
    costUsdPerMonth: {
      soft: "costUsdSoft" in o ? (o.costUsdSoft ?? null) : live ? credit : base.prepaid.planSoftUsd,
      hard: "costUsdHard" in o ? (o.costUsdHard ?? null) : live ? round2(credit * PREPAID_ABUSE_HARD_MULTIPLIER) : base.prepaid.planHardUsd,
    },
    platformCreditUsdPerMonth: credit,
    ...(live ? { softOnly: true } : {}),
    prepaid: base.prepaid,
  };
}

/** Mức dùng của MỘT tổ chức × MỘT nguồn. `costUsd` chỉ cộng lượt định giá được; `unknownCost` đếm lượt CHƯA BIẾT giá. */
export type AiSourceUsage = { requestsToday: number; requestsMonth: number; costUsdMonth: number; unknownCostMonth: number };

export const EMPTY_SOURCE_USAGE: AiSourceUsage = { requestsToday: 0, requestsMonth: 0, costUsdMonth: 0, unknownCostMonth: 0 };

/** Trần hạn mức nào chặn lượt — `evaluateAiQuota` / `checkAiQuota` trả về, dòng `BLOCKED_QUOTA` mang lại ở `error_class` (0236). */
export const AI_QUOTA_BLOCK_REASONS = ["REQUESTS_DAY", "REQUESTS_MONTH", "COST_HARD", "NO_PLATFORM_CREDIT", "PLATFORM_CREDIT_USED", "PLAN_UNREADABLE"] as const;
export type AiQuotaBlockReason = (typeof AI_QUOTA_BLOCK_REASONS)[number];

/**
 * ═══ AI IM CÓ TÊN (0236 · sứ mệnh saas-ops-signals) ═══
 *
 * `platform_ai_usage.error_class`: dòng `ERROR` mang LỚP LỖI của nhà cung cấp — đúng bộ phân loại đã có (`classifyAiFailure`,
 * lib/constants/ai-incidents.ts: bốn lớp thô của `salesBotError` đi trước, chỉ tách mịn phần «khác»); dòng `BLOCKED_QUOTA`
 * mang TRẦN nào chạm (`AiQuotaBlockReason`). `NULL` = CHƯA PHÂN LOẠI (dòng trước 0236, đường ghi chưa nối) — không phải «khác».
 * Danh sách đóng, CHECK ở CSDL cùng đúng các giá trị này.
 */
export const AI_USAGE_ERROR_CLASSES = [...AI_FAILURE_CLASSES, ...AI_QUOTA_BLOCK_REASONS] as const;
export type AiUsageErrorClass = (typeof AI_USAGE_ERROR_CLASSES)[number];

/** Lỗi ném ra từ lời gọi model ⇒ lớp lỗi cho sổ AI. HÀM THUẦN, không giữ câu lỗi (câu có thể mang dữ liệu). */
export function aiErrorClassOf(error: unknown): AiFailureClass {
  return classifyAiFailure(error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? ""));
}

export type AiQuotaVerdict =
  | { ok: true; source: AiBillingSource; softExceeded: boolean; warning: string | null; usage: AiSourceUsage; limits: AiLimits }
  | { ok: false; source: AiBillingSource; reason: AiQuotaBlockReason; error: string; usage: AiSourceUsage; limits: AiLimits };

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v !== 0 && Math.abs(v) < 0.01 ? 4 : 2 })} USD`;
}

/**
 * PHÉP TÍNH HẠN MỨC DUY NHẤT — thuần. `usage` là mức dùng của ĐÚNG tổ chức × ĐÚNG nguồn (nơi gọi đếm, lọc cả hai).
 * Thứ tự: nguồn PLATFORM không có credit ⇒ chặn · lượt / ngày · lượt / tháng · tiền tới trần cứng ⇒ chặn · vượt ngưỡng
 * cảnh báo ⇒ cho qua kèm câu cảnh báo. Trần tiền so với tiền ĐÃ BIẾT (lượt chưa định giá được đếm riêng, nói ra).
 */
export function evaluateAiQuota(source: AiBillingSource, limits: AiLimits, usage: AiSourceUsage): AiQuotaVerdict {
  const base = { source, usage, limits };
  const no = (reason: AiQuotaBlockReason, error: string): AiQuotaVerdict => ({ ok: false, reason, error, ...base });
  let hard = limits.costUsdPerMonth.hard;
  if (source === "PLATFORM") {
    // Ngân sách mềm chưa tính được (tỷ giá thiếu) ⇒ chỉ báo, không chặn.
    if (!(limits.platformCreditUsdPerMonth > 0) && !limits.softOnly) return no("NO_PLATFORM_CREDIT", "Gói của tổ chức không có credit AI của nền tảng — khai khoá AI của tổ chức ở /settings/connections.");
    // Ngân sách mềm (softOnly) không bao giờ thành trần cứng — chỉ cảnh báo ở nhánh `soft` bên dưới.
    if (!limits.softOnly) hard = hard === null ? limits.platformCreditUsdPerMonth : Math.min(hard, limits.platformCreditUsdPerMonth);
  }
  if (limits.requestsPerDay !== null && usage.requestsToday >= limits.requestsPerDay)
    return no("REQUESTS_DAY", `Đã dùng hết ${limits.requestsPerDay.toLocaleString("vi-VN")} lượt AI hôm nay (${AI_BILLING_SOURCE_LABEL[source].toLowerCase()}) — thử lại ngày mai hoặc nhờ người vận hành nâng gói.`);
  if (limits.requestsPerMonth !== null && usage.requestsMonth >= limits.requestsPerMonth)
    return no("REQUESTS_MONTH", `Đã dùng hết ${limits.requestsPerMonth.toLocaleString("vi-VN")} lượt AI tháng này (${AI_BILLING_SOURCE_LABEL[source].toLowerCase()}) — người vận hành nền tảng nâng gói thì dùng tiếp được.`);
  if (hard !== null && usage.costUsdMonth >= hard)
    return source === "PLATFORM" && hard === limits.platformCreditUsdPerMonth
      ? no("PLATFORM_CREDIT_USED", `Đã dùng hết credit AI của nền tảng tháng này (${formatUsd(usage.costUsdMonth)} / ${formatUsd(hard)}) — khai khoá AI của tổ chức ở /settings/connections để dùng tiếp.`)
      : no("COST_HARD", `Chi phí AI tháng này đã tới trần ${formatUsd(hard)} (${formatUsd(usage.costUsdMonth)}) — AI tạm dừng tới tháng sau hoặc tới khi người vận hành nâng trần.`);
  const soft = limits.costUsdPerMonth.soft;
  if (soft !== null && usage.costUsdMonth >= soft) {
    return { ok: true, softExceeded: true, warning: `Chi phí AI tháng này (${AI_BILLING_SOURCE_LABEL[source].toLowerCase()}) đã vượt ngưỡng cảnh báo ${formatUsd(soft)}: ${formatUsd(usage.costUsdMonth)}${hard !== null ? ` — trần cứng ${formatUsd(hard)}` : ""}.`, ...base };
  }
  return { ok: true, softExceeded: false, warning: null, ...base };
}

/** Mốc 00:00 ngày 1 của tháng hiện tại theo giờ Việt Nam, dạng UTC. */
export function monthStartVN(now: Date): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - 7 * 3_600_000);
}

/** Ngày theo giờ Việt Nam `YYYY-MM-DD` — khoá "một lần / ngày" của cảnh báo ngưỡng. */
export function vnDayKey(now: Date): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}
