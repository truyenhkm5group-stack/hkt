/**
 * ═══════════ SỔ GIÁ CÓ PHIÊN BẢN — ĐƯỜNG ĐỌC / GHI DUY NHẤT — CHỈ MÁY CHỦ (docs/saas/PRICING_V1.md) ═══════════
 *
 * Mọi chỗ cần GIÁ của một tổ chức (báo giá gia hạn, mua thêm, MRR, bảng kê, màn khách, trang giá) đọc qua đây — không đọc
 * thẳng `platform_plans.price_vnd` / `yearly_free_months` / `addon_prices` nữa:
 *  · `plansForOrg(org)` — danh sách gói "như hoá đơn của tổ chức này đọc" (giá theo phiên bản đã ghim, gói cũ theo dòng
 *    legacy). CÙNG hình dạng `PlanRow`, nên đường đọc cũ chỉ đổi lời gọi.
 *  · `catalogPlans()` — bảng giá đang niêm yết (trang giá, tổ chức mới).
 *  · `pinOrgPriceVersion` — ghim (hoá đơn được trả / người vận hành chuyển). `publishCatalogVersion` — sửa giá = THÊM phiên
 *    bản mới chép từ phiên bản hiện hành; dòng cũ không bao giờ bị sửa.
 *
 * LỖI ĐỌC sổ giá / ghim ⇒ NÉM (không đệm): đường tiền (báo giá, hoá đơn, MRR, bảng kê) từ chối «thử lại», KHÔNG BAO GIỜ
 * rơi về bảng giá hiện hành — một lần CSDL chập mà báo giá V1 cho khách đang ghim giá cũ thì hoá đơn ấy ghim họ VĨNH VIỄN vào
 * giá mới. Chỉ tổ chức đọc ghim THÀNH CÔNG mà không có dòng mới là tổ chức theo bảng giá hiện hành. Đường không phải tiền
 * (entitlement, trần người dùng) dùng `plansForOrgSafe`: lỗi ⇒ `platform_plans` thô (= giá / hạn mức cũ, phía hẹp).
 */
import { eq, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { listPlans, type PlanRow } from "@/lib/entitlements/check";
import { platformAudit, type PlatformActor } from "@/lib/platform/audit";
import { getHomeOrganization } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import type { AiLimits } from "@/lib/ai-usage/types";
import { env } from "@/lib/env";
import {
  catalogAiLimits,
  currentCatalogVersion,
  LEGACY_VERSION_KEY,
  overlayPlanRow,
  parseMarginConfig,
  parsePlanPrice,
  parsePriceVersion,
  priceOf,
  resolveOrgVersion,
  DEFAULT_MARGIN_CONFIG,
  type MarginConfig,
  type PlanPrice,
  type PriceBook,
  type PricedPlanRow,
  type PriceVersion,
  type ResolvedVersion,
} from "@/lib/pricing/versions";

export const PRICING_MARGIN_KEY = "platform.pricing.margin";
export const AI_CUSTOMER_METER_LIVE_KEY = "platform.pricing.ai-customer-meter-live-at";
const TTL_MS = 10_000;

type Holder = { __erpPriceBook?: { at: number; book: PriceBook }; __erpPricePins?: Map<string, { at: number; key: string | null }> };
const holder = globalThis as unknown as Holder;
if (!holder.__erpPricePins) holder.__erpPricePins = new Map();
const pinCache = holder.__erpPricePins;

export function invalidatePriceBook(orgCode?: string) {
  holder.__erpPriceBook = undefined;
  if (orgCode) pinCache.delete(orgCode);
  else pinCache.clear();
}

export async function loadPriceBook(opts: { fresh?: boolean } = {}): Promise<PriceBook> {
  const hit = holder.__erpPriceBook;
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.book;
  // Lỗi ⇒ ném, KHÔNG đệm: sổ rỗng giả sẽ làm mọi gói "không bán" và MRR thành 0 (luật 42).
  const pdb = await getPlatformDb();
  const [versions, prices] = await Promise.all([pdb.select().from(schema.platformPriceVersions), pdb.select().from(schema.platformPlanPrices)]);
  const book: PriceBook = { versions: versions.map(parsePriceVersion), prices: prices.map(parsePlanPrice) };
  holder.__erpPriceBook = { at: Date.now(), book };
  return book;
}

/**
 * Khoá phiên bản đã ghim của tổ chức; `null` = đọc THÀNH CÔNG và KHÔNG có dòng ghim (tổ chức mới — theo bảng giá hiện hành).
 * Lỗi đọc ⇒ NÉM, không đệm: "không đọc được" không bao giờ được hiểu thành "chưa ghim".
 */
export async function readPricePin(orgCode: string, opts: { fresh?: boolean } = {}): Promise<string | null> {
  const hit = pinCache.get(orgCode);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.key;
  const pdb = await getPlatformDb();
  const [row] = await pdb.select({ key: schema.platformPricePins.versionKey }).from(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, orgCode)).limit(1);
  const key = row?.key ?? null;
  pinCache.set(orgCode, { at: Date.now(), key });
  return key;
}

