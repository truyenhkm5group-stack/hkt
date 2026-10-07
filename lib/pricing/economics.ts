/**
 * ═══════════ KINH TẾ ĐƠN VỊ SAAS — HÀM THUẦN, CLIENT-SAFE (docs/platform/pricing-billing-foundation.md §6) ═══════════
 *
 * Bổ sung cho `lib/platform/saas-metrics.ts` (MRR, biến động, biên nền tảng) — KHÔNG thay. Mọi phép chia có mẫu 0 hoặc tử
 * CHƯA BIẾT trả `null` (in «—»), không bao giờ 0 (luật 42). Chi phí AI nền tảng = lượt `billing_source = PLATFORM` (tiền
 * nền tảng trả); BYOK là tiền của khách, KHÔNG phải giá vốn của nền tảng.
 */
import { aiBalanceRevenueVnd, type AiBalancePeriod } from "@/lib/billing/ai-balance-rules";
import { overageNetOfBalance, type OverageResult } from "@/lib/pricing/versions";
import type { SaasDailyRow } from "@/lib/platform/saas-metrics";

/** Mẫu nhỏ hơn thế ⇒ tỷ lệ chuyển đổi `null` (in số đếm, không in phần trăm). */
export const CONVERSION_MIN_SAMPLE = 5;
/** Chiếu cuối kỳ chỉ khi đã qua ít nhất bấy nhiêu ngày. */
export const PROJECTION_MIN_DAYS = 3;

export const div = (a: number | null, b: number | null): number | null => (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0 ? null : a / b);

/** Chiếu số tới cuối kỳ theo nhịp hiện tại — ESTIMATED. Quá ít ngày ⇒ `null`. */
export function projectToPeriodEnd(valueToDate: number | null, elapsedDays: number, totalDays: number, minDays: number = PROJECTION_MIN_DAYS): number | null {
  if (valueToDate === null || elapsedDays < minDays || totalDays <= 0) return null;
  return (valueToDate / elapsedDays) * totalDays;
}

export type TenantUnitEconomics = {
  revenueVnd: number | null;
  platformAiCostVnd: number | null;
  /** Tất cả lượt định giá được — `false` thì chi phí là CẬN DƯỚI. */
  aiCostComplete: boolean;
  grossProfitVnd: number | null;
  grossMarginPct: number | null;
  aiCostPerOrderVnd: number | null;
  aiCostPerConversationVnd: number | null;
};

/**
 * Kinh tế đơn vị của MỘT tổ chức trong một kỳ. `revenueVnd` = doanh thu định kỳ của kỳ (MRR — danh nghĩa, không phải tiền
 * đã thu); `aiOrders` / `aiConversations` từ đồng hồ đo. Hạ tầng / hỗ trợ CHƯA phân bổ về từng tổ chức (chưa có căn cứ —
 * AGENTS §14), nên "lãi gộp" ở mức tổ chức = doanh thu − chi phí AI nền tảng, nói rõ trên màn hình.
 */
export function tenantUnitEconomics(input: { revenueVnd: number | null; platformAiCostVnd: number | null; aiCostComplete: boolean; aiOrders: number | null; aiConversations: number | null }): TenantUnitEconomics {
  const { revenueVnd, platformAiCostVnd } = input;
  const gross = revenueVnd === null || platformAiCostVnd === null ? null : revenueVnd - platformAiCostVnd;
  const marginRatio = div(gross, revenueVnd);
  return {
    revenueVnd,
    platformAiCostVnd,
    aiCostComplete: input.aiCostComplete,
    grossProfitVnd: gross,
    grossMarginPct: marginRatio === null ? null : marginRatio * 100,
    aiCostPerOrderVnd: div(platformAiCostVnd, input.aiOrders),
    aiCostPerConversationVnd: div(platformAiCostVnd, input.aiConversations),
  };
}

export type MarginRisk = "NEGATIVE" | "TRIAL_COST" | "OK" | "NO_COST" | "UNKNOWN";
export const MARGIN_RISK_LABEL: Record<MarginRisk, string> = {
  NEGATIVE: "Nguy cơ âm biên — chi phí AI chiếu cuối tháng vượt doanh thu",
  TRIAL_COST: "Chưa trả tiền mà nền tảng đang chịu chi phí AI",
  OK: "Biên dương",
  NO_COST: "Chưa phát sinh chi phí AI của nền tảng",
  UNKNOWN: "Chưa đủ dữ liệu để chiếu",
};

/**
 * Tổ chức có nguy cơ ÂM BIÊN không. Không có ngưỡng bịa: chỉ một câu hỏi — chi phí AI nền tảng CHIẾU tới cuối tháng có vượt
 * doanh thu tháng không. Tổ chức chưa trả tiền mà đang tốn credit AI nền tảng là loại riêng (chi phí thu hút khách, không
 * phải "âm biên" của một thuê bao).
 */
