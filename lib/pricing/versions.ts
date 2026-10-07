/**
 * ═══════════ BẢNG GIÁ CÓ PHIÊN BẢN + PHẦN VƯỢT + CẢNH BÁO DÙNG — HÀM THUẦN, CLIENT-SAFE (docs/saas/PRICING_V1.md) ═══════════
 *
 *   Usage Event → Usage Ledger → Aggregation → PRICING RULES (tệp này) → Billable Usage → Invoice / Internal Chargeback
 *
 * Không đọc CSDL, không đọc đồng hồ: cùng đầu vào ⇒ cùng kết quả. Đọc / ghi bảng nằm ở `lib/pricing/price-book.ts`.
 *
 *  · PHIÊN BẢN (`platform_price_versions`): `LEGACY_SNAPSHOT` = ảnh chụp giá đang thu lúc 0228, chỉ tới được bằng GHIM;
 *    `CATALOG` = bảng giá niêm yết, hiệu lực từ `effective_from`. Tổ chức không có ghim ⇒ phiên bản CATALOG mới nhất ĐÃ hiệu
 *    lực. Giá tương lai đổi = THÊM phiên bản — dòng cũ không bao giờ bị sửa, nên tính lại một kỳ cũ ra đúng số cũ.
 *  · Gói không có trong phiên bản của tổ chức (gói cũ basic · pro… mà một tổ chức vẫn đang dùng) ⇒ đọc dòng LEGACY của gói
 *    đó: gói cũ không niêm yết nữa nhưng thuê bao đang dùng GIỮ giá của nó.
 *  · ĐỒNG HỒ THU CHÍNH = khách AI (`aiCustomers`). Hội thoại / trả lời AI là FAIR-USE (cờ + cảnh báo, KHÔNG BAO GIỜ sinh
 *    phí). ĐƠN không bao giờ sinh phí. Số dùng chưa biết ⇒ phần vượt chưa biết (`null`), không phải 0 (luật 42).
 *  · KHÔNG hàm nào ở đây tắt bot: `pauseBot` là hằng `false` trong kiểu trả về.
 */
import type { AiLimits } from "@/lib/ai-usage/types";
import { billedMonths } from "@/lib/billing/rules";
import { parseFeatureList, type FeatureKey } from "@/lib/pricing/features";

export const PRICE_VERSION_KINDS = ["LEGACY_SNAPSHOT", "CATALOG"] as const;
export type PriceVersionKind = (typeof PRICE_VERSION_KINDS)[number];
export const LEGACY_VERSION_KEY = "legacy";

export const TAX_MODES = ["UNDECLARED", "EXCLUSIVE", "INCLUSIVE"] as const;
export type TaxMode = (typeof TAX_MODES)[number];
export const TAX_MODE_LABEL: Record<TaxMode, string> = {
  UNDECLARED: "Chưa áp thuế — không giả định VAT",
  EXCLUSIVE: "Giá chưa gồm thuế",
  INCLUSIVE: "Giá đã gồm thuế",
};

// ─────────────────────────── Ngưỡng cảnh báo dùng (80 · 100 · 120 · 150) ───────────────────────────

/**
 * Ngưỡng theo % hạn mức khách AI gồm trong gói — chủ shop chốt 07/10/2026 (docs/saas/PRICING_V1.md §5). Khai theo PHIÊN BẢN
 * (`alert_thresholds`); ô thiếu lấy mặc định này. Bộ không tăng dần bị bỏ NGUYÊN CẢ BỘ (sửa hộ một ô là đoán — luật 54).
 */
export type UsageAlertConfig = { notifyPct: number; overagePct: number; strongPct: number; reviewPct: number };
export const DEFAULT_USAGE_ALERTS: UsageAlertConfig = { notifyPct: 80, overagePct: 100, strongPct: 120, reviewPct: 150 };

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numIn = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
const intIn = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
/** Ô tiền / số đếm đọc từ jsonb hoặc bigint (pg trả chuỗi cho bigint ở vài đường) — sai kiểu ⇒ `undefined`. */
const intish = (v: unknown, min: number, max: number): number | undefined => {
  if (typeof v === "string" && /^\d+$/.test(v)) return intIn(Number(v), min, max);
  return intIn(v, min, max);
};

export function parseUsageAlerts(raw: unknown): UsageAlertConfig {
  const r = isRec(raw) ? raw : {};
  const next: UsageAlertConfig = {
    notifyPct: numIn(r.notifyPct, 1, 99) ?? DEFAULT_USAGE_ALERTS.notifyPct,
    overagePct: numIn(r.overagePct, 50, 200) ?? DEFAULT_USAGE_ALERTS.overagePct,
    strongPct: numIn(r.strongPct, 50, 500) ?? DEFAULT_USAGE_ALERTS.strongPct,
    reviewPct: numIn(r.reviewPct, 50, 1000) ?? DEFAULT_USAGE_ALERTS.reviewPct,
  };
  return next.notifyPct < next.overagePct && next.overagePct < next.strongPct && next.strongPct < next.reviewPct ? next : { ...DEFAULT_USAGE_ALERTS };
}

// ─────────────────────────── Phiên bản + giá gói ───────────────────────────

export type PriceVersion = { key: string; label: string; kind: PriceVersionKind; effectiveFrom: Date | null; taxMode: TaxMode; taxNote: string | null; alerts: UsageAlertConfig; note: string | null };