export type OrgPriceVersion = ResolvedVersion & { pinKey: string | null; book: PriceBook };

export async function orgPriceVersion(orgCode: string, now: Date = new Date()): Promise<OrgPriceVersion> {
  const [book, pinKey] = await Promise.all([loadPriceBook(), readPricePin(orgCode)]);
  return { ...resolveOrgVersion(book, pinKey, now), pinKey, book };
}

function overlayAll(plans: readonly PlanRow[], book: PriceBook, version: PriceVersion | null): PricedPlanRow<PlanRow>[] {
  return plans.map((p) => overlayPlanRow(p, priceOf(book, version?.key, p.key), version?.kind ?? null));
}

/** Gói "như hoá đơn của tổ chức `orgCode` đọc": giá theo phiên bản đã ghim (chưa ghim ⇒ bảng giá hiện hành). */
export async function plansForOrg(orgCode: string, now: Date = new Date()): Promise<PricedPlanRow<PlanRow>[]> {
  const [plans, v] = await Promise.all([listPlans(), orgPriceVersion(orgCode, now)]);
  return overlayAll(plans, v.book, v.version);
}

/**
 * Như `plansForOrg` cho đường KHÔNG phải tiền (entitlement, trần người dùng): lỗi đọc sổ giá ⇒ `platform_plans` thô — giá và
 * hạn mức cũ (phía hẹp), không phải bảng giá hiện hành, và không ai ghim gì từ kết quả này.
 */
export async function plansForOrgSafe(orgCode: string, now: Date = new Date()): Promise<PricedPlanRow<PlanRow>[]> {
  try {
    return await plansForOrg(orgCode, now);
  } catch {
    return (await listPlans()).map((p) => ({ ...p, yearlyPriceVnd: null, priceFromVnd: null, priceVersionKey: null, priceSource: "NONE" as const, planPrice: null }));
  }
}

/**
 * Bảng giá ĐANG NIÊM YẾT: mọi gói của phiên bản CATALOG hiện hành, theo thứ tự của phiên bản. Gói không có dòng ở
 * `platform_plans` (khai sót) vẫn hiện — dựng dòng gói tối thiểu từ phiên bản.
 */
export async function catalogPlans(now: Date = new Date()): Promise<{ version: PriceVersion | null; plans: PricedPlanRow<PlanRow>[] }> {
  const [plans, book] = await Promise.all([listPlans().catch(() => [] as PlanRow[]), loadPriceBook()]);
  const version = currentCatalogVersion(book, now);
  if (!version) return { version: null, plans: [] };
  const rows = book.prices
    .filter((p) => p.versionKey === version.key)
    .sort((a, b) => a.position - b.position || a.planKey.localeCompare(b.planKey))
    .map((price) => {
      const base: PlanRow = plans.find((p) => p.key === price.planKey) ?? { key: price.planKey, name: price.name, description: price.description, limits: price.limits, position: price.position, priceVnd: null, addonPrices: {}, yearlyFreeMonths: 0, commercial: price.commercial };
      return overlayPlanRow(base, { price, source: "VERSION" }, version.kind);
    });
  return { version, plans: rows };
}

/**
 * Trần AI kỹ thuật theo PHIÊN BẢN giá đã ghim (`catalogAiLimits`): gói AI của bảng giá CATALOG ⇒ không trần cứng, ngân sách
 * mềm dẫn xuất từ giá tháng + ngưỡng biên nguy cấp. `null` ⇒ giữ trần cũ của `platform_plans` (legacy, gói cũ, INBOX).
 */
