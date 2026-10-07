/**
 * ═══════════ QUYỀN DÙNG AI THEO GÓI — LUẬT THUẦN, CLIENT-SAFE (docs/saas/PRICING_V1.md §II.7 · sứ mệnh saas-l5-billing-trial) ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ: cùng đầu vào ⇒ cùng kết quả. Đọc dữ liệu nằm ở `lib/pricing/ai-gate.ts`.
 *
 * Quyết định chủ shop 07/10/2026 (xác nhận chiều):
 *  · Gói DÙNG THỬ (dòng giá của phiên bản khai `trial_days`) DỪNG AI tự trả lời khi HẾT LƯỢT khách AI của kỳ HOẶC HẾT HẠN dùng thử
 *    — cái nào tới trước (hai điều kiện là phép HOẶC, nên AI dừng ở mốc sớm hơn).
 *  · Gói TRẢ PHÍ / giá cũ (legacy) KHÔNG BAO GIỜ bị dừng vì hạn mức: vượt 100% chỉ sinh phần vượt (`computeOverage`) + cảnh báo.
 *  · Workspace bị ĐÌNH CHỈ (`platform_organizations.status = SUSPENDED`) ⇒ AI dừng — cờ đình chỉ đã có, không thêm cờ thứ hai.
 *  · Số dùng CHƯA BIẾT (lỗi đọc sổ) ⇒ KHÔNG chặn (nới), chỉ cảnh báo — chặn nhầm một khách đang bán hàng tệ hơn lọt vài khách.
 *  · Dừng AI KHÔNG khoá dữ liệu: hộp thư, gửi tay, đơn hàng vẫn chạy. Câu cho khách (chủ shop) KHÔNG mang token / USD / model.
 */

export const AI_STOP_REASONS = ["WORKSPACE_SUSPENDED", "TRIAL_EXPIRED", "TRIAL_QUOTA_EXHAUSTED"] as const;
export type AiStopReason = (typeof AI_STOP_REASONS)[number];

/** Câu hiện cho chủ shop (hộp thư · thanh trạng thái · khung thử). Nguyên văn quyết định 07/10/2026 cho câu hết lượt. */
export const AI_STOP_MESSAGE: Record<AiStopReason, string> = {
  TRIAL_QUOTA_EXHAUSTED: "Bạn đã sử dụng hết lượt AI của gói hiện tại.",
  TRIAL_EXPIRED: "Thời gian dùng thử của bạn đã kết thúc — AI tạm dừng trả lời khách.",
  WORKSPACE_SUSPENDED: "Workspace đang bị tạm dừng — AI không trả lời khách.",
};

/** Ghi chú của dòng tin khách khi cổng gói chặn (`sales_chat_inbound.note`) — `ai-status.ts` dịch ngược ra mã dấu vết. */
export const AI_STOP_NOTE: Record<AiStopReason, string> = {
  TRIAL_QUOTA_EXHAUSTED: `Gói: ${AI_STOP_MESSAGE.TRIAL_QUOTA_EXHAUSTED}`,
  TRIAL_EXPIRED: `Gói: ${AI_STOP_MESSAGE.TRIAL_EXPIRED}`,
  WORKSPACE_SUSPENDED: `Gói: ${AI_STOP_MESSAGE.WORKSPACE_SUSPENDED}`,
};

export type AiEntitlementWarning = "USAGE_UNKNOWN" | "TRIAL_END_UNKNOWN" | "PLAN_UNREADABLE";

export type AiEntitlementInput = {
  orgStatus: string;
  /** Dòng giá của gói theo phiên bản của tổ chức khai `trial_days` ⇒ đang dùng thử. `null` = không đọc được dòng giá. */
  trial: boolean | null;
  /** Mốc hết dùng thử. `null` = chưa biết (dòng cũ không có cả `trial_ends_at` lẫn `paid_through`). */
  trialEndsAt: Date | null;
  /** Khách AI đã đếm trong kỳ — `null` = CHƯA BIẾT. */
  aiCustomersUsed: number | null;
  /** Khách AI gồm trong gói — `null` = không giới hạn · `undefined` = chưa khai. */
  aiCustomersIncluded: number | null | undefined;
  now: Date;
};

export type AiEntitlementDecision = {
  allowed: boolean;
  /** Lý do đầu tiên (để hiện một câu); `reasons` giữ đủ. */
  reason: AiStopReason | null;
  reasons: AiStopReason[];
  warnings: AiEntitlementWarning[];
  trial: boolean;
};

/**
 * PHÁN QUYẾT DUY NHẤT «AI có được tự trả lời không». Mọi đường kích AI (lượt chat · đọc ảnh · nhắc khách · quét lại) đi qua
 * `lib/pricing/ai-gate.ts::loadAiEntitlement`, và nó gọi hàm này — không nơi nào tự so ngày / so hạn mức.
 */