export const INCLUDED_KEYS = ["aiCustomers", "fanpages", "users", "aiConversations", "aiReplies", "orders"] as const;
export type IncludedKey = (typeof INCLUDED_KEYS)[number];
/** `null` = không giới hạn · `undefined` = CHƯA KHAI. */
export type Included = Record<IncludedKey, number | null | undefined>;

export const INCLUDED_SPEC: Record<IncludedKey, { label: string; unit: string; billing: "PRIMARY" | "SEAT" | "FAIR_USE" | "NEVER" }> = {
  aiCustomers: { label: "Khách AI", unit: "khách AI", billing: "PRIMARY" },
  fanpages: { label: "Fanpage", unit: "fanpage", billing: "SEAT" },
  users: { label: "Người dùng", unit: "người dùng", billing: "SEAT" },
  aiConversations: { label: "Hội thoại AI (fair-use)", unit: "hội thoại", billing: "FAIR_USE" },
  aiReplies: { label: "Trả lời AI (fair-use)", unit: "câu trả lời", billing: "FAIR_USE" },
  orders: { label: "Đơn", unit: "đơn", billing: "NEVER" },
};

/** `BILLED` tính phần vượt theo đơn giá · `CONTRACT` theo hợp đồng (không tự tính) · `NONE` không có phần vượt · `UNDECLARED` chưa khai. */
export type OverageMode = "BILLED" | "CONTRACT" | "NONE" | "UNDECLARED";
export type OverageSpec = { mode: OverageMode; aiCustomerBlockSize: number | null; aiCustomerBlockVnd: number | null; extraFanpageVnd: number | null; extraUserVnd: number | null };

export const OVERAGE_PRICE_MAX_VND = 10_000_000;

export type PlanPrice = {
  versionKey: string;
  planKey: string;
  name: string;
  description: string | null;
  position: number;
  listed: boolean;
  highlight: boolean;
  contactSales: boolean;
  /** Giá MỘT tháng; `null` = không tự mua (dùng thử · hợp đồng · gói không bán). */
  monthlyVnd: number | null;
  /** Giá 12 tháng tường minh; `null` = giá tháng × (12 − tặng tháng). */
  yearlyVnd: number | null;
  yearlyFreeMonths: number;
  priceFromVnd: number | null;
  trialDays: number | null;
  included: Included;
  overage: OverageSpec;
  /** `null` = CHƯA KHAI. */
  features: FeatureKey[] | null;
  addonPrices: unknown;
  limits: Record<string, unknown>;
  commercial: Record<string, unknown>;
};

export type PriceBook = { versions: readonly PriceVersion[]; prices: readonly PlanPrice[] };

export function parsePriceVersion(row: { key: string; label: string; kind: string; effectiveFrom: Date | string | null; taxMode: string; taxNote: string | null; alertThresholds: unknown; note: string | null }): PriceVersion {
  const kind: PriceVersionKind = row.kind === "CATALOG" ? "CATALOG" : "LEGACY_SNAPSHOT";
  const at = row.effectiveFrom ? new Date(row.effectiveFrom) : null;
  return {
    key: row.key,
    label: row.label,
    kind,
    effectiveFrom: at && Number.isFinite(at.getTime()) ? at : null,
    taxMode: (TAX_MODES as readonly string[]).includes(row.taxMode) ? (row.taxMode as TaxMode) : "UNDECLARED",
    taxNote: row.taxNote ?? null,
    alerts: parseUsageAlerts(row.alertThresholds),
    note: row.note ?? null,
  };
}

function parseIncluded(raw: unknown): Included {
  const r = isRec(raw) ? raw : {};
  const out = {} as Included;
  for (const k of INCLUDED_KEYS) {
    if (!(k in r)) out[k] = undefined;
    else if (r[k] === null) out[k] = null;
    else out[k] = intIn(r[k], 0, 100_000_000);
  }
  return out;
}

function parseOverage(raw: unknown): OverageSpec {
  const r = isRec(raw) ? raw : {};
  const mode: OverageMode = r.mode === "BILLED" || r.mode === "CONTRACT" || r.mode === "NONE" ? r.mode : "UNDECLARED";
  return {
    mode,
    aiCustomerBlockSize: intIn(r.aiCustomerBlockSize, 1, 100_000) ?? null,
    aiCustomerBlockVnd: intIn(r.aiCustomerBlockVnd, 1, OVERAGE_PRICE_MAX_VND) ?? null,
    extraFanpageVnd: intIn(r.extraFanpageVnd, 1, OVERAGE_PRICE_MAX_VND) ?? null,
    extraUserVnd: intIn(r.extraUserVnd, 1, OVERAGE_PRICE_MAX_VND) ?? null,
  };
}

export type PlanPriceRow = {
  versionKey: string;
  planKey: string;
  name: string;
  description: string | null;
  position: number;
  listed: boolean;
  highlight: boolean;
  contactSales: boolean;
  monthlyVnd: number | string | null;
  yearlyVnd: number | string | null;
  yearlyFreeMonths: number;
  priceFromVnd: number | string | null;
  trialDays: number | null;
  included: unknown;
  overage: unknown;
  features: unknown;
  addonPrices: unknown;
  limits: unknown;
  commercial: unknown;
};