export async function orgAiLimits(orgCode: string, planKey: string, now: Date = new Date()): Promise<AiLimits | null> {
  const memo = `${orgCode}|${planKey}`;
  try {
    const [v, margin] = await Promise.all([orgPriceVersion(orgCode, now), readMarginConfig()]);
    const versionPrices = v.version ? v.book.prices.filter((p) => p.versionKey === v.version!.key) : [];
    const limits = catalogAiLimits({ hit: priceOf(v.book, v.version?.key, planKey), versionKind: v.version?.kind ?? null, versionPrices, criticalBelowPct: margin.criticalBelowPct, usdToVnd: env.facebook.usdToVnd });
    aiLimitsLastGood.set(memo, limits);
    return limits;
  } catch (e) {
    // Lỗi ĐỌC sổ giá / ghim (tạm thời): KHÔNG rơi về `platform_plans` thô (Scale có credit 0 ở đó ⇒ bot bị chặn vì một lần
    // đọc lỗi). Dùng kết quả đọc được gần nhất; chưa từng đọc được ⇒ KHÔNG CHẶN (mềm), đếm cảnh báo.
    priceReadWarnings.n += 1;
    priceReadWarnings.last = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
    return aiLimitsLastGood.has(memo) ? (aiLimitsLastGood.get(memo) ?? null) : AI_LIMITS_UNREADABLE;
  }
}

/** Trần AI khi chưa đọc được phiên bản giá: không chặn gì (mềm). Chỉ dùng cho lỗi đọc tạm thời — không bao giờ là cấu hình. */
export const AI_LIMITS_UNREADABLE: AiLimits = { requestsPerDay: null, requestsPerMonth: null, costUsdPerMonth: { soft: null, hard: null }, platformCreditUsdPerMonth: 0, softOnly: true };
const aiLimitsLastGood = new Map<string, AiLimits | null>();
const priceReadWarnings = { n: 0, last: null as string | null };

/** Số lần đọc sổ giá lỗi ở đường trần AI (không chứa dữ liệu khách). */
export function priceReadWarningCount(): { n: number; last: string | null } {
  return { ...priceReadWarnings };
}

/** Bài kiểm: quên kết quả trần AI đọc được gần nhất. */
export function resetAiLimitsMemoForTests() {
  aiLimitsLastGood.clear();
}

export async function readMarginConfig(): Promise<MarginConfig> {
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, PRICING_MARGIN_KEY) });
    return parseMarginConfig(r?.value);
  } catch {
    return DEFAULT_MARGIN_CONFIG;
  }
}

/**
 * Mốc đồng hồ khách AI bắt đầu ghi: ghi đè tay ở `platform.pricing.ai-customer-meter-live-at` nếu có; không thì `created_at`
 * của phiên bản CATALOG ĐẦU TIÊN — dòng V1 do 0226 ghi lúc migrate, cùng lần deploy với mã ghi đồng hồ. `null` = chưa bật.
 */
// Lỗi đọc ⇒ `null` = đồng hồ CHƯA ĐO ⇒ phần vượt khách AI `null` (phía an toàn: không thu), không bao giờ "đo trọn kỳ".
export async function readAiCustomerMeterLiveAt(): Promise<Date | null> {
  try {
    const pdb = await getPlatformDb();
    const r = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, AI_CUSTOMER_METER_LIVE_KEY) });
    const at = r?.value && typeof r.value === "object" ? (r.value as { at?: unknown }).at : null;
    const d = typeof at === "string" ? new Date(at) : null;
    if (d && Number.isFinite(d.getTime())) return d;
    const [first] = await pdb.select({ at: sql<Date | string | null>`min(${schema.platformPriceVersions.createdAt})` }).from(schema.platformPriceVersions).where(eq(schema.platformPriceVersions.kind, "CATALOG"));
    const f = first?.at ? new Date(first.at) : null;
    return f && Number.isFinite(f.getTime()) ? f : null;
  } catch {
    return null;
  }
}

// ─────────────────────────── Ghi ───────────────────────────

export type PinSource = "INVOICE_PAID" | "OPERATOR" | "TEST";
type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getPlatformDb>>["transaction"]>[0]>[0];

/**
 * Ghim tổ chức vào phiên bản `versionKey` (ghi đè ghim cũ). Gọi trong giao dịch trả hoá đơn (`tx`) để ghim và gia hạn là MỘT
 * việc. Không ghi nhật ký ở đây — nơi gọi ghi (hoá đơn được trả đã có dòng nhật ký riêng).
 */
