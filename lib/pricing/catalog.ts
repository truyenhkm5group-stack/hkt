/**
 * ═══════════ DANH MỤC GÓI — PHẦN THƯƠNG MẠI (0222) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Gói là DỮ LIỆU ở `platform_plans` (người vận hành sửa ở `/platform`, không deploy):
 *  · giá tháng `price_vnd` (0187) — `NULL` = không bán tự phục vụ (Dùng thử, Doanh nghiệp «Liên hệ», Nội bộ);
 *  · giá năm = giá tháng × (12 − `yearly_free_months`) (0194) — MỘT phép tính, dùng chung với hoá đơn (`billedMonths`);
 *  · hạn mức kỹ thuật `limits` (0169 · 0176) — người dùng, trang tuỳ biến, credit AI…;
 *  · phần THƯƠNG MẠI `commercial` (0222) — tệp này đọc nó: hiện ở /pricing không, «Liên hệ», hạn mức theo tháng, tính năng,
 *    chính sách vượt, mức áp hạn mức.
 *  · số ngày dùng thử = `TRIAL_DAYS` (lib/billing/rules.ts) — MỘT nguồn, vì nó là cam kết trong Điều khoản sử dụng; gói
 *    `trial` là gói của cửa hàng đang dùng thử (`trialDaysOf`).
 *
 * Ô thiếu = CHƯA KHAI (`undefined` + danh sách `undeclared`), không phải 0 và không phải "không giới hạn" lặng lẽ.
 */
import { billedMonths, TRIAL_DAYS } from "@/lib/billing/rules";
import { DEFAULT_PLAN_KEY, parseLimits } from "@/lib/entitlements/kinds";
import { parseFeatureList, type FeatureKey } from "@/lib/pricing/features";

/**
 * HẠN MỨC THƯƠNG MẠI. Bốn ô đếm theo KỲ (tháng lịch giờ VN, `lib/pricing/meter.ts::usagePeriodOf`) nằm ở `commercial.quotas`;
 * `users` là con số TỨC THỜI và đọc từ `limits.users` (0169) — không khai lần hai.
 */
export const QUOTA_KEYS = ["aiConversations", "aiMessages", "orders", "fanpages", "users"] as const;
export type QuotaKey = (typeof QUOTA_KEYS)[number];
/** Ô khai ở `commercial.quotas` (không gồm `users`). */
export const COMMERCIAL_QUOTA_KEYS = ["aiConversations", "aiMessages", "orders", "fanpages"] as const satisfies readonly QuotaKey[];
export type CommercialQuotaKey = (typeof COMMERCIAL_QUOTA_KEYS)[number];

export const QUOTA_SPEC: Record<QuotaKey, { label: string; unit: string; gauge: boolean }> = {
  aiConversations: { label: "Hội thoại AI", unit: "hội thoại AI", gauge: false },
  aiMessages: { label: "Tin nhắn AI gửi", unit: "tin AI", gauge: false },
  orders: { label: "Đơn AI tạo", unit: "đơn", gauge: false },
  fanpages: { label: "Fanpage", unit: "fanpage", gauge: true },
  users: { label: "Người dùng", unit: "tài khoản", gauge: true },
};

export const OVERAGE_POLICIES = ["SOFT_ONLY", "BILL_OVERAGE", "REQUIRE_UPGRADE"] as const;
export type OveragePolicy = (typeof OVERAGE_POLICIES)[number];
export const OVERAGE_POLICY_LABEL: Record<OveragePolicy, string> = {
  SOFT_ONLY: "Vượt chỉ nhắc — không thu, không chặn",
  BILL_OVERAGE: "Vượt tính phí theo đơn giá",
  REQUIRE_UPGRADE: "Vượt thì mời nâng gói",
};

export const LIMIT_MODES = ["SOFT", "HARD"] as const;
export type LimitMode = (typeof LIMIT_MODES)[number];

export const GRACE_ALLOWANCE_MAX_PCT = 50;
export const QUOTA_MAX = 10_000_000;
export const OVERAGE_UNIT_PRICE_MAX_VND = 1_000_000;