/** Đọc một dòng `platform_plan_prices`. Sai kiểu ⇒ ô đó CHƯA KHAI, không bao giờ ném. */
export function parsePlanPrice(row: PlanPriceRow): PlanPrice {
  return {
    versionKey: row.versionKey,
    planKey: row.planKey,
    name: row.name,
    description: row.description ?? null,
    position: row.position ?? 0,
    listed: row.listed === true,
    highlight: row.highlight === true,
    contactSales: row.contactSales === true,
    monthlyVnd: intish(row.monthlyVnd, 1, 1_000_000_000) ?? null,
    yearlyVnd: intish(row.yearlyVnd, 1, 12_000_000_000) ?? null,
    yearlyFreeMonths: intIn(row.yearlyFreeMonths, 0, 6) ?? 0,
    priceFromVnd: intish(row.priceFromVnd, 1, 1_000_000_000) ?? null,
    trialDays: intIn(row.trialDays, 1, 90) ?? null,
    included: parseIncluded(row.included),
    overage: parseOverage(row.overage),
    features: parseFeatureList(row.features),
    addonPrices: row.addonPrices ?? {},
    limits: isRec(row.limits) ? row.limits : {},
    commercial: isRec(row.commercial) ? row.commercial : {},
  };
}

/** Phiên bản CATALOG mới nhất đã hiệu lực lúc `now` (hoà mốc ⇒ khoá lớn hơn). `null` = chưa có bảng giá niêm yết. */
export function currentCatalogVersion(book: PriceBook, now: Date): PriceVersion | null {
  let best: PriceVersion | null = null;
  for (const v of book.versions) {
    if (v.kind !== "CATALOG" || !v.effectiveFrom || v.effectiveFrom.getTime() > now.getTime()) continue;
    if (!best || v.effectiveFrom.getTime() > best.effectiveFrom!.getTime() || (v.effectiveFrom.getTime() === best.effectiveFrom!.getTime() && v.key > best.key)) best = v;
  }
  return best;
}

export type ResolvedVersion = { version: PriceVersion | null; pinned: boolean; note: string | null };

/** Phiên bản của MỘT tổ chức: ghim (nếu ghim trỏ tới phiên bản có thật) ⇒ ngược lại CATALOG đang hiệu lực. */
export function resolveOrgVersion(book: PriceBook, pinKey: string | null | undefined, now: Date): ResolvedVersion {
  if (pinKey) {
    const v = book.versions.find((x) => x.key === pinKey);
    if (v) return { version: v, pinned: true, note: null };
    // Ghim trỏ tới phiên bản không còn ⇒ GIÁ CŨ (legacy), không bao giờ bảng giá hiện hành — đổi giá khách là quyết định của
    // người, không phải hệ quả của một dòng mất.
    return { version: book.versions.find((x) => x.key === LEGACY_VERSION_KEY) ?? null, pinned: true, note: `Ghim trỏ tới phiên bản «${pinKey}» không còn trong sổ — đang đọc giá cũ (legacy), người vận hành cần chuyển phiên bản.` };
  }
  return { version: currentCatalogVersion(book, now), pinned: false, note: null };
}

export type PlanPriceHit = { price: PlanPrice; source: "VERSION" | "LEGACY_FALLBACK" };

/** Giá của gói `planKey` theo phiên bản `versionKey`; gói không có trong phiên bản ⇒ dòng LEGACY của nó (gói cũ còn người dùng). */
export function priceOf(book: PriceBook, versionKey: string | null | undefined, planKey: string): PlanPriceHit | null {
  if (versionKey) {
    const own = book.prices.find((p) => p.versionKey === versionKey && p.planKey === planKey);
    if (own) return { price: own, source: "VERSION" };
  }
  const legacy = book.prices.find((p) => p.versionKey === LEGACY_VERSION_KEY && p.planKey === planKey);
  return legacy ? { price: legacy, source: versionKey === LEGACY_VERSION_KEY ? "VERSION" : "LEGACY_FALLBACK" } : null;
}

/** Gói TỰ MUA được trong một phiên bản: có giá tháng, không phải gói hợp đồng. */
export function isSellable(p: PlanPrice): boolean {
  return p.monthlyVnd !== null && p.monthlyVnd > 0 && !p.contactSales;
}

/** Giá trả 12 tháng: tường minh nếu khai, không thì CÙNG phép tính với hoá đơn (`billedMonths`). */
export function yearlyAmountVnd(p: Pick<PlanPrice, "monthlyVnd" | "yearlyVnd" | "yearlyFreeMonths">): number | null {
  if (p.yearlyVnd !== null) return p.yearlyVnd;
  if (p.monthlyVnd === null || !(p.monthlyVnd > 0)) return null;
  return p.monthlyVnd * billedMonths(12, p.yearlyFreeMonths);
}

/**
 * Dòng gói "như hoá đơn đọc" sau khi áp phiên bản — CÙNG hình dạng `PlanRow` (lib/entitlements/check.ts) để mọi đường đọc
 * giá cũ đổi một dòng là xong. Phiên bản LEGACY chỉ thay GIÁ (giá tháng, tặng tháng, mua thêm) — hạn mức kỹ thuật và phần
 * thương mại của gói cũ vẫn là dòng `platform_plans` người vận hành đang sửa. Phiên bản CATALOG thay cả tên, phần thương
 * mại (tính năng · hạn mức tháng) và số người dùng gồm. Không có dòng giá ⇒ gói KHÔNG BÁN ở phiên bản này.
 */
