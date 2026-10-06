/**
 * ═══════════ MARGIN GUARD — LUẬT THUẦN, CLIENT-SAFE (docs/platform/pricing-billing-foundation.md §5) ═══════════
 *
 * Không đọc CSDL, không đọc đồng hồ: cùng đầu vào ⇒ cùng kết quả, kiểm bằng bảng chân lý.
 *
 * NGƯỠNG (chủ shop chốt 06/10/2026, sửa được ở `platform.pricing.guard` không cần deploy):
 *   < 50%  OK      · bình thường
 *   ≥ 50%  NOTICE  · đã dùng một nửa — nhắc nhẹ
 *   ≥ 80%  WARN    · cảnh báo
 *   ≥ 100% LIMIT   · tính phí vượt HOẶC mời nâng gói — theo chính sách của GÓI
 *
 * KHÔNG BAO GIỜ TỰ NGẮT AI BÁN HÀNG Ở NGƯỠNG MỀM. Chặn (`blocked`) chỉ xảy ra khi ĐỦ CẢ BỐN: công tắc trần cứng của nền
 * tảng BẬT (`hardLimitsEnabled`, mặc định TẮT) · tổ chức ở mức áp `HARD` (mặc định `SOFT`) · ô hạn mức của gói khai `HARD` ·
 * chính sách khác `SOFT_ONLY` — và đã vượt cả phần cho vượt thêm (grace). Số dùng CHƯA BIẾT không bao giờ chặn.
 *
 * Model đắt ⇒ chỉ ĐỀ XUẤT model rẻ hơn (`suggestCheaperModel`); không hàm nào ở đây đổi model của AI đang chạy.
 */
import { QUOTA_SPEC, type LimitMode, type OveragePolicy, type QuotaKey } from "@/lib/pricing/catalog";

export type Enforcement = "OFF" | "SOFT" | "HARD";
export const ENFORCEMENTS = ["OFF", "SOFT", "HARD"] as const satisfies readonly Enforcement[];
export const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  OFF: "Tắt — không nhắc, không chặn",
  SOFT: "Mềm — nhắc, KHÔNG chặn (mặc định)",
  HARD: "Cứng — chặn khi vượt (chỉ khi công tắc trần cứng của nền tảng bật)",
};

export type GuardConfig = {
  noticePct: number;
  warnPct: number;
  limitPct: number;
  /** Chi phí AI hôm nay ≥ trung vị × hệ số này (và hơn trung vị ít nhất `spikeMinUsd`) ⇒ bất thường. */
  spikeMultiplier: number;
  spikeMinUsd: number;
  /** Dưới bấy nhiêu ngày lịch sử ⇒ CHƯA BIẾT, không kết luận "bình thường" (cùng tinh thần luật 52). */
  spikeMinDays: number;
  /** Công tắc trần cứng của CẢ nền tảng. Mặc định TẮT — migration 0222 không bật chặn ở đâu cả. */
  hardLimitsEnabled: boolean;
  /** Chỉ đề xuất đổi model khi tiết kiệm ước tính ≥ bấy nhiêu %. */
  routingMinSavingsPct: number;
};

export const DEFAULT_GUARD_CONFIG: GuardConfig = { noticePct: 50, warnPct: 80, limitPct: 100, spikeMultiplier: 3, spikeMinUsd: 0.5, spikeMinDays: 5, hardLimitsEnabled: false, routingMinSavingsPct: 30 };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numIn = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined);

/**
 * Ghi đè THƯA (`platform_settings` · `platform.pricing.guard`). Bộ ngưỡng phải TĂNG DẦN (notice < warn ≤ limit); bộ sai thứ
 * tự bị bỏ NGUYÊN CẢ BỘ — sửa hộ một ô là đoán ý người nhập (cùng luật 54).
 */