export type PlanCommercial = {
  publicListed: boolean;
  /** Gói không tự mua — /pricing in «Liên hệ». */
  contactSales: boolean;
  highlight: boolean;
  /** `null` = không giới hạn · `undefined` = CHƯA KHAI. */
  quotas: Record<CommercialQuotaKey, number | null | undefined>;
  /** `null` = CHƯA KHAI (xem `featureGranted`). */
  features: FeatureKey[] | null;
  overage: { policy: OveragePolicy; unitPricesVnd: Partial<Record<CommercialQuotaKey, number>>; graceAllowancePct: number };
  limitModes: Partial<Record<QuotaKey, LimitMode>>;
  undeclared: string[];
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

/** Đọc `commercial` jsonb của một gói. Sai kiểu ⇒ ô đó CHƯA KHAI (nói ra), không bao giờ ném. */
export function parseCommercial(raw: unknown): PlanCommercial {
  const c = isRec(raw) ? raw : {};
  const undeclared: string[] = [];
  const q = isRec(c.quotas) ? c.quotas : {};
  const quotas = {} as PlanCommercial["quotas"];
  for (const k of COMMERCIAL_QUOTA_KEYS) {
    const v = q[k];
    if (v === null) quotas[k] = null;
    else {
      const n = intIn(v, 0, QUOTA_MAX);
      quotas[k] = n;
      if (n === undefined) undeclared.push(`quotas.${k}`);
    }
  }
  const features = parseFeatureList(c.features);
  if (features === null) undeclared.push("features");
  const ov = isRec(c.overage) ? c.overage : {};
  const policy = (OVERAGE_POLICIES as readonly string[]).includes(String(ov.policy)) ? (ov.policy as OveragePolicy) : "SOFT_ONLY";
  if (!(OVERAGE_POLICIES as readonly string[]).includes(String(ov.policy))) undeclared.push("overage.policy");
  const unitPricesVnd: Partial<Record<CommercialQuotaKey, number>> = {};
  const up = isRec(ov.unitPricesVnd) ? ov.unitPricesVnd : {};
  for (const k of COMMERCIAL_QUOTA_KEYS) {
    const n = intIn(up[k], 1, OVERAGE_UNIT_PRICE_MAX_VND);
    if (n !== undefined) unitPricesVnd[k] = n;
  }
  const limitModes: Partial<Record<QuotaKey, LimitMode>> = {};
  const lm = isRec(c.limitModes) ? c.limitModes : {};
  for (const k of [...COMMERCIAL_QUOTA_KEYS, "users"] as const) if (lm[k] === "SOFT" || lm[k] === "HARD") limitModes[k] = lm[k];
  return {
    publicListed: c.publicListed === true,
    contactSales: c.contactSales === true,
    highlight: c.highlight === true,
    quotas,
    features,
    overage: { policy, unitPricesVnd, graceAllowancePct: intIn(ov.graceAllowancePct, 0, GRACE_ALLOWANCE_MAX_PCT) ?? 0 },
    limitModes,
    undeclared,
  };
}

/** Hạn mức THƯƠNG MẠI hiệu lực của một gói (gồm `users` từ `limits`). `undefined` = chưa khai. */
export function planQuotas(limits: unknown, commercial: PlanCommercial): Record<QuotaKey, number | null | undefined> {
  const parsed = parseLimits(limits);
  return { ...commercial.quotas, users: parsed.undeclared.includes("users") ? undefined : parsed.limits.users };
}

/** Áp ghi đè thưa của tổ chức (`quota_overrides`): ô có mặt thắng gói. */
export function applyQuotaOverrides(base: Record<QuotaKey, number | null | undefined>, raw: unknown): Record<QuotaKey, number | null | undefined> {
  if (!isRec(raw)) return base;
  const out = { ...base };
  for (const k of QUOTA_KEYS) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (v === null) out[k] = null;
    else {
      const n = intIn(v, 0, QUOTA_MAX);
      if (n !== undefined) out[k] = n;
    }
  }
  return out;
}

/** Số ngày dùng thử của một gói: chỉ gói mặc định của cửa hàng tự đăng ký (`trial`) có, và đó là `TRIAL_DAYS`. */
export function trialDaysOf(planKey: string): number | null {
  return planKey === DEFAULT_PLAN_KEY ? TRIAL_DAYS : null;
}

/** Giá trả 12 tháng — CÙNG phép tính với hoá đơn gia hạn (`billedMonths`). `null` khi gói không bán. */
export function yearlyPriceVnd(priceVnd: number | null, yearlyFreeMonths: number): number | null {
  if (priceVnd === null || !(priceVnd > 0)) return null;
  return priceVnd * billedMonths(12, yearlyFreeMonths);
}

/** Giá mỗi tháng khi trả năm (làm tròn xuống tới đồng). */
export function monthlyOnYearlyVnd(priceVnd: number | null, yearlyFreeMonths: number): number | null {
  const y = yearlyPriceVnd(priceVnd, yearlyFreeMonths);
  return y === null ? null : Math.floor(y / 12);
}