export type PlanRowLike = { key: string; name: string; description: string | null; limits: unknown; position: number; priceVnd: number | null; addonPrices: unknown; yearlyFreeMonths: number; commercial: unknown };
export type PricedPlanRow<T extends PlanRowLike = PlanRowLike> = T & { yearlyPriceVnd: number | null; priceFromVnd: number | null; priceVersionKey: string | null; priceSource: "VERSION" | "LEGACY_FALLBACK" | "NONE"; planPrice: PlanPrice | null };

export function overlayPlanRow<T extends PlanRowLike>(row: T, hit: PlanPriceHit | null, kind: PriceVersionKind | null): PricedPlanRow<T> {
  if (!hit) return { ...row, priceVnd: null, addonPrices: {}, yearlyPriceVnd: null, priceFromVnd: null, priceVersionKey: null, priceSource: "NONE", planPrice: null };
  const p = hit.price;
  const priced = { priceVnd: p.monthlyVnd, yearlyFreeMonths: p.yearlyFreeMonths, addonPrices: p.addonPrices, yearlyPriceVnd: yearlyAmountVnd(p), priceFromVnd: p.priceFromVnd, priceVersionKey: p.versionKey, priceSource: hit.source, planPrice: p } as const;
  const catalog = kind === "CATALOG" && hit.source === "VERSION";
  if (!catalog) return { ...row, ...priced };
  const lim = isRec(row.limits) ? row.limits : {};
  const users = p.included.users;
  return {
    ...row,
    ...priced,
    name: p.name,
    description: p.description,
    position: p.position,
    limits: users === undefined ? lim : { ...lim, users },
    commercial: Object.keys(p.commercial).length ? p.commercial : row.commercial,
  };
}

// ─────────────────────────── Báo giá gia hạn: phiên bản nào ───────────────────────────

export type RenewalPricing = { current: PlanPrice | null; target: PlanPrice; targetVersionKey: string } | { error: string };

/**
 * Gia hạn ĐÚNG gói đang dùng ⇒ giá của phiên bản đã ghim (khách hiện tại không đổi số tiền). Đổi sang gói khác / mua lần
 * đầu ⇒ giá của bảng giá đang hiệu lực (gói cũ không còn niêm yết thì không mua mới được). Phần trừ khi nâng gói tính theo
 * giá ghim của gói đang dùng.
 */
export function renewalPricing(input: { book: PriceBook; pinKey: string | null; now: Date; currentPlanKey: string | null; targetPlanKey: string }): RenewalPricing {
  const resolved = resolveOrgVersion(input.book, input.pinKey, input.now);
  const current = input.currentPlanKey ? (priceOf(input.book, resolved.version?.key, input.currentPlanKey)?.price ?? null) : null;
  if (input.currentPlanKey === input.targetPlanKey && current && isSellable(current)) return { current, target: current, targetVersionKey: current.versionKey };
  const catalog = currentCatalogVersion(input.book, input.now);
  if (!catalog) return { error: "Nền tảng chưa có bảng giá niêm yết — báo người vận hành." };
  const target = input.book.prices.find((p) => p.versionKey === catalog.key && p.planKey === input.targetPlanKey);
  if (!target) return { error: "Gói này không còn bán — chọn một gói trong bảng giá hiện hành." };
  if (!isSellable(target)) return { error: target.contactSales ? `Gói «${target.name}» ký theo hợp đồng — liên hệ để báo giá.` : `Gói «${target.name}» không bán — chọn một gói có giá.` };
  return { current, target, targetVersionKey: catalog.key };
}

// ─────────────────────────── Cảnh báo dùng ───────────────────────────

export type UsageAlertLevel = "UNKNOWN" | "UNDECLARED" | "UNLIMITED" | "NOT_INCLUDED" | "OK" | "NOTIFY" | "OVERAGE" | "STRONG" | "REVIEW";
export const USAGE_ALERT_LABEL: Record<UsageAlertLevel, string> = {
  UNKNOWN: "Chưa đo được",
  UNDECLARED: "Gói chưa khai",
  UNLIMITED: "Không giới hạn",
  NOT_INCLUDED: "Gói không gồm",
  OK: "Bình thường",
  NOTIFY: "Sắp hết hạn mức",
  OVERAGE: "Đang tính phần vượt",
  STRONG: "Vượt nhiều — nên nâng gói",
  REVIEW: "Người vận hành rà soát",
};

export type UsageAlert = {
  level: UsageAlertLevel;
  pct: number | null;
  notifyCustomer: boolean;
  notifyOperator: boolean;
  overageBilling: boolean;
  suggestUpgrade: boolean;
  operatorReview: boolean;
  /** Không ngưỡng nào tắt bot — hằng, để kiểu dữ liệu tự khẳng định điều đó. */
  pauseBot: false;
};