export function parseGuardConfig(raw: unknown): GuardConfig {
  const r = isRec(raw) ? raw : {};
  const out: GuardConfig = { ...DEFAULT_GUARD_CONFIG };
  const notice = numIn(r.noticePct, 1, 99) ?? out.noticePct;
  const warn = numIn(r.warnPct, 1, 100) ?? out.warnPct;
  const limit = numIn(r.limitPct, 50, 500) ?? out.limitPct;
  if (notice < warn && warn <= limit) Object.assign(out, { noticePct: notice, warnPct: warn, limitPct: limit });
  out.spikeMultiplier = numIn(r.spikeMultiplier, 1.5, 50) ?? out.spikeMultiplier;
  out.spikeMinUsd = numIn(r.spikeMinUsd, 0, 1000) ?? out.spikeMinUsd;
  out.spikeMinDays = numIn(r.spikeMinDays, 3, 60) ?? out.spikeMinDays;
  out.routingMinSavingsPct = numIn(r.routingMinSavingsPct, 5, 95) ?? out.routingMinSavingsPct;
  if (typeof r.hardLimitsEnabled === "boolean") out.hardLimitsEnabled = r.hardLimitsEnabled;
  return out;
}

export type QuotaLevel = "UNDECLARED" | "UNLIMITED" | "UNKNOWN" | "OK" | "NOTICE" | "WARN" | "LIMIT";
export type QuotaAction = "NONE" | "NOTIFY" | "WARN" | "BILL_OVERAGE" | "REQUIRE_UPGRADE" | "BLOCK";

export const QUOTA_LEVEL_LABEL: Record<QuotaLevel, string> = {
  UNDECLARED: "Gói chưa khai",
  UNLIMITED: "Không giới hạn",
  UNKNOWN: "Chưa đo được",
  OK: "Bình thường",
  NOTICE: "Đã dùng một nửa",
  WARN: "Sắp hết",
  LIMIT: "Đã hết hạn mức",
};

export type QuotaVerdict = {
  key: QuotaKey;
  used: number | null;
  included: number | null | undefined;
  /** Phần trăm đã dùng; `null` khi không tính được (chưa biết · không giới hạn · gói cho 0). */
  pct: number | null;
  level: QuotaLevel;
  action: QuotaAction;
  blocked: boolean;
  /** Ngưỡng chặn thật = hạn mức × (1 + phần cho vượt thêm). `null` khi không có trần. */
  graceLimit: number | null;
  overageUnits: number;
  /** Tiền vượt ước tính; `null` = không áp dụng HOẶC chưa khai đơn giá (xem `message`). */
  overageVnd: number | null;
  message: string | null;
};

const fmt = (n: number) => n.toLocaleString("vi-VN");

/** Dòng hiển thị dễ hiểu — "3.245 / 5.000 hội thoại AI". */
export function usageLine(key: QuotaKey, used: number | null, included: number | null | undefined): string {
  const unit = QUOTA_SPEC[key].unit;
  const u = used === null ? "—" : fmt(used);
  if (included === undefined) return `${u} ${unit} (gói chưa khai hạn mức)`;
  if (included === null) return `${u} ${unit} (không giới hạn)`;
  return `${u} / ${fmt(included)} ${unit}`;
}

/**
 * PHÁN QUYẾT DUY NHẤT cho một ô hạn mức. `delta` = số đơn vị sắp dùng thêm (hỏi trước một thao tác); 0 = chỉ xem.
 * Lượt sắp tới bị chặn khi `used + max(1, delta) > graceLimit` — và chỉ khi đủ bốn điều kiện ở đầu tệp.
 */