export function marginRisk(input: { revenueVnd: number | null; platformAiCostToDateVnd: number; projectedPlatformAiCostVnd: number | null }): MarginRisk {
  if (input.platformAiCostToDateVnd <= 0) return "NO_COST";
  // `null` = chưa có ảnh chụp MRR của tổ chức (CHƯA BIẾT) — khác 0 (đang không trả tiền).
  if (input.revenueVnd === null) return "UNKNOWN";
  if (input.revenueVnd === 0) return "TRIAL_COST";
  if (input.projectedPlatformAiCostVnd === null) return input.platformAiCostToDateVnd > input.revenueVnd ? "NEGATIVE" : "UNKNOWN";
  return input.projectedPlatformAiCostVnd > input.revenueVnd ? "NEGATIVE" : "OK";
}

export type TrialConversion = { trialOrgs: number; converted: number; rate: number | null; note: string | null };

/**
 * DÙNG THỬ → TRẢ TIỀN từ sổ ảnh chụp hằng ngày (`platform_saas_daily`, 0203): tổ chức từng có NGÀY dùng thử (đang thu phí,
 * chưa tính MRR, chưa khoá, đang chạy) và có một ngày SAU ĐÓ tính MRR. Sổ chỉ có từ ngày nó được dựng — tổ chức dùng thử
 * trước đó không vào mẫu (nói ra). Mẫu < `CONVERSION_MIN_SAMPLE` ⇒ không in phần trăm.
 */
export function trialConversion(rows: readonly Pick<SaasDailyRow, "day" | "orgCode" | "isHome" | "orgStatus" | "billingEnabled" | "standing" | "paying">[]): TrialConversion {
  const firstTrial = new Map<string, string>();
  const sorted = [...rows].sort((a, b) => a.day.localeCompare(b.day));
  for (const r of sorted) {
    if (r.isHome || r.orgStatus !== "ACTIVE" || !r.billingEnabled || r.paying || r.standing === "LOCKED") continue;
    if (!firstTrial.has(r.orgCode)) firstTrial.set(r.orgCode, r.day);
  }
  let converted = 0;
  for (const [org, day] of firstTrial) if (sorted.some((r) => r.orgCode === org && r.day > day && r.paying)) converted += 1;
  const n = firstTrial.size;
  return { trialOrgs: n, converted, rate: n >= CONVERSION_MIN_SAMPLE ? converted / n : null, note: n < CONVERSION_MIN_SAMPLE ? `Mẫu ${n} tổ chức — dưới ${CONVERSION_MIN_SAMPLE} chưa in tỷ lệ.` : null };
}

// ─────────────────────────── Số dư AI trong doanh thu (docs/saas/AI_BALANCE_V1.md §5) ───────────────────────────

export type BalanceRevenue = {
  /** MRR + doanh thu Số dư AI tới nay (tiền THẬT đã dùng − khoản đảo) — ghi nhận. Tiền nạp chưa dùng và tiền tặng KHÔNG ở đây. */
  realizedVnd: number | null;
  /**
   * Doanh thu của kỳ cho biên CHIẾU: MRR + phần vượt CHƯA thu qua Số dư (sau `overageNetOfBalance`) + doanh thu Số dư AI CHIẾU
   * cuối kỳ (cùng nhịp với chi phí AI chiếu — so tới-nay với cả-tháng là biên đầu tháng NGUY CẤP giả, review #648 L3). ESTIMATED.
   */
  projectedVnd: number | null;
  /** Phần vượt SAU khi trừ khách AI đã thu qua Số dư (`overageNetOfBalance`) — cái màn vận hành in, cùng số với bảng kê. */
  overage: OverageResult | null;
};

/**
 * Doanh thu kỳ của MỘT tổ chức với Số dư AI — MỘT công thức cho mọi tổ chức (không rẽ theo cờ, không rẽ theo «đã từng có dòng
 * sổ»). Dòng «khách AI vượt» của bảng tính vượt trừ đúng SỐ khách đã thu qua sổ cái (`overageNetOfBalance` — cùng hàm với bảng
 * kê, nên hai màn vận hành không nói hai số cho cùng một kỳ — review #648 M2); tiền THẬT đã dùng (trừ khoản đảo) cộng riêng.
 * Tổ chức chưa từng dùng Số dư (`balance = null`) ⇒ trừ 0 khách, cộng 0đ ⇒ ĐÚNG công thức cũ. Tiền TẶNG đã dùng không vào
 * doanh thu ở bất kỳ vế nào. `projection` có ⇒ doanh thu Số dư chiếu theo nhịp tới nay (chưa đủ ngày ⇒ chiếu `null`).
 */