/** Mức cảnh báo của MỘT hạn mức. ≥ 80% báo khách + vận hành · ≥ 100% tính phần vượt · ≥ 120% đề xuất nâng gói · ≥ 150% rà soát. */
export function usageAlert(used: number | null, included: number | null | undefined, cfg: UsageAlertConfig = DEFAULT_USAGE_ALERTS): UsageAlert {
  const quiet = (level: UsageAlertLevel, pct: number | null = null): UsageAlert => ({ level, pct, notifyCustomer: false, notifyOperator: false, overageBilling: false, suggestUpgrade: false, operatorReview: false, pauseBot: false });
  if (included === undefined) return quiet("UNDECLARED");
  if (included === null) return quiet("UNLIMITED");
  if (used === null) return quiet("UNKNOWN");
  if (included === 0) return used > 0 ? { ...quiet("NOT_INCLUDED"), notifyOperator: true, suggestUpgrade: true } : quiet("NOT_INCLUDED");
  const pct = (used / included) * 100;
  if (pct >= cfg.reviewPct) return { level: "REVIEW", pct, notifyCustomer: true, notifyOperator: true, overageBilling: true, suggestUpgrade: true, operatorReview: true, pauseBot: false };
  if (pct >= cfg.strongPct) return { level: "STRONG", pct, notifyCustomer: true, notifyOperator: true, overageBilling: true, suggestUpgrade: true, operatorReview: false, pauseBot: false };
  if (pct > cfg.overagePct) return { level: "OVERAGE", pct, notifyCustomer: true, notifyOperator: true, overageBilling: true, suggestUpgrade: false, operatorReview: false, pauseBot: false };
  if (pct >= cfg.notifyPct) return { level: "NOTIFY", pct, notifyCustomer: true, notifyOperator: true, overageBilling: false, suggestUpgrade: false, operatorReview: false, pauseBot: false };
  return quiet("OK", pct);
}

/** Fair-use: hội thoại + trả lời AI. CHỈ cờ + cảnh báo — `billable` là hằng `false`. Vượt mức rà soát ⇒ giữ bằng chứng. */
export type FairUseVerdict = { conversations: UsageAlert; replies: UsageAlert; flagged: boolean; review: boolean; billable: false; note: string | null };

export function fairUseVerdict(used: { aiConversations: number | null; aiReplies: number | null }, included: Pick<Included, "aiConversations" | "aiReplies">, cfg: UsageAlertConfig = DEFAULT_USAGE_ALERTS): FairUseVerdict {
  const conversations = usageAlert(used.aiConversations, included.aiConversations, cfg);
  const replies = usageAlert(used.aiReplies, included.aiReplies, cfg);
  const over = (a: UsageAlert) => a.level === "OVERAGE" || a.level === "STRONG" || a.level === "REVIEW" || (a.level === "NOT_INCLUDED" && a.notifyOperator);
  const flagged = over(conversations) || over(replies);
  const review = conversations.operatorReview || replies.operatorReview;
  return {
    conversations,
    replies,
    flagged,
    review,
    billable: false,
    note: review ? "Mật độ dùng AI vượt xa mức fair-use — người vận hành rà soát, giữ bằng chứng (bảng kê kỳ chốt), đề xuất nâng gói / gói riêng. Không thu thêm phí." : flagged ? "Đã vượt mức fair-use — chỉ nhắc, không thu thêm phí." : null,
  };
}

// ─────────────────────────── Phần vượt ───────────────────────────

export type MeterCoverage = "MEASURED" | "PARTIAL" | "NOT_MEASURED";
export const METER_COVERAGE_LABEL: Record<MeterCoverage, string> = { MEASURED: "Đo trọn kỳ", PARTIAL: "Đo chưa trọn kỳ (cận dưới)", NOT_MEASURED: "Chưa đo" };

export type BillableUsage = {
  aiCustomers: number | null;
  aiCustomersCoverage: MeterCoverage;
  fanpages: number | null;
  users: number | null;
  aiConversations: number | null;
  aiReplies: number | null;
  /** Số đơn chỉ để hiển thị — KHÔNG BAO GIỜ vào phép tính phần vượt. */
  orders?: number | null;
};

export type OverageLineKey = "aiCustomers" | "fanpages" | "users";
export type OverageLine = { key: OverageLineKey; label: string; used: number | null; included: number | null | undefined; overUnits: number | null; blocks: number | null; unitVnd: number | null; amountVnd: number | null; note: string | null };
export type OverageResult = { mode: OverageMode; lines: OverageLine[]; totalVnd: number | null; knownVnd: number; unknownLines: number; note: string | null };

/** Khối khách AI vượt: `ceil(max(0, dùng − gồm) / cỡ khối)`. Chưa biết ⇒ `null`; gồm không giới hạn ⇒ 0. */
export function aiCustomerBlocks(used: number | null, included: number | null | undefined, blockSize: number): { overUnits: number | null; blocks: number | null } {
  if (used === null || included === undefined || !(blockSize > 0)) return { overUnits: null, blocks: null };
  if (included === null) return { overUnits: 0, blocks: 0 };
  const over = Math.max(0, used - included);
  return { overUnits: over, blocks: Math.ceil(over / blockSize) };
}

function seatLine(key: "fanpages" | "users", used: number | null, included: number | null | undefined, unitVnd: number | null): OverageLine {
  const label = key === "fanpages" ? "Fanpage thêm" : "Người dùng thêm";
  if (included === null) return { key, label, used, included, overUnits: 0, blocks: null, unitVnd, amountVnd: 0, note: null };
  if (included === undefined) return { key, label, used, included, overUnits: null, blocks: null, unitVnd, amountVnd: null, note: "gói chưa khai số gồm" };
  if (used === null) return { key, label, used, included, overUnits: null, blocks: null, unitVnd, amountVnd: null, note: "chưa đo được số đang dùng" };
  const over = Math.max(0, used - included);
  if (over === 0) return { key, label, used, included, overUnits: 0, blocks: null, unitVnd, amountVnd: 0, note: null };
  if (unitVnd === null) return { key, label, used, included, overUnits: over, blocks: null, unitVnd, amountVnd: null, note: "phiên bản giá chưa khai đơn giá" };
  return { key, label, used, included, overUnits: over, blocks: null, unitVnd, amountVnd: over * unitVnd, note: null };
}

