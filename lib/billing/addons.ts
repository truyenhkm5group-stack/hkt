/**
 * ═══════════ MUA THÊM HẠN MỨC GIỮA KỲ + THÔNG TIN XUẤT HOÁ ĐƠN — HÀM THUẦN, client-safe (docs/platform/billing.md §7–8) ═══════════
 *
 * Không đọc / ghi CSDL, không đọc đồng hồ: "hôm nay" luôn là THAM SỐ (cùng tinh thần `rules.ts`).
 *
 * MÔ HÌNH. Khách đang trả phí mà thiếu đúng một hạng mục (thêm 2 người dùng, thêm 1 GB tệp) thì không phải nhảy cả gói:
 *  · Mỗi hạng mục bán theo BƯỚC cố định trong mã (`ADDON_STEP` — 1 người dùng, 1.000 bản ghi, 1 GB…). Bước nằm trong mã
 *    để số đã mua (`platform_subscriptions.addons`, lưu theo ĐƠN VỊ của hạn mức) không bao giờ đổi nghĩa.
 *  · ĐƠN GIÁ một bước / tháng do người vận hành khai THEO TỪNG GÓI (`platform_plans.addon_prices`). KHÔNG có giá mặc định
 *    và không được thêm: giá là quyết định kinh doanh (luật 38). Gói không khai giá một hạng mục ⇒ hạng mục đó KHÔNG BÁN.
 *  · Mua giữa kỳ: trả cho số ngày CÒN LẠI tới `paid_through` (tính cả hôm nay), giá / 30 mỗi ngày, LÀM TRÒN XUỐNG — cùng
 *    quy đổi với phần trừ khi nâng gói, và cùng phía có lợi cho khách.
 *  · Lần gia hạn sau: giá tháng = giá gói + Σ (số bước đã mua × đơn giá của GÓI ĐÍCH). Gói đích không bán một hạng mục
 *    khách đang có ⇒ báo lỗi rõ, không lặng lẽ bỏ phần đã mua cũng không lặng lẽ tính giá của gói khác.
 *  · Hạn mức hiệu lực = hạn mức gói + đơn vị đã mua. Gói "không giới hạn" (`null`) vẫn là không giới hạn.
 *  · Chỉ mua được khi ĐANG trả phí và còn hạn (`ACTIVE` · `DUE_SOON`): đang dùng thử chưa có kỳ để chia; quá hạn thì gia
 *    hạn trước — không bán thêm cho một kỳ đã hết.
 */
import { BILLING_DAYS_PER_MONTH, billingStanding, diffDays, type SubscriptionTerms } from "@/lib/billing/rules";
import { ENTITLEMENT_SPEC, type EntitlementKind, type PlanLimits } from "@/lib/entitlements/kinds";

/** Hạng mục bán thêm được. `aiDraftsPerDay` không bán: nó là trần MỖI NGÀY, không phải thứ tích luỹ cả kỳ. */
export const ADDON_KINDS = ["users", "pages", "objects", "records", "workflows", "storageMb"] as const satisfies readonly EntitlementKind[];
export type AddonKind = (typeof ADDON_KINDS)[number];

/** Một BƯỚC mua thêm, theo đơn vị của hạn mức. Đổi bước là đổi nghĩa của giá đã khai — chỉ thêm hạng mục mới, không sửa. */
export const ADDON_STEP: Record<AddonKind, number> = { users: 1, pages: 5, objects: 1, records: 1_000, workflows: 5, storageMb: 1_024 };

/** Trần một lần mua (chặn gõ thừa số 0), và trần đơn giá khai được. */
export const ADDON_MAX_BLOCKS = 100;
export const ADDON_PRICE_MIN_VND = 1_000;
export const ADDON_PRICE_MAX_VND = 50_000_000;

/** VND cho MỘT bước / tháng. Thiếu khoá = không bán. */
export type AddonPrices = Partial<Record<AddonKind, number>>;
/** Đơn vị ĐÃ MUA (bội của bước), theo đơn vị của hạn mức. */
export type AddonUnits = Partial<Record<AddonKind, number>>;