// ─────────────────────────── Kiểm đầu vào của người vận hành ───────────────────────────

export type CommercialInput = {
  name?: unknown;
  description?: unknown;
  publicListed?: unknown;
  contactSales?: unknown;
  highlight?: unknown;
  quotas?: unknown;
  features?: unknown;
  overagePolicy?: unknown;
  overageUnitPricesVnd?: unknown;
  graceAllowancePct?: unknown;
  limitModes?: unknown;
};

/** Ô số của người vận hành: số nguyên ≥ 0, cho phép dấu chấm / phẩy / cách hàng nghìn. Dấu trừ, chữ ⇒ SAI (không đoán). */
const toNumOrNull = (v: unknown): number | null | "BAD" => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? v : "BAD";
  const str = String(v).trim();
  if (str === "") return null;
  if (!/^[\d.,\s]+$/.test(str)) return "BAD";
  const n = Number(str.replace(/[^\d]/g, ""));
  return Number.isInteger(n) && n >= 0 ? n : "BAD";
};

/**
 * Chuẩn hoá đầu vào sửa gói thành jsonb `commercial` + tên / mô tả. Thuần — server action và bài kiểm dùng chung. Ô hạn mức
 * để trống = KHÔNG GIỚI HẠN (người vận hành bấm lưu là đã khai), khác "chưa khai" của dữ liệu cũ.
 */
export function normalizeCommercialInput(raw: CommercialInput): { ok: true; name: string; description: string | null; commercial: Record<string, unknown> } | { error: string } {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.length < 2 || name.length > 40) return { error: "Tên gói dài 2–40 ký tự." };
  const description = typeof raw.description === "string" && raw.description.trim() ? raw.description.trim().slice(0, 300) : null;
  const quotasIn = isRec(raw.quotas) ? raw.quotas : {};
  const quotas: Record<string, number | null> = {};
  for (const k of COMMERCIAL_QUOTA_KEYS) {
    const v = toNumOrNull(quotasIn[k]);
    if (v === "BAD" || (v !== null && v > QUOTA_MAX)) return { error: `${QUOTA_SPEC[k].label}: số nguyên 0–${QUOTA_MAX.toLocaleString("vi-VN")}, để trống = không giới hạn.` };
    quotas[k] = v;
  }
  const featuresRaw = Array.isArray(raw.features) ? raw.features : [];
  const features = parseFeatureList(featuresRaw) ?? [];
  if (featuresRaw.length !== features.length) return { error: "Có tính năng không có trong sổ — tải lại trang." };
  const policy = String(raw.overagePolicy ?? "");
  if (!(OVERAGE_POLICIES as readonly string[]).includes(policy)) return { error: "Chọn chính sách khi vượt hạn mức." };
  const upIn = isRec(raw.overageUnitPricesVnd) ? raw.overageUnitPricesVnd : {};
  const unitPricesVnd: Record<string, number> = {};
  for (const k of COMMERCIAL_QUOTA_KEYS) {
    const v = toNumOrNull(upIn[k]);
    if (v === "BAD" || (v !== null && (v < 1 || v > OVERAGE_UNIT_PRICE_MAX_VND))) return { error: `Đơn giá vượt «${QUOTA_SPEC[k].label}»: số nguyên 1–${OVERAGE_UNIT_PRICE_MAX_VND.toLocaleString("vi-VN")} ₫, hoặc để trống.` };
    if (v !== null) unitPricesVnd[k] = v;
  }
  const grace = toNumOrNull(raw.graceAllowancePct);
  if (grace === "BAD" || (grace !== null && grace > GRACE_ALLOWANCE_MAX_PCT)) return { error: `Phần cho vượt thêm trước khi chặn là 0–${GRACE_ALLOWANCE_MAX_PCT}%.` };
  const lmIn = isRec(raw.limitModes) ? raw.limitModes : {};
  const limitModes: Record<string, LimitMode> = {};
  for (const k of QUOTA_KEYS) {
    const v = lmIn[k];
    if (v === undefined || v === null || v === "") continue;
    if (v !== "SOFT" && v !== "HARD") return { error: "Mức áp hạn mức chỉ là Mềm hoặc Cứng." };
    limitModes[k] = v;
  }
  return {
    ok: true,
    name,
    description,
    commercial: {
      publicListed: raw.publicListed === true,
      contactSales: raw.contactSales === true,
      highlight: raw.highlight === true,
      quotas,
      features,
      overage: { policy, unitPricesVnd, graceAllowancePct: grace ?? 0 },
      limitModes,
    },
  };
}