/**
 * PHẦN VƯỢT của một kỳ theo giá gói (phiên bản đã ghim). Khách AI tính theo KHỐI; fanpage / người dùng thêm × đơn giá.
 * Hội thoại, trả lời AI, đơn KHÔNG có dòng nào ở đây. Đồng hồ khách AI đo chưa trọn kỳ ⇒ dòng đó `null` (cận dưới không
 * phải số để thu). Tổng = `null` khi còn dòng chưa biết (`knownVnd` là phần đã biết).
 */
export function computeOverage(price: Pick<PlanPrice, "included" | "overage">, usage: BillableUsage): OverageResult {
  const mode = price.overage.mode;
  if (mode === "CONTRACT") return { mode, lines: [], totalVnd: null, knownVnd: 0, unknownLines: 0, note: "Phần vượt theo hợp đồng riêng — không tự tính." };
  if (mode === "NONE") return { mode, lines: [], totalVnd: 0, knownVnd: 0, unknownLines: 0, note: "Gói này không có phần vượt." };
  if (mode === "UNDECLARED") return { mode, lines: [], totalVnd: null, knownVnd: 0, unknownLines: 1, note: "Phiên bản giá chưa khai cách tính phần vượt." };
  const lines: OverageLine[] = [];
  const inc = price.included.aiCustomers;
  const size = price.overage.aiCustomerBlockSize;
  const unit = price.overage.aiCustomerBlockVnd;
  if (inc !== undefined && inc !== 0 && (size !== null || inc === null)) {
    const measured = usage.aiCustomersCoverage === "MEASURED";
    const b = aiCustomerBlocks(measured ? usage.aiCustomers : null, inc, size ?? 1);
    const note = !measured ? (usage.aiCustomersCoverage === "PARTIAL" ? "đồng hồ khách AI chưa đo trọn kỳ — không tính phần vượt" : "chưa đo được khách AI") : b.blocks && unit === null ? "phiên bản giá chưa khai đơn giá khối" : null;
    lines.push({ key: "aiCustomers", label: `Khách AI vượt (khối ${size ?? "—"})`, used: usage.aiCustomers, included: inc, overUnits: b.overUnits, blocks: b.blocks, unitVnd: unit, amountVnd: b.blocks === null ? null : b.blocks === 0 ? 0 : unit === null ? null : b.blocks * unit, note });
  }
  lines.push(seatLine("fanpages", usage.fanpages, price.included.fanpages, price.overage.extraFanpageVnd));
  lines.push(seatLine("users", usage.users, price.included.users, price.overage.extraUserVnd));
  const known = lines.filter((l) => l.amountVnd !== null);
  const knownVnd = known.reduce((a, l) => a + (l.amountVnd ?? 0), 0);
  const unknownLines = lines.length - known.length;
  return { mode, lines, totalVnd: unknownLines ? null : knownVnd, knownVnd, unknownLines, note: null };
}

/** Hoá đơn ƯỚC TÍNH của kỳ: giá gói tháng + phần vượt. Dùng thử = 0 THẬT; gói hợp đồng / không giá ⇒ `null`. */
export type BillEstimate = { planVnd: number | null; overage: OverageResult; totalVnd: number | null; note: string | null };

export function estimateBill(price: PlanPrice, usage: BillableUsage, opts: { trial: boolean }): BillEstimate {
  const overage = computeOverage(price, usage);
  if (opts.trial) return { planVnd: 0, overage: { ...overage, totalVnd: 0, knownVnd: 0, unknownLines: 0 }, totalVnd: 0, note: "Đang dùng thử — miễn phí theo điều khoản." };
  const planVnd = price.contactSales ? null : price.monthlyVnd;
  const totalVnd = planVnd === null || overage.totalVnd === null ? null : planVnd + overage.totalVnd;
  return { planVnd, overage, totalVnd, note: planVnd === null ? (price.contactSales ? "Theo hợp đồng." : "Gói không niêm yết giá.") : null };
}

// ─────────────────────────── Biên lãi chiếu (khung người vận hành) ───────────────────────────

/** Đích 75–85% · cảnh báo < 70% · nguy cấp < 60% — chủ shop chốt 07/10/2026; ghi đè thưa ở `platform.pricing.margin`. */
export type MarginConfig = { targetLowPct: number; targetHighPct: number; warnBelowPct: number; criticalBelowPct: number };
export const DEFAULT_MARGIN_CONFIG: MarginConfig = { targetLowPct: 75, targetHighPct: 85, warnBelowPct: 70, criticalBelowPct: 60 };

export function parseMarginConfig(raw: unknown): MarginConfig {
  const r = isRec(raw) ? raw : {};
  const next: MarginConfig = {
    targetLowPct: numIn(r.targetLowPct, 0, 100) ?? DEFAULT_MARGIN_CONFIG.targetLowPct,
    targetHighPct: numIn(r.targetHighPct, 0, 100) ?? DEFAULT_MARGIN_CONFIG.targetHighPct,
    warnBelowPct: numIn(r.warnBelowPct, 0, 100) ?? DEFAULT_MARGIN_CONFIG.warnBelowPct,
    criticalBelowPct: numIn(r.criticalBelowPct, -100, 100) ?? DEFAULT_MARGIN_CONFIG.criticalBelowPct,
  };
  return next.criticalBelowPct < next.warnBelowPct && next.warnBelowPct <= next.targetLowPct && next.targetLowPct <= next.targetHighPct ? next : { ...DEFAULT_MARGIN_CONFIG };
}