export function isAddonKind(v: unknown): v is AddonKind {
  return typeof v === "string" && (ADDON_KINDS as readonly string[]).includes(v);
}

/** «1 người dùng» · «5 trang» · «1 GB». */
export function addonStepLabel(kind: AddonKind): string {
  if (kind === "storageMb") return `${ADDON_STEP.storageMb / 1_024} GB`;
  return `${ADDON_STEP[kind].toLocaleString("vi-VN")} ${ENTITLEMENT_SPEC[kind].unit}`;
}

export function addonUnitsLabel(kind: AddonKind, units: number): string {
  if (kind === "storageMb") return `${(units / 1_024).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} GB`;
  return `${units.toLocaleString("vi-VN")} ${ENTITLEMENT_SPEC[kind].unit}`;
}

/** Số bước tương ứng một số đơn vị. Làm tròn LÊN: đơn vị lẻ (sửa tay ngoài bước) vẫn được tính tiền đủ bước. */
export function blocksOf(kind: AddonKind, units: number): number {
  return Math.ceil(units / ADDON_STEP[kind]);
}

function plainObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Đọc `addon_prices`. Giá sai kiểu / ngoài khoảng ⇒ coi như KHÔNG BÁN (phía hẹp: không bán hơn là bán sai giá). */
export function parseAddonPrices(raw: unknown): AddonPrices {
  const obj = plainObject(raw);
  const out: AddonPrices = {};
  for (const k of ADDON_KINDS) {
    const v = obj[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= ADDON_PRICE_MIN_VND && v <= ADDON_PRICE_MAX_VND) out[k] = v;
  }
  return out;
}