export function evaluateQuota(input: {
  key: QuotaKey;
  used: number | null;
  included: number | null | undefined;
  policy: OveragePolicy;
  unitPriceVnd?: number | null;
  graceAllowancePct: number;
  limitMode: LimitMode;
  enforcement: Enforcement;
  config: GuardConfig;
  delta?: number;
}): QuotaVerdict {
  const { key, used, included, config } = input;
  const base = { key, used, included };
  const quiet = (level: QuotaLevel, pct: number | null = null): QuotaVerdict => ({ ...base, pct, level, action: "NONE", blocked: false, graceLimit: null, overageUnits: 0, overageVnd: null, message: null });
  if (included === undefined) return quiet("UNDECLARED");
  if (included === null) return quiet("UNLIMITED");
  if (used === null) return quiet("UNKNOWN");
  const pct = included > 0 ? (used / included) * 100 : null;
  const level: QuotaLevel = included === 0 ? (used > 0 ? "LIMIT" : "OK") : pct! >= config.limitPct ? "LIMIT" : pct! >= config.warnPct ? "WARN" : pct! >= config.noticePct ? "NOTICE" : "OK";
  const grace = Math.max(0, Math.min(50, Math.trunc(input.graceAllowancePct)));
  const graceLimit = Math.floor(included * (1 + grace / 100));
  const overageUnits = Math.max(0, used - included);
  const line = usageLine(key, used, included);
  if (input.enforcement === "OFF") return { ...base, pct, level, action: "NONE", blocked: false, graceLimit, overageUnits, overageVnd: null, message: null };
  const hard = config.hardLimitsEnabled && input.enforcement === "HARD" && input.limitMode === "HARD" && input.policy !== "SOFT_ONLY";
  const blocked = hard && used + Math.max(1, Math.trunc(input.delta ?? 0)) > graceLimit;
  if (blocked) return { ...base, pct, level: "LIMIT", action: "BLOCK", blocked: true, graceLimit, overageUnits, overageVnd: null, message: `${line} — đã vượt trần cứng của gói. Nâng gói hoặc nhờ người vận hành nới hạn mức.` };
  if (level === "LIMIT") {
    if (input.policy === "REQUIRE_UPGRADE") return { ...base, pct, level, action: "REQUIRE_UPGRADE", blocked: false, graceLimit, overageUnits, overageVnd: null, message: `${line} — đã hết hạn mức của gói. Nâng gói để dùng thoải mái; AI vẫn đang chạy.` };
    if (input.policy === "BILL_OVERAGE") {
      const price = input.unitPriceVnd && input.unitPriceVnd > 0 ? input.unitPriceVnd : null;
      return price
        ? { ...base, pct, level, action: "BILL_OVERAGE", blocked: false, graceLimit, overageUnits, overageVnd: overageUnits * price, message: `${line} — phần vượt ${fmt(overageUnits)} ${QUOTA_SPEC[key].unit} tính ${fmt(price)} ₫ mỗi đơn vị.` }
        : { ...base, pct, level, action: "WARN", blocked: false, graceLimit, overageUnits, overageVnd: null, message: `${line} — đã vượt; gói chưa khai đơn giá phần vượt nên CHƯA thu được tiền vượt.` };
    }
    return { ...base, pct, level, action: "WARN", blocked: false, graceLimit, overageUnits, overageVnd: null, message: `${line} — đã vượt hạn mức (chỉ nhắc).` };
  }
  if (level === "WARN") return { ...base, pct, level, action: "WARN", blocked: false, graceLimit, overageUnits, overageVnd: null, message: `${line} — sắp hết hạn mức tháng này.` };
  if (level === "NOTICE") return { ...base, pct, level, action: "NOTIFY", blocked: false, graceLimit, overageUnits, overageVnd: null, message: `${line} — đã dùng hơn một nửa.` };
  return { ...base, pct, level, action: "NONE", blocked: false, graceLimit, overageUnits, overageVnd: null, message: null };
}

/** Mức nặng nhất trong các ô (để tô một dải tóm tắt). */
const LEVEL_RANK: Record<QuotaLevel, number> = { UNDECLARED: 0, UNLIMITED: 0, UNKNOWN: 0, OK: 1, NOTICE: 2, WARN: 3, LIMIT: 4 };
export function worstLevel(levels: readonly QuotaLevel[]): QuotaLevel {
  return levels.reduce<QuotaLevel>((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), "OK");
}

/** Mức dùng credit AI của nền tảng (tiền nền tảng trả) theo CÙNG ngưỡng. Trần cứng của credit vẫn là `evaluateAiQuota` (0176). */
export function aiCreditLevel(costUsdMonth: number, creditUsd: number, unpricedCalls: number, config: GuardConfig): { level: QuotaLevel; pct: number | null; note: string | null } {
  if (!(creditUsd > 0)) return { level: "UNLIMITED", pct: null, note: "Gói không có credit AI của nền tảng (khách dùng khoá AI riêng hoặc gói không bán AI dùng chung)." };
  const pct = (costUsdMonth / creditUsd) * 100;
  const level: QuotaLevel = pct >= config.limitPct ? "LIMIT" : pct >= config.warnPct ? "WARN" : pct >= config.noticePct ? "NOTICE" : "OK";
  return { level, pct, note: unpricedCalls > 0 ? `${fmt(unpricedCalls)} lời gọi chưa định giá được — phần trăm thật có thể cao hơn.` : null };
}