export type MarginBand = "UNKNOWN" | "CRITICAL" | "WARN" | "BELOW_TARGET" | "ON_TARGET" | "ABOVE_TARGET";
export const MARGIN_BAND_LABEL: Record<MarginBand, string> = {
  UNKNOWN: "Chưa tính được",
  CRITICAL: "Nguy cấp",
  WARN: "Cảnh báo",
  BELOW_TARGET: "Dưới đích",
  ON_TARGET: "Trong đích",
  ABOVE_TARGET: "Trên đích",
};

export function marginBand(marginPct: number | null, cfg: MarginConfig = DEFAULT_MARGIN_CONFIG): MarginBand {
  if (marginPct === null || !Number.isFinite(marginPct)) return "UNKNOWN";
  if (marginPct < cfg.criticalBelowPct) return "CRITICAL";
  if (marginPct < cfg.warnBelowPct) return "WARN";
  if (marginPct < cfg.targetLowPct) return "BELOW_TARGET";
  if (marginPct <= cfg.targetHighPct) return "ON_TARGET";
  return "ABOVE_TARGET";
}

// ─────────────────────────── Gói nhỏ nhất vừa số dùng thật (khách nội bộ) ───────────────────────────

export type FitUsage = { aiCustomers: number | null; fanpages: number | null; users: number | null; needsAiSales: boolean };
export type FitCandidate = { planKey: string; name: string; monthlyVnd: number; fits: boolean; why: string[] };
export type FitResult = { plan: PlanPrice | null; candidates: FitCandidate[]; reason: string };

/**
 * Gói THƯỜNG (tự mua được, không phải hợp đồng / dùng thử) RẺ NHẤT mà số dùng THẬT nằm trong số gồm. Thiếu một số đo ⇒ không
 * kết luận (không gán gói bằng phỏng đoán). Không gói nào vừa ⇒ `null` + đề xuất hợp đồng. HÀM THUẦN — người vận hành
 * quyết định có gán hay không (`scripts/ops/pricing-internal-fit.ts`, mặc định chạy thử).
 */
export function smallestFittingPlan(usage: FitUsage, prices: readonly PlanPrice[]): FitResult {
  const missing = (["aiCustomers", "fanpages", "users"] as const).filter((k) => usage[k] === null);
  const sellable = prices.filter((p) => isSellable(p) && p.trialDays === null).sort((a, b) => (a.monthlyVnd ?? 0) - (b.monthlyVnd ?? 0) || a.position - b.position);
  const candidates: FitCandidate[] = sellable.map((p) => {
    const why: string[] = [];
    const cap = (k: "aiCustomers" | "fanpages" | "users") => {
      const inc = p.included[k];
      const used = usage[k];
      if (used === null) return;
      if (inc === undefined) why.push(`${INCLUDED_SPEC[k].label}: gói chưa khai`);
      else if (inc !== null && used > inc) why.push(`${INCLUDED_SPEC[k].label}: dùng ${used.toLocaleString("vi-VN")} > gồm ${inc.toLocaleString("vi-VN")}`);
    };
    cap("aiCustomers");
    cap("fanpages");
    cap("users");
    if (usage.needsAiSales && !(p.features ?? []).includes("ai_sales")) why.push("gói không có AI bán hàng");
    return { planKey: p.planKey, name: p.name, monthlyVnd: p.monthlyVnd ?? 0, fits: why.length === 0, why };
  });
  if (missing.length) return { plan: null, candidates, reason: `Chưa đo được ${missing.map((k) => INCLUDED_SPEC[k].label.toLowerCase()).join(", ")} — không gán gói bằng phỏng đoán.` };
  const first = candidates.find((c) => c.fits);
  if (!first) return { plan: null, candidates, reason: "Số dùng vượt mọi gói niêm yết — cần gói hợp đồng (Enterprise)." };
  return { plan: sellable.find((p) => p.planKey === first.planKey) ?? null, candidates, reason: `«${first.name}» là gói rẻ nhất có số gồm phủ số dùng thật.` };
}

// ─────────────────────────── Khoá đồng hồ khách AI ───────────────────────────