export async function pinOrgPriceVersion(orgCode: string, versionKey: string, opts: { source: PinSource; reason: string | null; email: string | null; tx?: Tx }): Promise<{ changed: boolean; before: string | null }> {
  const db = opts.tx ?? (await getPlatformDb());
  const t = schema.platformPricePins;
  const [cur] = await db.select({ key: t.versionKey }).from(t).where(eq(t.orgCode, orgCode)).limit(1);
  if (cur?.key === versionKey) return { changed: false, before: cur.key };
  const values = { versionKey, source: opts.source, reason: opts.reason, pinnedByEmail: opts.email, pinnedAt: new Date() };
  await db.insert(t).values({ orgCode, ...values }).onConflictDoUpdate({ target: t.orgCode, set: values });
  pinCache.delete(orgCode);
  return { changed: true, before: cur?.key ?? null };
}

const reasonOk = (raw: unknown): string | null => {
  const r = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  return r.length >= 5 ? r : null;
};

const actorOf = (user: SessionUser): PlatformActor => (user.organization ? { orgCode: user.organization.code, userId: user.id, email: user.email } : null);

/** NGƯỜI VẬN HÀNH chuyển một tổ chức sang một phiên bản giá (có lý do, vào nhật ký). Kỳ đang mở tính theo phiên bản mới từ hoá đơn kế tiếp. */
export async function setOrgPriceVersion(user: SessionUser, raw: { orgCode?: unknown; versionKey?: unknown; reason?: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = reasonOk(raw.reason);
  if (!reason) return { error: "Ghi lý do (ít nhất 5 ký tự) — nó vào nhật ký nền tảng." };
  const orgCode = typeof raw.orgCode === "string" ? raw.orgCode.trim() : "";
  const versionKey = typeof raw.versionKey === "string" ? raw.versionKey.trim() : "";
  const pdb = await getPlatformDb();
  const [org] = await pdb.select({ code: schema.platformOrganizations.code }).from(schema.platformOrganizations).where(eq(schema.platformOrganizations.code, orgCode)).limit(1);
  if (!org) return { error: `Không có tổ chức «${orgCode}».` };
  const book = await loadPriceBook({ fresh: true });
  if (!book.versions.some((v) => v.key === versionKey)) return { error: `Không có phiên bản giá «${versionKey}».` };
  const r = await pinOrgPriceVersion(org.code, versionKey, { source: "OPERATOR", reason, email: user.email });
  if (!r.changed) return { ok: true, message: "Tổ chức đã ở phiên bản này." };
  await platformAudit({ action: "PRICE_VERSION_PIN", targetOrgCode: org.code, subject: `price-pin:${org.code}`, before: { versionKey: r.before }, after: { versionKey }, reason, source: "UI", actor: actorOf(user) });
  return { ok: true, message: `Đã chuyển «${org.code}» sang phiên bản giá «${versionKey}».` };
}

export type PlanPricePatch = { monthlyVnd?: number | null; yearlyFreeMonths?: number; yearlyVnd?: number | null; addonPrices?: Record<string, number> };

/**
 * PHÁT HÀNH một phiên bản CATALOG mới = chép mọi dòng của phiên bản hiện hành + vá MỘT gói, hiệu lực từ `now`. Tổ chức đã
 * ghim phiên bản cũ GIỮ giá cũ; tổ chức chưa ghim / mua mới đi giá mới. Dòng cũ không bị sửa (lịch sử tái lập được).
 * Gói không có trong bảng giá hiện hành (gói cũ chỉ còn cho thuê bao đang dùng) ⇒ từ chối: đổi giá cho họ là CHUYỂN họ sang
 * một phiên bản khác (`setOrgPriceVersion`), không phải sửa ảnh chụp.
 */
export async function publishCatalogVersion(input: { planKey: string; patch: PlanPricePatch; reason: string; actor: PlatformActor; email: string | null; now?: Date; source?: "UI" | "SCRIPT" | "TEST" }): Promise<{ ok: true; versionKey: string } | { error: string }> {
  const now = input.now ?? new Date();
  const book = await loadPriceBook({ fresh: true });
  const current = currentCatalogVersion(book, now);
  if (!current) return { error: "Chưa có bảng giá niêm yết để chép — không phát hành được phiên bản mới." };
  const rows = book.prices.filter((p) => p.versionKey === current.key);
  const target = rows.find((p) => p.planKey === input.planKey);
  if (!target) return { error: `Gói «${input.planKey}» không có trong bảng giá hiện hành — gói cũ giữ nguyên giá cho thuê bao đang dùng; muốn đổi giá cho họ thì chuyển họ sang phiên bản khác.` };
  const stamp = new Date(now.getTime() + 7 * 3_600_000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let key = `cat-${stamp}`;
  for (let i = 2; book.versions.some((v) => v.key === key); i++) key = `cat-${stamp}-${i}`;
  const patched = (p: PlanPrice): PlanPrice => {
    if (p.planKey !== input.planKey) return p;
    const next = { ...p };
    if (input.patch.monthlyVnd !== undefined) next.monthlyVnd = input.patch.monthlyVnd;
    if (input.patch.yearlyFreeMonths !== undefined) next.yearlyFreeMonths = input.patch.yearlyFreeMonths;
    // Đổi giá tháng mà không khai giá năm ⇒ giá năm theo tặng tháng (không giữ con số năm cũ lệch với giá tháng mới).
    if (input.patch.yearlyVnd !== undefined) next.yearlyVnd = input.patch.yearlyVnd;
    else if (input.patch.monthlyVnd !== undefined || input.patch.yearlyFreeMonths !== undefined) next.yearlyVnd = null;
    if (input.patch.addonPrices !== undefined) next.addonPrices = input.patch.addonPrices;
    return next;
  };
  const pdb = await getPlatformDb();
  await pdb.transaction(async (tx) => {
    await tx.insert(schema.platformPriceVersions).values({ key, label: `${current.label} — sửa ${target.name} (${stamp.slice(6, 8)}/${stamp.slice(4, 6)}/${stamp.slice(0, 4)})`, kind: "CATALOG", effectiveFrom: now, taxMode: current.taxMode, taxNote: current.taxNote, alertThresholds: current.alerts, note: `Chép từ «${current.key}». ${input.reason}`.slice(0, 500), createdByEmail: input.email });
    await tx.insert(schema.platformPlanPrices).values(
      rows.map(patched).map((p) => ({
        versionKey: key,
        planKey: p.planKey,
        name: p.name,
        description: p.description,
        position: p.position,
        listed: p.listed,
        highlight: p.highlight,
        contactSales: p.contactSales,
        monthlyVnd: p.monthlyVnd,
        yearlyVnd: p.yearlyVnd,
        yearlyFreeMonths: p.yearlyFreeMonths,
        priceFromVnd: p.priceFromVnd,
        trialDays: p.trialDays,
        included: p.included as Record<string, unknown>,
        overage: rowOverage(p),
        features: p.features,
        addonPrices: (p.addonPrices && typeof p.addonPrices === "object" ? p.addonPrices : {}) as Record<string, unknown>,
        limits: p.limits,
        commercial: p.commercial,
      })),
    );
  });
  invalidatePriceBook();
  const home = await getHomeOrganization();
  const after = patched(target);
  await platformAudit({ action: "PRICE_VERSION_PUBLISH", targetOrgCode: home.code, subject: `price-version:${key}`, before: { versionKey: current.key, planKey: target.planKey, monthlyVnd: target.monthlyVnd, yearlyFreeMonths: target.yearlyFreeMonths, addonPrices: target.addonPrices }, after: { versionKey: key, planKey: after.planKey, monthlyVnd: after.monthlyVnd, yearlyFreeMonths: after.yearlyFreeMonths, addonPrices: after.addonPrices }, reason: input.reason, source: input.source ?? "UI", actor: input.actor });
  return { ok: true, versionKey: key };
}

function rowOverage(p: PlanPrice): Record<string, unknown> {
  const o = p.overage;
  if (o.mode === "UNDECLARED") return {};
  const out: Record<string, unknown> = { mode: o.mode };
  if (o.aiCustomerBlockSize !== null) out.aiCustomerBlockSize = o.aiCustomerBlockSize;
  if (o.aiCustomerBlockVnd !== null) out.aiCustomerBlockVnd = o.aiCustomerBlockVnd;
  if (o.extraFanpageVnd !== null) out.extraFanpageVnd = o.extraFanpageVnd;
  if (o.extraUserVnd !== null) out.extraUserVnd = o.extraUserVnd;
  return out;
}

export { LEGACY_VERSION_KEY };