export function aiEntitlementDecision(input: AiEntitlementInput): AiEntitlementDecision {
  const reasons: AiStopReason[] = [];
  const warnings: AiEntitlementWarning[] = [];
  if (input.orgStatus === "SUSPENDED") reasons.push("WORKSPACE_SUSPENDED");
  if (input.trial === null) warnings.push("PLAN_UNREADABLE");
  const trial = input.trial === true;
  if (trial) {
    if (input.trialEndsAt === null) warnings.push("TRIAL_END_UNKNOWN");
    else if (input.now.getTime() >= input.trialEndsAt.getTime()) reasons.push("TRIAL_EXPIRED");
    const inc = input.aiCustomersIncluded;
    if (input.aiCustomersUsed === null) warnings.push("USAGE_UNKNOWN");
    else if (typeof inc === "number" && input.aiCustomersUsed >= inc) reasons.push("TRIAL_QUOTA_EXHAUSTED");
  }
  return { allowed: reasons.length === 0, reason: reasons[0] ?? null, reasons, warnings, trial };
}

/** Mốc hết dùng thử từ ngày cuối dùng thử dạng `YYYY-MM-DD` (giờ VN, tính cả ngày đó) = 00:00 giờ VN của ngày hôm sau. */
export function trialEndFromLastDay(lastDay: string | null | undefined): Date | null {
  if (!lastDay || !/^\d{4}-\d{2}-\d{2}$/.test(lastDay)) return null;
  const [y, m, d] = lastDay.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + 1) - 7 * 3_600_000);
  return Number.isFinite(at.getTime()) ? at : null;
}

// ─────────────────────────── Ngưỡng cảnh báo gửi MỘT lần mỗi kỳ ───────────────────────────

export type UsageThresholdKey = "notify" | "limit" | "strong" | "review";
export const USAGE_THRESHOLD_ORDER: readonly UsageThresholdKey[] = ["notify", "limit", "strong", "review"];

/**
 * Ngưỡng CAO NHẤT đã chạm của đồng hồ khách AI trong kỳ, theo ngưỡng của PHIÊN BẢN giá (`alert_thresholds` — không gõ số ở đây).
 * `limit` = chạm 100% (≥, không phải >): với dùng thử đó là lúc AI dừng, với gói trả phí là lúc bắt đầu tính phần vượt. Chưa biết /
 * không giới hạn / chưa khai / gói gồm 0 ⇒ `null` (không có gì để báo).
 */
export function highestUsageThreshold(used: number | null, included: number | null | undefined, cfg: { notifyPct: number; overagePct: number; strongPct: number; reviewPct: number }): { key: UsageThresholdKey; pct: number; thresholdPct: number } | null {
  if (used === null || included === null || included === undefined || !(included > 0)) return null;
  const pct = (used / included) * 100;
  const levels: [UsageThresholdKey, number][] = [
    ["review", cfg.reviewPct],
    ["strong", cfg.strongPct],
    ["limit", cfg.overagePct],
    ["notify", cfg.notifyPct],
  ];
  for (const [key, at] of levels) if (pct >= at) return { key, pct, thresholdPct: at };
  return null;
}

/** Khoá chống trùng của MỘT ngưỡng trong MỘT kỳ — neo theo KỲ (tháng VN của chính mốc đo), không theo khung giờ. */
export function usageAlertDedupeKey(periodMonth: string, key: UsageThresholdKey): string {
  return `pricing:ai-customers:${periodMonth}:${key}`;
}

// ─────────────────────────── Trạng thái AI cho màn khách ───────────────────────────

export type CustomerAiState = "RUNNING" | "PAUSED" | "QUOTA_EXHAUSTED" | "TRIAL_EXPIRED" | "SUSPENDED" | "NOT_INCLUDED";
export const CUSTOMER_AI_STATE_LABEL: Record<CustomerAiState, string> = {
  RUNNING: "Đang chạy",
  PAUSED: "Tạm dừng",
  QUOTA_EXHAUSTED: "Hết lượt",
  TRIAL_EXPIRED: "Hết dùng thử",
  SUSPENDED: "Workspace tạm dừng",
  NOT_INCLUDED: "Gói không gồm AI",
};

/** Trạng thái AI hiện cho khách: cổng gói trước, rồi gói có AI không, rồi bot có bật không. */
export function customerAiState(d: Pick<AiEntitlementDecision, "reason">, opts: { aiSales: boolean; botEnabled: boolean | null }): CustomerAiState {
  if (d.reason === "WORKSPACE_SUSPENDED") return "SUSPENDED";
  if (d.reason === "TRIAL_EXPIRED") return "TRIAL_EXPIRED";
  if (d.reason === "TRIAL_QUOTA_EXHAUSTED") return "QUOTA_EXHAUSTED";
  if (!opts.aiSales) return "NOT_INCLUDED";
  if (opts.botEnabled === false) return "PAUSED";
  return "RUNNING";
}