/** Đọc `addons`. Chỉ số nguyên dương; khoá lạ bị bỏ. */
export function parseAddonUnits(raw: unknown): AddonUnits {
  const obj = plainObject(raw);
  const out: AddonUnits = {};
  for (const k of ADDON_KINDS) {
    const v = obj[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

export function hasAddons(units: AddonUnits): boolean {
  return ADDON_KINDS.some((k) => (units[k] ?? 0) > 0);
}

/** Hạn mức hiệu lực = gói + đã mua. `null` (không giới hạn) giữ nguyên. */
export function applyAddons(limits: PlanLimits, units: AddonUnits): PlanLimits {
  const out = { ...limits };
  for (const k of ADDON_KINDS) {
    const add = units[k] ?? 0;
    const base = out[k];
    if (add > 0 && base !== null) out[k] = base + add;
  }
  return out;
}

/**
 * Tiền MỘT THÁNG của phần đã mua theo bảng giá của một gói. Hạng mục đang có mà gói không bán ⇒ `missing` (nơi gọi báo
 * lỗi, không đoán giá).
 */
export function addonMonthlyVnd(units: AddonUnits, prices: AddonPrices): { ok: true; vnd: number } | { ok: false; missing: AddonKind[] } {
  let vnd = 0;
  const missing: AddonKind[] = [];
  for (const k of ADDON_KINDS) {
    const u = units[k] ?? 0;
    if (u <= 0) continue;
    const p = prices[k];
    if (p === undefined) missing.push(k);
    else vnd += blocksOf(k, u) * p;
  }
  return missing.length ? { ok: false, missing } : { ok: true, vnd };
}

export function missingAddonMessage(planName: string, missing: readonly AddonKind[]): string {
  return `Gói «${planName}» không bán thêm ${missing.map((k) => ENTITLEMENT_SPEC[k].label.toLowerCase()).join(", ")} — tổ chức đang có phần mua thêm này. Báo người vận hành nền tảng (khai giá cho gói đó, hoặc giảm phần mua thêm) rồi đổi gói.`;
}

export type AddonQuote = {
  kind: AddonKind;
  blocks: number;
  units: number;
  /** Giá một bước / tháng của gói hiện tại. */
  unitPriceVnd: number;
  /** Phần này cộng thêm vào giá tháng từ lần gia hạn sau. */
  monthlyVnd: number;
  periodStart: string;
  periodEnd: string;
  days: number;
  amountVnd: number;
  explain: string;
};

/** Báo giá MỘT lần mua thêm giữa kỳ. */
export function quoteAddon(input: { terms: SubscriptionTerms | null; planName: string; kind: unknown; blocks: unknown; prices: AddonPrices; today: string }): AddonQuote | { error: string } {
  const { terms, today } = input;
  if (!isAddonKind(input.kind)) return { error: "Hạng mục này không bán thêm." };
  const kind = input.kind;
  const blocks = typeof input.blocks === "number" ? input.blocks : Number(input.blocks);
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > ADDON_MAX_BLOCKS) return { error: `Số lượng mua là số nguyên 1–${ADDON_MAX_BLOCKS} (mỗi phần ${addonStepLabel(kind)}).` };
  const price = input.prices[kind];
  if (price === undefined) return { error: `Gói «${input.planName}» chưa bán thêm ${ENTITLEMENT_SPEC[kind].label.toLowerCase()} — nâng gói, hoặc báo người vận hành nền tảng.` };
  const standing = billingStanding(terms, today);
  if (standing.kind === "NOT_BILLED") return { error: "Tổ chức chưa vào kỳ trả phí — chọn gói và thanh toán trước, mua thêm sau." };
  if (standing.kind === "OVERDUE" || standing.kind === "LOCKED") return { error: "Gói đã hết hạn — gia hạn trước rồi mới mua thêm." };
  const pt = terms!.paidThrough!;
  const days = diffDays(pt, today) + 1;
  const monthly = price * blocks;
  const amount = Math.floor((monthly * days) / BILLING_DAYS_PER_MONTH);
  if (amount <= 0) return { error: "Số tiền tính ra bằng 0 — không có gì để thanh toán." };
  return {
    kind,
    blocks,
    units: blocks * ADDON_STEP[kind],
    unitPriceVnd: price,
    monthlyVnd: monthly,
    periodStart: today,
    periodEnd: pt,
    days,
    amountVnd: amount,
    explain: `${days} ngày còn lại của kỳ (tới hết ${pt}) × ${monthly.toLocaleString("vi-VN")} ₫/tháng ÷ ${BILLING_DAYS_PER_MONTH}, làm tròn xuống. Từ lần gia hạn sau, phần này cộng vào giá tháng.`,
  };
}

// ─────────────────────────── Thông tin xuất hoá đơn VAT ───────────────────────────

/**
 * Thông tin để người vận hành XUẤT hoá đơn VAT bên ngoài ERP (ERP không phát hành hoá đơn điện tử — đó là dịch vụ ngoài,
 * AGENTS.md §7). Mã số thuế: 10 số · 10 số + «-» + 3 số (đơn vị phụ thuộc) · 12 số (cá nhân dùng số định danh).
 */
export type InvoiceInfo = { companyName: string; taxCode: string; address: string; email: string };

const TAX_CODE_RE = /^(\d{10}(-\d{3})?|\d{12})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseInvoiceInfo(raw: unknown): { ok: true; info: InvoiceInfo } | { error: string } {
  const o = plainObject(raw);
  const s = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim().slice(0, max) : "");
  const info: InvoiceInfo = { companyName: s("companyName", 200), taxCode: s("taxCode", 20).replace(/\s/g, ""), address: s("address", 300), email: s("email", 120).toLowerCase() };
  if (info.companyName.length < 2) return { error: "Nhập tên công ty / hộ kinh doanh đúng như trên đăng ký thuế." };
  if (!TAX_CODE_RE.test(info.taxCode)) return { error: "Mã số thuế gồm 10 số, 10 số + «-» + 3 số, hoặc 12 số." };
  if (info.address.length < 5) return { error: "Nhập địa chỉ đăng ký thuế." };
  if (!EMAIL_RE.test(info.email)) return { error: "Nhập email nhận hoá đơn điện tử." };
  return { ok: true, info };
}

/** Đọc thông tin đã lưu; sai hình ⇒ `null` (coi như chưa khai, không đoán). */
export function readInvoiceInfo(raw: unknown): InvoiceInfo | null {
  if (raw === null || raw === undefined) return null;
  const r = parseInvoiceInfo(raw);
  return "ok" in r ? r.info : null;
}