// ─────────────────────────── Chi phí AI tăng bất thường ───────────────────────────

export type SpikeVerdict = { state: "UNKNOWN" | "NORMAL" | "SPIKE"; todayUsd: number; medianUsd: number | null; ratio: number | null; days: number; message: string | null };

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * So chi phí AI HÔM NAY với TRUNG VỊ các ngày trước (trung vị: một ngày bão đơn không kéo nền lên). `history` = chi phí từng
 * ngày (đủ ngày, ngày không dùng là 0). Dưới `spikeMinDays` ngày ⇒ CHƯA BIẾT — không có nền thì không kết luận "bình thường".
 */
export function detectCostSpike(history: readonly number[], todayUsd: number, config: GuardConfig): SpikeVerdict {
  const days = history.length;
  if (days < config.spikeMinDays) return { state: "UNKNOWN", todayUsd, medianUsd: null, ratio: null, days, message: `Chưa đủ ${config.spikeMinDays} ngày lịch sử để so.` };
  const med = median(history);
  const ratio = med > 0 ? todayUsd / med : null;
  const spike = todayUsd - med >= config.spikeMinUsd && (med === 0 || todayUsd >= med * config.spikeMultiplier);
  return {
    state: spike ? "SPIKE" : "NORMAL",
    todayUsd,
    medianUsd: med,
    ratio,
    days,
    message: spike ? `Chi phí AI hôm nay ${todayUsd.toFixed(2)} USD — ${ratio === null ? "các ngày trước gần như 0" : `gấp ${ratio.toFixed(1)} lần trung vị ${med.toFixed(2)} USD`}.` : null,
  };
}

// ─────────────────────────── Đề xuất model rẻ hơn (KHÔNG tự đổi) ───────────────────────────

export type ModelPrice = { input: number; output: number };
export type RoutingSuggestion = { from: string; to: string; currentUsd: number; altUsd: number; savingsPct: number; note: string };

const familyOf = (model: string) => model.split("-")[0] ?? model;

/**
 * Với lượng token THẬT của một model trong kỳ, có model CÙNG HỌ nào trong bảng giá rẻ hơn ≥ `minSavingsPct` không. Chỉ là
 * ĐỀ XUẤT có nhãn: chất lượng trả lời chưa được so, và đổi model là quyết định của người vận hành (cấu hình AI của tổ chức).
 */
export function suggestCheaperModel(input: { model: string; inputTokens: number; outputTokens: number; prices: Readonly<Record<string, ModelPrice>>; priceKeyOf: (model: string) => string | null; minSavingsPct: number }): RoutingSuggestion | null {
  const key = input.priceKeyOf(input.model);
  if (!key || !(input.inputTokens + input.outputTokens > 0)) return null;
  const cost = (p: ModelPrice) => (input.inputTokens * p.input + input.outputTokens * p.output) / 1_000_000;
  const current = cost(input.prices[key]);
  if (!(current > 0)) return null;
  let best: { to: string; usd: number } | null = null;
  for (const [m, p] of Object.entries(input.prices)) {
    if (m === key || familyOf(m) !== familyOf(key)) continue;
    const usd = cost(p);
    if (!best || usd < best.usd) best = { to: m, usd };
  }
  if (!best) return null;
  const savingsPct = ((current - best.usd) / current) * 100;
  if (savingsPct < input.minSavingsPct) return null;
  return { from: key, to: best.to, currentUsd: current, altUsd: best.usd, savingsPct, note: "ĐỀ XUẤT — ước tính theo bảng giá (ESTIMATED), chưa so chất lượng trả lời; hệ thống không tự đổi model." };
}
