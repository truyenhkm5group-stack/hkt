/**
 * ═══════════ KINH TẾ ĐƠN VỊ SAAS — HÀM THUẦN, CLIENT-SAFE (docs/platform/pricing-billing-foundation.md §6) ═══════════
 *
 * Bổ sung cho `lib/platform/saas-metrics.ts` (MRR, biến động, biên nền tảng) — KHÔNG thay. Mọi phép chia có mẫu 0 hoặc tử
 * CHƯA BIẾT trả `null` (in «—»), không bao giờ 0 (luật 42). Chi phí AI nền tảng = lượt `billing_source = PLATFORM` (tiền
 * nền tảng trả); BYOK là tiền của khách, KHÔNG phải giá vốn của nền tảng.
 */
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