/** Kỳ đồng hồ (tháng lịch giờ VN) dạng `YYYY-MM` — cùng kỳ với hạn mức và credit AI (`lib/pricing/meter.ts::usagePeriodOf`). */
export function meterMonthOf(now: Date): string {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}`;
}

const keyPart = (s: string) => s.trim().replace(/[^\w.\-]/g, "_");

/**
 * Khoá idempotent của MỘT khách AI trong MỘT kỳ: `ai_customer:<kỳ>:<kênh>:<page>:<khách>`. Cùng khách cùng kỳ ⇒ cùng khoá ⇒
 * chỉ mục duy nhất (tổ chức, khoá) của `platform_usage_events` giữ đúng MỘT dòng dù nhiều hội thoại / tin / lần thử lại.
 * Khách = danh tính kênh ổn định (`sales_chat_conversations.visitor_key` — băm của page + hội thoại, không phải SĐT / tên).
 * Thiếu thành phần hoặc khoá quá 200 ký tự ⇒ `null` (không ghi — không cắt khoá vì cắt có thể gộp hai khách thành một).
 */
export function aiCustomerEventKey(input: { month: string; channel: string; pageId: string | null; customerKey: string | null }): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) return null;
  const parts = [input.channel, input.pageId ?? "-", input.customerKey ?? ""].map((p) => keyPart(String(p)));
  if (!parts[0] || !parts[2]) return null;
  const key = `ai_customer:${input.month}:${parts.join(":")}`;
  return key.length <= 200 ? key : null;
}

/**
 * Độ phủ của đồng hồ khách AI trong một kỳ. Runtime cũ (`chatbot/`, container riêng — bot nhà) KHÔNG ghi đồng hồ: workspace
 * chỉ chạy runtime cũ ⇒ CHƯA ĐO (`null`, không phải 0). Đồng hồ bật giữa kỳ ⇒ CHƯA TRỌN (cận dưới).
 */
export function aiCustomerCoverage(input: { aiSalesOn: boolean; legacyChatbotOn: boolean; meterLiveAt: Date | null; periodFrom: Date }): { coverage: MeterCoverage; note: string | null } {
  if (!input.meterLiveAt) return { coverage: "NOT_MEASURED", note: "Đồng hồ khách AI chưa bật trên máy này." };
  if (input.legacyChatbotOn && !input.aiSalesOn) return { coverage: "NOT_MEASURED", note: "Workspace chạy bot bằng runtime cũ (chatbot/) — runtime đó chưa ghi đồng hồ khách AI." };
  if (input.legacyChatbotOn) return { coverage: "PARTIAL", note: "Một phần hội thoại đi qua runtime cũ (chatbot/) chưa ghi đồng hồ — số là cận dưới." };
  if (input.meterLiveAt.getTime() > input.periodFrom.getTime()) return { coverage: "PARTIAL", note: `Đồng hồ khách AI bắt đầu ghi từ ${new Date(input.meterLiveAt.getTime() + 7 * 3_600_000).toISOString().slice(0, 10)} — kỳ này đo chưa trọn.` };
  return { coverage: "MEASURED", note: null };
}

// ─────────────────────────── Trần AI kỹ thuật của gói AI theo phiên bản ───────────────────────────

/**
 * Trần AI KỸ THUẬT của tổ chức ở một gói AI của bảng giá CATALOG (V1): KHÔNG trần cứng nào (lượt / ngày, lượt / tháng, tiền)
 * — quyết định 07/10/2026 «không tự tắt Sales AI đang khoẻ chỉ vì vượt hạn mức»; dùng nhiều thì thu bằng phần vượt khách AI,
 * 150% thì người vận hành rà soát. Credit nền tảng = NGÂN SÁCH MỀM (cảnh báo, khung biên):
 *
 *   ngân sách USD / tháng = giá gốc tháng × (1 − ngưỡng biên nguy cấp / 100) ÷ tỷ giá USD→VND
 *
 * (phần doanh thu được phép tiêu cho AI trước khi biên lãi gộp xuống dưới mức NGUY CẤP). Giá gốc = giá tháng của gói; gói
 * không có giá tháng (dùng thử) lấy giá tháng rẻ nhất của gói AI tự mua trong CÙNG phiên bản; gói hợp đồng lấy giá «từ …».
 * `null` = không áp (phiên bản legacy, gói cũ đọc dòng legacy, gói không có `ai_sales` như INBOX — AI bán hàng của INBOX tắt
 * bằng entitlement, không bằng trần) ⇒ nơi gọi giữ trần cũ của `platform_plans`. HÀM THUẦN.
 *
 * NGOẠI LỆ — gói GIÁ 0 (dùng thử, không giá tháng, không phải hợp đồng): chưa trả tiền nên luật «không tắt bot khi vượt hạn mức»
 * không áp; chính sách chi phí / lạm dụng của tổ chức chưa trả tiền là RIÊNG (quyết định 07/10/2026 §5) và đăng ký production mở
 * tự do ⇒ GIỮ trần tiền CỨNG = chính ngân sách dẫn xuất ở trên. Tỷ giá thiếu / ≤ 0 ⇒ ngân sách `null` (không chặn, chỉ báo).
 */
export function catalogAiLimits(input: { hit: PlanPriceHit | null; versionKind: PriceVersionKind | null; versionPrices: readonly PlanPrice[]; criticalBelowPct: number; usdToVnd: number }): AiLimits | null {
  const { hit } = input;
  if (!hit || hit.source !== "VERSION" || input.versionKind !== "CATALOG") return null;
  if (!(hit.price.features ?? []).includes("ai_sales")) return null;
  const cheapest = input.versionPrices.filter((p) => isSellable(p) && (p.features ?? []).includes("ai_sales")).reduce<number | null>((m, p) => (m === null || (p.monthlyVnd ?? 0) < m ? p.monthlyVnd : m), null);
  const base = hit.price.monthlyVnd ?? hit.price.priceFromVnd ?? cheapest;
  const share = Math.max(0, 1 - input.criticalBelowPct / 100);
  const budget = base !== null && Number.isFinite(input.usdToVnd) && input.usdToVnd > 0 ? Math.round(((base * share) / input.usdToVnd) * 100) / 100 : null;
  const unpaid = hit.price.monthlyVnd === null && !hit.price.contactSales;
  if (unpaid && budget !== null && budget > 0) return { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: budget, hard: budget }, platformCreditUsdPerMonth: budget };
  return { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: budget !== null && budget > 0 ? budget : null, hard: null }, platformCreditUsdPerMonth: budget ?? 0, softOnly: true };
}