export function revenueWithAiBalance(input: {
  mrrVnd: number | null;
  overage: OverageResult | null;
  balance: AiBalancePeriod | null;
  blockSize: number | null;
  projection?: { elapsedDays: number; totalDays: number } | null;
}): BalanceRevenue {
  const { mrrVnd, overage, balance } = input;
  const used = aiBalanceRevenueVnd(balance);
  const net = overage ? overageNetOfBalance(overage, balance?.aiCustomerUnits ?? 0, input.blockSize) : null;
  const usedProjected = input.projection ? projectToPeriodEnd(used, input.projection.elapsedDays, input.projection.totalDays) : used;
  return {
    realizedVnd: mrrVnd === null ? null : mrrVnd + used,
    projectedVnd: mrrVnd === null || !net || net.totalVnd === null || usedProjected === null ? null : mrrVnd + net.totalVnd + Math.round(usedProjected),
    overage: net,
  };
}

/**
 * Số dư AI cả nền tảng (review #648 H1 + M1) — HÀM THUẦN, một chỗ tính cho khung /platform/saas:
 *  · DÒNG TIỀN trong kỳ (nạp · đã dùng · đảo · điều chỉnh · doanh thu) chỉ của tổ chức trong khung (`tenantCodes` — CÙNG tập
 *    với chi phí AI, không thì doanh thu và chi phí nói về hai nhóm khách khác nhau);
 *  · SỐ DƯ cuối kỳ của MỌI tổ chức trừ nhà — kể cả đình chỉ / lưu trữ: tiền khách vẫn nằm đó (khoản phải hoàn). Số dư tiền
 *    thật ÂM (lượt trừ cuối làm âm tối đa một đơn giá) là khách ĐANG NỢ — tách riêng, không bù trừ vào khoản đang giữ (L2).
 */
export type AiBalanceTotals = {
  topupVnd: number;
  usageCashVnd: number;
  usagePromoVnd: number;
  reversalCashVnd: number;
  adjustCashVnd: number;
  revenueVnd: number;
  orgs: number;
  heldCashVnd: number;
  owedCashVnd: number;
  heldPromoVnd: number;
  heldOrgs: number;
};

export function aiBalanceTotals(input: { balances: ReadonlyMap<string, AiBalancePeriod>; tenantCodes: ReadonlySet<string>; homeCode: string | null }): AiBalanceTotals {
  const t: AiBalanceTotals = { topupVnd: 0, usageCashVnd: 0, usagePromoVnd: 0, reversalCashVnd: 0, adjustCashVnd: 0, revenueVnd: 0, orgs: 0, heldCashVnd: 0, owedCashVnd: 0, heldPromoVnd: 0, heldOrgs: 0 };
  for (const [code, b] of input.balances) {
    if (code === input.homeCode) continue;
    t.heldOrgs += 1;
    if (b.balanceCashVnd >= 0) t.heldCashVnd += b.balanceCashVnd;
    else t.owedCashVnd += -b.balanceCashVnd;
    t.heldPromoVnd += Math.max(0, b.balancePromoVnd);
    if (!input.tenantCodes.has(code)) continue;
    t.orgs += 1;
    t.topupVnd += b.topupVnd;
    t.usageCashVnd += b.usageCashVnd;
    t.usagePromoVnd += b.usagePromoVnd;
    t.reversalCashVnd += b.reversalCashVnd;
    t.adjustCashVnd += b.adjustCashVnd;
    t.revenueVnd += aiBalanceRevenueVnd(b);
  }
  return t;
}

/**
 * Lãi gộp cấp nền tảng (review #648 H1) — HÀM THUẦN. Doanh thu = MRR các tổ chức trả tiền + doanh thu Số dư AI CHIẾU cuối kỳ
 * (cùng nhịp với chi phí AI chiếu); chi phí = AI nền tảng chiếu + hạ tầng đã khai. Thiếu một vế (chưa đủ ngày để chiếu · chưa
 * khai hạ tầng · chưa có doanh thu) ⇒ `null`, không phải 0. Tiền nạp / tiền tặng không bao giờ ở vế doanh thu.
 */
export function platformGrossMargin(input: { mrrPayingVnd: number; aiBalanceRevenueToDateVnd: number; elapsedDays: number; totalDays: number; projectedAiCostVnd: number | null; infraVnd: number | null }): { marginRevenueVnd: number | null; grossProfitVnd: number | null; grossMarginPct: number | null } {
  const aiRev = projectToPeriodEnd(input.aiBalanceRevenueToDateVnd, input.elapsedDays, input.totalDays);
  const marginRevenueVnd = aiRev === null ? null : input.mrrPayingVnd + Math.round(aiRev);
  if (marginRevenueVnd === null || marginRevenueVnd <= 0 || input.projectedAiCostVnd === null || input.infraVnd === null) return { marginRevenueVnd, grossProfitVnd: null, grossMarginPct: null };
  const gross = marginRevenueVnd - input.projectedAiCostVnd - input.infraVnd;
  return { marginRevenueVnd, grossProfitVnd: Math.round(gross), grossMarginPct: (gross / marginRevenueVnd) * 100 };
}
