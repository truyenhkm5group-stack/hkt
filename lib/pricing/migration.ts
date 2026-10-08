/**
 * ═══════════ CHUYỂN TỔ CHỨC TỪ GIÁ CŨ (LEGACY) SANG BẢNG GIÁ V1 — CHẠY THỬ MẶC ĐỊNH — CHỈ MÁY CHỦ (docs/saas/V1_MIGRATION.md) ═══════════
 *
 * Chủ shop giao 08/10/2026: «chuyển các tổ chức từ giá cũ sang bảng giá V1 — làm theo phương án tốt nhất». Phương án tốt nhất ở đây
 * = AN TOÀN, KHÔNG BẤT NGỜ CHO KHÁCH, CÓ SỐ TRƯỚC KHI GHI:
 *
 *  · `planV1Migration` (CHỈ ĐỌC) — với MỖI tổ chức đủ điều kiện in phiên bản / gói hiện tại, số dùng thật (fanpage đang nối · người
 *    dùng hoạt động · khách AI 30 ngày theo đồng hồ + ƯỚC từ sổ AI), gói V1 ĐỀ XUẤT (`smallestFittingPlan` — CÙNG luật với khách
 *    nội bộ, không luật thứ hai), giá tháng cũ → mới, phần vượt DỰ KIẾN (cùng `computeOverage` + `billableIncluded` của bảng kê),
 *    cờ thu phí, và MỌI hệ quả chặn / đổi hạn mức sẽ xảy ra nếu ghim.
 *  · `applyV1Migration` — MỘT tổ chức mỗi lần, gói do người chỉ định: ghi cột gói (`platform_organizations.plan`, cột `planKeyOf`
 *    đọc) + ghim phiên bản CATALOG hiện hành (`pinOrgPriceVersion` — đúng đường ghim của người vận hành, nguồn ghim `OPERATOR`) +
 *    nhật ký nền tảng `ORG_PLAN_SET` + `PRICE_VERSION_PIN` nguồn SCRIPT. KHÔNG bật thu phí, KHÔNG tạo hoá đơn, KHÔNG chạm điều
 *    khoản dùng thử (`platform_subscriptions` không bị ghi một ô nào): chỉ đổi GIÁ THAM CHIẾU. Bật thu phí là bước riêng của người
 *    vận hành sau khi đã báo khách.
 *
 * Bị loại khỏi lượt chuyển (không bao giờ ghi):
 *  · cửa hàng TỰ ĐĂNG KÝ (`brand` ≠ NULL) — sinh ra sau 0228 đã theo bảng giá hiện hành; ba cửa hàng cũ sắp bị xoá (PR #673);
 *  · tổ chức đã ở một phiên bản CATALOG (đã V1 hoặc mới hơn);
 *  · tổ chức ghim một phiên bản RIÊNG không phải `legacy` (vd «Trả trước theo khách AI» — PR #674);
 *  · tổ chức HOÃN có lý do (`V1_MIGRATION_DEFERRED`) — HSLC đi lộ trình trả trước, không đi V1;
 *  · tổ chức ARCHIVED / SETUP_FAILED;
 *  · workspace NHÀ — bất biến «nhà không đổi gói qua đường khách» (lib/platform/org-plan.ts, applyInvoicePaid, PRICING_V1 §9):
 *    gói thường cho nhà đi `scripts/pricing-internal-fit.ts` (đo trọn kỳ). Chạy thử vẫn in số dùng + cận dưới của nhà.
 *
 * Từ chối ghim khi việc ghim sẽ làm khách BẤT NGỜ: gói đích nhỏ hơn số dùng (phần vượt — trừ khi `acceptOverage`), số dùng chưa
 * đo được (trừ khi `acceptOverage`), mất tính năng đang có, mất AI bán hàng, trần AI sau khi ghim chặn lượt AI mà hôm nay chạy
 * được (kể cả bot dùng khoá riêng BYOK), Số dư AI đang bật (V1 sẽ trừ số dư / chặn khách mới khi hết), có hoá đơn đang mở (trả
 * hoá đơn ấy ghim NGƯỢC tổ chức về phiên bản của hoá đơn), thu phí đang bật (lần gia hạn kế đổi số tiền — trừ khi
 * `acceptBillingOn`), thuê bao Chốt Đơn mang gói riêng khác gói đích, số đếm THẬT vượt trần KỸ THUẬT của gói đích (người dùng · trang
 * · đối tượng · bản ghi · luật · bản nháp AI · dung lượng — `checkEntitlement` sẽ từ chối lượt tạo kế tiếp), và trần kỹ thuật / nhịp
 * luật tự động THẤP HƠN hôm nay (trừ khi `acceptLowerLimits`).
 */
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, readOnlyMode, schema } from "@/db";
import { applyAiOverride, evaluateAiQuota, HOME_AI_LIMITS, parseAiLimits, type AiBillingSource, type AiLimits, type AiQuotaVerdict } from "@/lib/ai-usage/types";
import { readOrgAiControl } from "@/lib/ai-usage/control";
import { sourceUsage } from "@/lib/ai-usage/ledger";
import { resolveAiLimits } from "@/lib/ai-usage/quota";
import { aiBalanceEnabled } from "@/lib/billing/ai-balance";
import { applyAddons, parseAddonPrices, parseAddonUnits, ADDON_KINDS, type AddonUnits } from "@/lib/billing/addons";
import { parseWorkflowCadence } from "@/lib/constants/workflow-cadence";
import { countEntitlementUsage, listPlans, planKeyOf, resolvePlan, type PlanRow } from "@/lib/entitlements/check";
import { DEFAULT_PLAN_KEY, ENTITLEMENT_KINDS, ENTITLEMENT_SPEC, parseLimits, type EntitlementKind, type PlanLimits } from "@/lib/entitlements/kinds";
import { env } from "@/lib/env";
import type { PlatformAuditSource } from "@/lib/platform/audit";
import { AI_BALANCE_FLAG } from "@/lib/platform/org-flags";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { findOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { readFanpagesActive } from "@/lib/platform/saas-ledger";
import { rowsOf } from "@/lib/sql-rows";
import type { Organization } from "@/lib/platform/types";
import { invalidateAiEntitlement } from "@/lib/pricing/ai-gate";
import { readAiCustomerUsage } from "@/lib/pricing/ai-customer";
import { parseCommercial } from "@/lib/pricing/catalog";
import { invalidatePricing, readOrgPricingRow, resolveOrgPricing } from "@/lib/pricing/entitlements";
import { FEATURE_KEYS, featureGranted, type FeatureKey } from "@/lib/pricing/features";
import { invalidatePriceBook, loadPriceBook, orgPriceVersion, pinOrgPriceVersion, readMarginConfig } from "@/lib/pricing/price-book";
import {
  billableIncluded,
  catalogAiLimits,
  computeOverage,
  currentCatalogVersion,
  isSellable,
  LEGACY_VERSION_KEY,
  overlayPlanRow,
  priceOf,
  smallestFittingPlan,
  type FitResult,
  type MeterCoverage,
  type OverageResult,
  type PlanPrice,
  type PriceBook,
  type PriceVersion,
} from "@/lib/pricing/versions";

export const V1_MIGRATION_EMAIL = "script:saas-v1-migration";
/** Cửa sổ đo số dùng: 30 ngày tính tới lúc chạy (giờ máy chủ). */
export const V1_USAGE_WINDOW_DAYS = 30;
/** Tính năng của AI Bán hàng trên sổ AI có mã hội thoại — nguồn ƯỚC khách AI khi đồng hồ chưa đo trọn cửa sổ. */
export const V1_SALES_AI_FEATURE = "sales_chatbot";

/**
 * Tổ chức HOÃN khỏi lượt chuyển V1 — mã tổ chức ⇒ lý do (in ra màn chạy thử). Không phải gói ẩn: hoãn chỉ có nghĩa «không đổi giá
 * tham chiếu trong lượt này»; tổ chức vẫn ở giá cũ cho tới khi lộ trình riêng của nó chạy.
 * TẠM: XOÁ dòng HSLC khi #674 đã ghim `hslc-hmt-shop` vào `prepaid-ai-v1` — khi đó luật «phiên bản riêng» (SPECIAL_VERSION) loại nó.
 */
export const V1_MIGRATION_DEFERRED: Readonly<Record<string, string>> = {
  "hslc-hmt-shop": "Đi lộ trình «Trả trước theo khách AI» (PR #674 · ops org-prepaid-ai) — không chuyển V1 trong lượt này.",
};

/**
 * Lượt CHẠY THỬ có thật sự chỉ đọc không: tiến trình đặt `ERP_READ_ONLY=1` VÀ Postgres xác nhận `default_transaction_read_only = on`
 * cho kết nối CSDL nền tảng (hỏi CSDL, không tin biến môi trường — cùng lối của ops org-ai-cutover).
 */
export async function platformReadOnlyConfirmed(): Promise<boolean> {
  if (!readOnlyMode()) return false;
  const pdb = await getPlatformDb();
  const [ro] = rowsOf<Record<string, unknown>>(await pdb.execute(sql`show default_transaction_read_only`));
  return String(ro?.default_transaction_read_only ?? "") === "on";
}

// ─────────────────────────── Phân loại (thuần) ───────────────────────────

export type V1Exclusion = "SELF_SIGNUP" | "HOME" | "NOT_ACTIVE" | "DEFERRED" | "ALREADY_CATALOG" | "SPECIAL_VERSION";
export const V1_EXCLUSION_LABEL: Record<V1Exclusion, string> = {
  SELF_SIGNUP: "Cửa hàng tự đăng ký (brand ≠ NULL) — không thuộc lượt chuyển",
  HOME: "Workspace NHÀ — không đổi gói qua lượt chuyển khách; gán gói thường cho nhà bằng scripts/pricing-internal-fit.ts khi khách AI đo trọn kỳ",
  NOT_ACTIVE: "Tổ chức không hoạt động (lưu trữ / dựng hỏng)",
  DEFERRED: "Hoãn có lý do",
  ALREADY_CATALOG: "Đã ở bảng giá niêm yết (V1 trở lên)",
  SPECIAL_VERSION: "Đang ở một phiên bản giá RIÊNG (không phải giá cũ) — không đổi",
};

/** Tổ chức có thuộc lượt chuyển V1 không. `version` = phiên bản ĐANG ÁP (sau luật ghim / nhà). HÀM THUẦN. */
export function classifyForV1(input: { org: Pick<Organization, "code" | "status" | "brand" | "isHome">; pinKey: string | null; version: Pick<PriceVersion, "key" | "kind"> | null; deferred?: Readonly<Record<string, string>> }): { eligible: true } | { eligible: false; exclusion: V1Exclusion; note: string } {
  const deferred = input.deferred ?? V1_MIGRATION_DEFERRED;
  const no = (exclusion: V1Exclusion, note?: string) => ({ eligible: false as const, exclusion, note: note ?? V1_EXCLUSION_LABEL[exclusion] });
  if (input.org.brand) return no("SELF_SIGNUP", `${V1_EXCLUSION_LABEL.SELF_SIGNUP} (brand ${input.org.brand}).`);
  if (input.org.isHome) return no("HOME");
  if (input.org.status === "ARCHIVED" || input.org.status === "SETUP_FAILED") return no("NOT_ACTIVE", `${V1_EXCLUSION_LABEL.NOT_ACTIVE} (${input.org.status}).`);
  if (deferred[input.org.code]) return no("DEFERRED", deferred[input.org.code]);
  if (input.version?.kind === "CATALOG") return no("ALREADY_CATALOG", `${V1_EXCLUSION_LABEL.ALREADY_CATALOG} — phiên bản «${input.version.key}».`);
  if (input.pinKey && input.pinKey !== LEGACY_VERSION_KEY) return no("SPECIAL_VERSION", `${V1_EXCLUSION_LABEL.SPECIAL_VERSION} — ghim «${input.pinKey}».`);
  return { eligible: true };
}

// ─────────────────────────── Sự thật đọc được của một tổ chức ───────────────────────────

/** Khách AI của cửa sổ 30 ngày: đồng hồ (cận dưới khi chưa trọn) + ước từ sổ AI (số hội thoại có lượt AI bán hàng). */
export type AiCustomerEstimate = {
  meter: number | null;
  meterCoverage: MeterCoverage;
  meterNote: string | null;
  /** Số hội thoại KHÁC NHAU có lượt AI bán hàng thành công trong cửa sổ (`conversation_id`, thiếu thì `ref`). */
  ledgerConversations: number | null;
  /** Lượt AI bán hàng không mang mã hội thoại — có thì số ước KHÔNG chắc là cận trên. */
  ledgerUnattributed: number | null;
  /** Số dùng để chọn gói = lớn nhất của các số đo được (phía an toàn). `null` = chưa đo được (runtime cũ / không đọc được). */
  basis: number | null;
  basisNote: string;
};

/** Số dùng để chọn gói — THUẦN: đồng hồ CHƯA ĐO (runtime cũ không ghi đồng hồ lẫn có thể không ghi sổ) ⇒ không ước. */
export function aiCustomerBasis(input: Omit<AiCustomerEstimate, "basis" | "basisNote">): { basis: number | null; basisNote: string } {
  if (input.meterCoverage === "NOT_MEASURED") return { basis: null, basisNote: `Chưa đo được khách AI${input.meterNote ? ` — ${input.meterNote}` : ""}.` };
  const known = [input.meter, input.ledgerConversations].filter((n): n is number => n !== null);
  if (!known.length) return { basis: null, basisNote: "Không đọc được đồng hồ lẫn sổ AI." };
  const basis = Math.max(...known);
  const parts = [
    input.meterCoverage === "MEASURED" ? "đồng hồ đo trọn cửa sổ" : "đồng hồ chưa trọn cửa sổ (cận dưới)",
    input.ledgerConversations !== null ? `ước từ sổ AI = số hội thoại có lượt AI bán hàng (CẬN TRÊN cho tin nhắn riêng${input.ledgerUnattributed ? `; ${input.ledgerUnattributed} lượt không mang mã hội thoại — không chắc là cận trên` : ""}; một luồng bình luận nhiều người có thể là nhiều khách)` : null,
    "khoá đồng hồ theo tháng lịch ⇒ cửa sổ cắt qua hai tháng có thể đếm một khách hai lần",
  ].filter(Boolean);
  return { basis, basisNote: `Lấy LỚN NHẤT (phía an toàn): ${parts.join(" · ")}.` };
}

export type AiQuotaPair = Record<Exclude<AiBillingSource, "HOME">, { ok: boolean; reason: string | null }>;

export type V1OrgFacts = {
  org: Pick<Organization, "code" | "name" | "status" | "isHome" | "plan" | "brand">;
  planKey: string;
  pinKey: string | null;
  version: PriceVersion | null;
  currentPrice: PlanPrice | null;
  catalog: PriceVersion | null;
  catalogPrices: PlanPrice[];
  plans: PlanRow[];
  usage: { aiCustomers: AiCustomerEstimate; fanpages: number | null; users: number | null; needsAiSales: boolean };
  /** Trần KỸ THUẬT (`resolvePlan`: gói theo phiên bản + mua thêm) và số đếm THẬT (cùng bộ đếm `checkEntitlement`). `null` = không đọc được. */
  entitlements: { before: PlanLimits | null; counts: Record<EntitlementKind, number | null> | null; cadenceBeforeMinutes: number };
  addons: AddonUnits;
  quotaOverrides: unknown;
  grandfathered: boolean;
  featureOverrides: Partial<Record<FeatureKey, boolean>>;
  featuresBefore: FeatureKey[];
  billing: { enabled: boolean; paidThrough: string | null; openInvoices: number };
  aiBalanceOn: boolean;
  chotdonOwnPlanKey: string | null;
  ai: { override: Parameters<typeof applyAiOverride>[1]; before: AiLimits | null; usage: Record<"BYOK" | "PLATFORM", Parameters<typeof evaluateAiQuota>[2]> | null; criticalBelowPct: number };
  readErrors: string[];
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/** Khách AI 30 ngày: đồng hồ (`readAiCustomerUsage`) + số hội thoại có lượt AI bán hàng trong sổ AI. */
async function readAiCustomerEstimate(org: Organization, from: Date, now: Date): Promise<AiCustomerEstimate> {
  const reading = (await readAiCustomerUsage([org.code], { from, to: now }, now)).get(org.code) ?? { value: null, coverage: "NOT_MEASURED" as const, note: null };
  let ledgerConversations: number | null = null;
  let ledgerUnattributed: number | null = null;
  try {
    const pdb = await getPlatformDb();
    const a = schema.platformAiUsage;
    const [r] = await pdb
      .select({
        conv: sql<number>`count(distinct coalesce(${a.conversationId}, ${a.ref}))::int`,
        bare: sql<number>`count(*) filter (where ${a.conversationId} is null and ${a.ref} is null)::int`,
      })
      .from(a)
      .where(and(eq(a.orgCode, org.code), eq(a.feature, V1_SALES_AI_FEATURE), eq(a.status, "OK"), gte(a.at, from)));
    ledgerConversations = Number(r?.conv ?? 0);
    ledgerUnattributed = Number(r?.bare ?? 0);
  } catch {
    ledgerConversations = null;
  }
  const base = { meter: reading.value, meterCoverage: reading.coverage, meterNote: reading.note, ledgerConversations, ledgerUnattributed };
  return { ...base, ...aiCustomerBasis(base) };
}

/** Đọc mọi sự thật của MỘT tổ chức — CHỈ ĐỌC (CSDL tổ chức mở bằng `getDbForInspection`: không migrate, không ghi). */
export async function readV1Facts(org: Organization, now: Date, ctx?: { book: PriceBook; plans: PlanRow[] }): Promise<V1OrgFacts> {
  const readErrors: string[] = [];
  const book = ctx?.book ?? (await loadPriceBook({ fresh: true }));
  const plans = ctx?.plans ?? (await listPlans());
  const catalog = currentCatalogVersion(book, now);
  const catalogPrices = catalog ? book.prices.filter((p) => p.versionKey === catalog.key).sort((a, b) => a.position - b.position) : [];
  invalidatePriceBook(org.code);
  const v = await orgPriceVersion(org.code, now);
  const planKey = planKeyOf(org);
  const currentPrice = priceOf(book, v.version?.key, planKey)?.price ?? null;
  const from = new Date(now.getTime() - V1_USAGE_WINDOW_DAYS * 86_400_000);
  const aiCustomers = await readAiCustomerEstimate(org, from, now);

  let fanpages: number | null = null;
  let counts: Record<EntitlementKind, number | null> | null = null;
  try {
    const db = await getDbForInspection(org);
    fanpages = await readFanpagesActive(db);
    // CÙNG bộ đếm với `checkEntitlement` (người dùng đang bật · trang · đối tượng · bản ghi · luật · bản nháp AI hôm nay · dung lượng).
    counts = await countEntitlementUsage(db);
  } catch (e) {
    readErrors.push(`CSDL tổ chức: ${errText(e)}`);
  }
  const users = counts?.users ?? null;
  let limitsBefore: PlanLimits | null = null;
  try {
    limitsBefore = (await resolvePlan(org))?.limits ?? null;
    if (!limitsBefore) readErrors.push("không đọc được trần kỹ thuật của gói hiện tại");
  } catch (e) {
    readErrors.push(`trần kỹ thuật: ${errText(e)}`);
  }
  // Nhịp luật tự động đọc ĐÚNG như `workflowCadenceOf` (lib/workflow/scheduled.ts): dòng `platform_plans` của gói, lạ ⇒ `trial`.
  const cadenceRow = plans.find((p) => p.key === planKey) ?? plans.find((p) => p.key === DEFAULT_PLAN_KEY);
  const cadenceBeforeMinutes = parseWorkflowCadence(cadenceRow?.limits).minutes;

  const pdb = await getPlatformDb();
  let needsAiSales = true;
  let chotdonOwnPlanKey: string | null = null;
  try {
    const subs = await pdb
      .select({ productKey: schema.platformProductSubscriptions.productKey, planKey: schema.platformProductSubscriptions.planKey })
      .from(schema.platformProductSubscriptions)
      .where(and(eq(schema.platformProductSubscriptions.orgCode, org.code), isNull(schema.platformProductSubscriptions.endedAt)));
    const modules = await getEnabledModules(org.code);
    // Có thuê bao Chốt Đơn HOẶC module AI bán hàng đang bật ⇒ cần AI bán hàng (rộng hơn = an toàn hơn: không bao giờ đề xuất Inbox
    // cho một tổ chức bot đang chạy).
    needsAiSales = subs.some((s) => s.productKey === "chotdon") || modules.has("ai_sales");
    chotdonOwnPlanKey = subs.find((s) => s.productKey === "chotdon" && s.planKey)?.planKey ?? null;
  } catch (e) {
    readErrors.push(`thuê bao / module: ${errText(e)}`);
  }

  let billing = { enabled: false, paidThrough: null as string | null, openInvoices: 0 };
  let addons: AddonUnits = {};
  try {
    const [sub] = await pdb.select().from(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, org.code)).limit(1);
    const [open] = await pdb
      .select({ n: count() })
      .from(schema.platformInvoices)
      .where(and(eq(schema.platformInvoices.orgCode, org.code), eq(schema.platformInvoices.status, "OPEN")));
    billing = { enabled: sub?.billingEnabled === true, paidThrough: sub?.paidThrough ?? null, openInvoices: Number(open?.n ?? 0) };
    addons = parseAddonUnits(sub?.addons);
  } catch (e) {
    readErrors.push(`thu phí: ${errText(e)}`);
  }

  let aiBalanceOn = false;
  try {
    aiBalanceOn = await aiBalanceEnabled(org.code);
  } catch (e) {
    readErrors.push(`Số dư AI: ${errText(e)}`);
  }

  const row = await readOrgPricingRow(org.code, { fresh: true });
  const pricing = await resolveOrgPricing(org);
  const featuresBefore = FEATURE_KEYS.filter((key) => featureGranted({ key, grandfathered: row.grandfathered, overrides: row.featureOverrides, planFeatures: pricing.plan?.commercial.features ?? null }).granted);

  let aiBefore: AiLimits | null = null;
  let aiUsage: V1OrgFacts["ai"]["usage"] = null;
  let override: V1OrgFacts["ai"]["override"] = {};
  try {
    const control = await readOrgAiControl(org.code, { fresh: true });
    override = control.limits;
    aiBefore = (await resolveAiLimits(org.code))?.limits ?? null;
    aiUsage = { BYOK: await sourceUsage(org.code, "BYOK", now), PLATFORM: await sourceUsage(org.code, "PLATFORM", now) };
  } catch (e) {
    readErrors.push(`hạn mức AI: ${errText(e)}`);
  }
  const margin = await readMarginConfig();

  return {
    org: { code: org.code, name: org.name, status: org.status, isHome: org.isHome, plan: org.plan, brand: org.brand ?? null },
    planKey,
    pinKey: v.pinKey,
    version: v.version,
    currentPrice,
    catalog,
    catalogPrices,
    plans,
    usage: { aiCustomers, fanpages, users, needsAiSales },
    entitlements: { before: limitsBefore, counts, cadenceBeforeMinutes },
    addons,
    quotaOverrides: row.quotaOverrides,
    grandfathered: row.grandfathered,
    featureOverrides: row.featureOverrides,
    featuresBefore,
    billing,
    aiBalanceOn,
    chotdonOwnPlanKey,
    ai: { override, before: aiBefore, usage: aiUsage, criticalBelowPct: margin.criticalBelowPct },
    readErrors,
  };
}

// ─────────────────────────── Đánh giá một gói đích (thuần) ───────────────────────────

export type V1BlockerCode =
  | "NO_CATALOG"
  | "TARGET_NOT_IN_CATALOG"
  | "TARGET_NOT_SELLABLE"
  | "NO_AI_SALES"
  | "FEATURE_LOSS"
  | "AI_WOULD_BLOCK"
  | "AI_BALANCE_ON"
  | "OPEN_INVOICE"
  | "BILLING_ON"
  | "ADDON_NOT_SOLD"
  | "CHOTDON_OWN_PLAN"
  | "USAGE_UNKNOWN"
  | "OVERAGE_EXPECTED"
  | "ENTITLEMENT_BELOW_USAGE"
  | "LOWER_LIMITS"
  | "READ_FAILED";

/** Cờ người bấm có thể chấp nhận một chặn — `null` = không bao giờ vượt bằng cờ. */
export type V1Override = "ACCEPT_OVERAGE" | "ACCEPT_BILLING_ON" | "ACCEPT_LOWER_LIMITS";
export type V1Blocker = { code: V1BlockerCode; message: string; override: V1Override | null };

export type V1Assessment = {
  target: PlanPrice | null;
  priceBeforeVnd: number | null;
  priceAfterVnd: number | null;
  /** Phần vượt DỰ KIẾN theo số dùng ƯỚC (không phải hoá đơn) — cùng `computeOverage` + `billableIncluded` của bảng kê. */
  overage: OverageResult | null;
  featuresLost: FeatureKey[];
  /** Trần kỹ thuật SAU khi ghim (gói đích theo phiên bản + mua thêm) — so với `facts.entitlements.before`. */
  limitsAfter: PlanLimits | null;
  aiBefore: AiQuotaPair | null;
  aiAfter: AiQuotaPair | null;
  blockers: V1Blocker[];
  warnings: string[];
};

const vnd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toLocaleString("vi-VN")} ₫`);

function quotaPair(limits: AiLimits | null, usage: V1OrgFacts["ai"]["usage"]): AiQuotaPair | null {
  if (!limits || !usage) return null;
  const one = (s: "BYOK" | "PLATFORM") => {
    const v: AiQuotaVerdict = evaluateAiQuota(s, limits, usage[s]);
    return { ok: v.ok, reason: v.ok ? null : v.reason };
  };
  return { BYOK: one("BYOK"), PLATFORM: one("PLATFORM") };
}

/** Trần AI mà runtime SẼ áp sau khi ghim gói đích — CÙNG đường `resolveAiLimits` (phiên bản CATALOG ⇒ `catalogAiLimits`). */
export function aiLimitsAfter(facts: Pick<V1OrgFacts, "org" | "catalog" | "catalogPrices" | "plans" | "ai">, target: PlanPrice): AiLimits {
  if (facts.org.isHome) return HOME_AI_LIMITS;
  const versioned = catalogAiLimits({ hit: { price: target, source: "VERSION" }, versionKind: facts.catalog?.kind ?? null, versionPrices: facts.catalogPrices, criticalBelowPct: facts.ai.criticalBelowPct, usdToVnd: env.facebook.usdToVnd });
  const base = versioned ?? parseAiLimits(facts.plans.find((p) => p.key === target.planKey)?.limits).limits;
  return applyAiOverride(base, facts.ai.override);
}

/** Trần KỸ THUẬT sau khi ghim — CÙNG phép của `resolvePlan`: dòng gói phủ phiên bản CATALOG (`overlayPlanRow`) + phần đã mua thêm. */
export function technicalLimitsAfter(facts: Pick<V1OrgFacts, "plans" | "catalog" | "addons">, target: PlanPrice): PlanLimits {
  const row: PlanRow = facts.plans.find((p) => p.key === target.planKey) ?? { key: target.planKey, name: target.name, description: target.description, limits: target.limits, position: target.position, priceVnd: null, addonPrices: {}, yearlyFreeMonths: 0, commercial: target.commercial };
  return applyAddons(parseLimits(overlayPlanRow(row, { price: target, source: "VERSION" }, facts.catalog?.kind ?? "CATALOG").limits).limits, facts.addons);
}

const fmtLimit = (n: number | null) => (n === null ? "không giới hạn" : n.toLocaleString("vi-VN", { maximumFractionDigits: 1 }));

/** Tính năng gói đích cấp (sau ghi đè / giữ từ trước của CHÍNH tổ chức) — CÙNG phép phủ `overlayPlanRow` + `featureGranted`. */
export function featuresAfter(facts: Pick<V1OrgFacts, "plans" | "grandfathered" | "featureOverrides" | "catalog">, target: PlanPrice): FeatureKey[] {
  const row: PlanRow = facts.plans.find((p) => p.key === target.planKey) ?? { key: target.planKey, name: target.name, description: target.description, limits: target.limits, position: target.position, priceVnd: null, addonPrices: {}, yearlyFreeMonths: 0, commercial: target.commercial };
  const overlaid = overlayPlanRow(row, { price: target, source: "VERSION" }, facts.catalog?.kind ?? "CATALOG");
  const planFeatures = parseCommercial(overlaid.commercial).features;
  return FEATURE_KEYS.filter((key) => featureGranted({ key, grandfathered: facts.grandfathered, overrides: facts.featureOverrides, planFeatures }).granted);
}

/** Đánh giá việc ghim tổ chức vào gói `targetKey` của bảng giá hiện hành. HÀM THUẦN (sự thật đã đọc ở `readV1Facts`). */
export function assessV1Target(facts: V1OrgFacts, targetKey: string | null): V1Assessment {
  const blockers: V1Blocker[] = [];
  const warnings: string[] = [];
  const block = (code: V1BlockerCode, message: string, override: V1Override | null = null) => blockers.push({ code, message, override });
  const target = targetKey ? (facts.catalogPrices.find((p) => p.planKey === targetKey) ?? null) : null;
  const priceBeforeVnd = facts.currentPrice && !facts.currentPrice.contactSales ? facts.currentPrice.monthlyVnd : null;
  const empty: V1Assessment = { target, priceBeforeVnd, priceAfterVnd: null, overage: null, featuresLost: [], limitsAfter: null, aiBefore: quotaPair(facts.ai.before, facts.ai.usage), aiAfter: null, blockers, warnings };
  if (!facts.catalog) {
    block("NO_CATALOG", "Chưa có bảng giá niêm yết (CATALOG) đang hiệu lực.");
    return empty;
  }
  if (!targetKey) return empty;
  if (!target) {
    block("TARGET_NOT_IN_CATALOG", `Gói «${targetKey}» không có trong bảng giá «${facts.catalog.key}».`);
    return empty;
  }
  if (!isSellable(target) || target.trialDays !== null) {
    block("TARGET_NOT_SELLABLE", target.contactSales ? `«${target.name}» ký theo hợp đồng — lập tay, không qua script.` : `«${target.name}» không phải gói thường tự mua (dùng thử / không giá) — ghim vào đó sẽ bật luật dùng thử (AI dừng khi hết lượt / hết hạn).`);
    return empty;
  }
  if (facts.readErrors.length) block("READ_FAILED", `Không đọc đủ sự thật để ghim an toàn: ${facts.readErrors.join(" · ")}`);

  // Tính năng: mất AI bán hàng là riêng một chặn (bot im với khách); mất tính năng khác cũng chặn — chọn gói lớn hơn hoặc ghi đè trước.
  const after = featuresAfter(facts, target);
  const featuresLost = facts.featuresBefore.filter((k) => !after.includes(k));
  if (facts.usage.needsAiSales && !after.includes("ai_sales")) block("NO_AI_SALES", `«${target.name}» không có AI bán hàng mà tổ chức đang dùng — bot sẽ ngừng trả lời.`);
  const otherLost = featuresLost.filter((k) => k !== "ai_sales" || !facts.usage.needsAiSales);
  if (otherLost.length) block("FEATURE_LOSS", `Ghim «${target.name}» làm mất tính năng đang có: ${otherLost.join(", ")} — chọn gói lớn hơn hoặc khai ghi đè tính năng trước.`);

  // Trần AI kỹ thuật trước / sau — CÙNG phép so `evaluateAiQuota` của runtime, cho cả khoá riêng (BYOK) lẫn AI dùng chung.
  const aiBefore = quotaPair(facts.ai.before, facts.ai.usage);
  const aiAfter = quotaPair(aiLimitsAfter(facts, target), facts.ai.usage);
  if (aiBefore && aiAfter) {
    for (const s of ["BYOK", "PLATFORM"] as const) {
      if (aiBefore[s].ok && !aiAfter[s].ok) block("AI_WOULD_BLOCK", `Sau khi ghim, trần AI (${s === "BYOK" ? "khoá riêng của tổ chức" : "AI dùng chung"}) sẽ CHẶN lượt AI đang chạy được hôm nay (${aiAfter[s].reason}).`);
    }
    const hardBefore = facts.ai.before && !facts.ai.before.softOnly && facts.ai.before.platformCreditUsdPerMonth > 0;
    const afterLimits = aiLimitsAfter(facts, target);
    if (hardBefore && afterLimits.softOnly) warnings.push("Credit AI dùng chung đổi từ trần CỨNG sang NGÂN SÁCH MỀM (luật V1: không tắt Sales AI vì hạn mức) — chi phí AI nền tảng không còn bị chặn ở credit; theo dõi ở /platform/saas.");
  } else if (!facts.org.isHome) {
    block("READ_FAILED", "Không đọc được trần / mức dùng AI — không kết luận được việc ghim có chặn AI không.");
  }

  if (facts.aiBalanceOn) block("AI_BALANCE_ON", "Số dư AI đang BẬT: ở V1 khách AI vượt phần gồm bị trừ số dư và hết số dư thì khách MỚI không nhận AI — tắt cờ hoặc đi lộ trình trả trước trước khi chuyển.");
  if (facts.billing.openInvoices > 0) block("OPEN_INVOICE", `Có ${facts.billing.openInvoices} hoá đơn đang mở — trả hoá đơn ấy sẽ ghim tổ chức NGƯỢC về phiên bản của hoá đơn. Huỷ / chờ trả xong rồi chuyển.`);
  if (facts.billing.enabled) block("BILLING_ON", `Thu phí đang BẬT (trả tới ${facts.billing.paidThrough ?? "—"}) — lần gia hạn kế tính theo giá V1 (${vnd(target.monthlyVnd)}/tháng). Báo trước khách rồi mới chuyển.`, "ACCEPT_BILLING_ON");
  const sold = parseAddonPrices(target.addonPrices);
  const unsold = ADDON_KINDS.filter((k) => (facts.addons[k] ?? 0) > 0 && sold[k] === undefined);
  if (unsold.length) {
    const msg = `Tổ chức đã mua thêm ${unsold.join(", ")} mà «${target.name}» không bán — báo giá gia hạn sẽ từ chối cho tới khi người vận hành gỡ phần đó.`;
    if (facts.billing.enabled) block("ADDON_NOT_SOLD", msg);
    else warnings.push(msg);
  }
  if (facts.chotdonOwnPlanKey && facts.chotdonOwnPlanKey !== target.planKey) block("CHOTDON_OWN_PLAN", `Thuê bao Chốt Đơn mang gói riêng «${facts.chotdonOwnPlanKey}» (bảng kê tính phần vượt theo gói ấy) — khác gói đích; sửa thuê bao trước.`);

  // Trần KỸ THUẬT (`checkEntitlement`) — giá chỉ là một nửa: hạ trần làm lượt TẠO kế tiếp bị từ chối dù không ai trả thêm đồng nào.
  const limitsAfter = technicalLimitsAfter(facts, target);
  const ent = facts.entitlements;
  if (!ent.before || !ent.counts) block("READ_FAILED", "Không đọc được trần kỹ thuật / số đếm thật — không kết luận được việc ghim có chặn lượt tạo nào không.");
  else {
    const below: string[] = [];
    const lower: string[] = [];
    for (const k of ENTITLEMENT_KINDS) {
      const used = ent.counts[k];
      const cap = limitsAfter[k];
      const was = ent.before[k];
      const s = ENTITLEMENT_SPEC[k];
      if (used !== null && cap !== null && used > cap) below.push(`${s.label.toLowerCase()} đang có ${fmtLimit(used)} > trần mới ${fmtLimit(cap)} ${s.unit}`);
      if (cap !== null && (was === null || cap < was)) lower.push(`${s.label.toLowerCase()} ${fmtLimit(was)} → ${fmtLimit(cap)}`);
    }
    const cadenceAfter = parseWorkflowCadence(facts.plans.find((p) => p.key === target.planKey)?.limits).minutes;
    if (cadenceAfter > ent.cadenceBeforeMinutes) lower.push(`nhịp luật tự động ${ent.cadenceBeforeMinutes} → ${cadenceAfter} phút`);
    if (below.length) block("ENTITLEMENT_BELOW_USAGE", `Số đang dùng THẬT vượt trần kỹ thuật của «${target.name}»: ${below.join(" · ")} — mọi lượt tạo thêm loại ấy bị từ chối ngay sau khi ghim. Chọn gói lớn hơn.`);
    if (lower.length) block("LOWER_LIMITS", `Trần kỹ thuật của «${target.name}» THẤP HƠN hôm nay: ${lower.join(" · ")}.`, "ACCEPT_LOWER_LIMITS");
    const usersCap = limitsAfter.users;
    if (ent.counts.users !== null && usersCap !== null && ent.counts.users === usersCap) warnings.push(`Người dùng đã CHẠM trần mới (${fmtLimit(usersCap)}) — sau khi ghim KHÔNG thêm được người dùng nào cho tới khi mua thêm ghế / nâng gói.`);
  }

  // Phần vượt DỰ KIẾN với phần gồm TÍNH TIỀN (dòng giá + ghi đè + ghế đã mua thêm) — số dùng ƯỚC coi như đo trọn để ra con số.
  const included = billableIncluded(target.included, { quotaOverrides: facts.quotaOverrides, addons: facts.addons });
  const basis = facts.usage.aiCustomers.basis;
  const overage = computeOverage({ ...target, included }, { aiCustomers: basis, aiCustomersCoverage: basis === null ? "NOT_MEASURED" : "MEASURED", fanpages: facts.usage.fanpages, users: facts.usage.users, aiConversations: null, aiReplies: null });
  const unknown = overage.lines.filter((l) => l.amountVnd === null).map((l) => l.label);
  if (unknown.length) block("USAGE_UNKNOWN", `Chưa đo được: ${unknown.join(", ")} — không khẳng định được gói vừa số dùng.`, "ACCEPT_OVERAGE");
  if (overage.knownVnd > 0) {
    const over = overage.lines.filter((l) => (l.amountVnd ?? 0) > 0).map((l) => `${l.label} ${l.overUnits?.toLocaleString("vi-VN")} → ${vnd(l.amountVnd)}${l.key === "users" ? " (và KHÔNG thêm được người dùng: trần kỹ thuật = phần gồm + ghế đã mua)" : ""}`);
    block("OVERAGE_EXPECTED", `«${target.name}» nhỏ hơn số dùng thật — phần vượt dự kiến ${vnd(overage.knownVnd)}/tháng (${over.join(" · ")}).`, "ACCEPT_OVERAGE");
  }
  if (facts.org.status === "SUSPENDED") warnings.push("Tổ chức đang SUSPENDED — AI vẫn dừng sau khi ghim (không do giá).");
  return { target, priceBeforeVnd, priceAfterVnd: target.monthlyVnd, overage, featuresLost, limitsAfter, aiBefore, aiAfter, blockers, warnings };
}

/** Chặn còn lại sau khi áp cờ chấp nhận của người bấm. */
export function remainingBlockers(a: Pick<V1Assessment, "blockers">, accept: { overage?: boolean; billingOn?: boolean; lowerLimits?: boolean }): V1Blocker[] {
  return a.blockers.filter((b) => !(b.override === "ACCEPT_OVERAGE" && accept.overage) && !(b.override === "ACCEPT_BILLING_ON" && accept.billingOn) && !(b.override === "ACCEPT_LOWER_LIMITS" && accept.lowerLimits));
}

// ─────────────────────────── Chạy thử: mọi tổ chức ───────────────────────────

export type V1OrgPlan = {
  code: string;
  name: string;
  isHome: boolean;
  brand: string | null;
  versionKey: string | null;
  planKey: string;
  eligible: boolean;
  exclusion: V1Exclusion | null;
  note: string | null;
  facts: V1OrgFacts | null;
  fit: FitResult | null;
  /** Gói nhỏ nhất CHỈ theo fanpage + người dùng (khi khách AI chưa đo được) — cận dưới, không phải đề xuất. */
  floor: FitResult | null;
  proposal: V1Assessment | null;
};

export async function planV1Migration(opts: { orgCode?: string; now?: Date } = {}): Promise<{ catalogKey: string | null; rows: V1OrgPlan[] }> {
  const now = opts.now ?? new Date();
  invalidatePriceBook();
  const [book, plans, orgs] = await Promise.all([loadPriceBook({ fresh: true }), listPlans(), listOrganizations()]);
  const catalog = currentCatalogVersion(book, now);
  const picked = opts.orgCode ? orgs.filter((o) => o.code === opts.orgCode) : [...orgs].sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.code.localeCompare(b.code));
  if (opts.orgCode && !picked.length) throw new Error(`Không có tổ chức «${opts.orgCode}».`);
  const rows: V1OrgPlan[] = [];
  for (const org of picked) {
    const v = await orgPriceVersion(org.code, now);
    const cls = classifyForV1({ org, pinKey: v.pinKey, version: v.version });
    const base = { code: org.code, name: org.name, isHome: org.isHome, brand: org.brand ?? null, versionKey: v.version?.key ?? null, planKey: planKeyOf(org) };
    // Nhà bị loại khỏi lượt GHI nhưng chạy thử vẫn in số dùng + gói nhỏ nhất / cận dưới (để chủ shop thấy chargeback dự kiến).
    if (!cls.eligible && cls.exclusion !== "HOME") {
      rows.push({ ...base, eligible: false, exclusion: cls.exclusion, note: cls.note, facts: null, fit: null, floor: null, proposal: null });
      continue;
    }
    const facts = await readV1Facts(org, now, { book, plans });
    const u = facts.usage;
    const includedOf = (p: PlanPrice) => billableIncluded(p.included, { quotaOverrides: facts.quotaOverrides, addons: facts.addons });
    const fit = smallestFittingPlan({ aiCustomers: u.aiCustomers.basis, fanpages: u.fanpages, users: u.users, needsAiSales: u.needsAiSales }, facts.catalogPrices, { includedOf });
    const floor = fit.plan || u.aiCustomers.basis !== null ? null : smallestFittingPlan({ aiCustomers: 0, fanpages: u.fanpages, users: u.users, needsAiSales: u.needsAiSales }, facts.catalogPrices, { includedOf });
    if (!cls.eligible) rows.push({ ...base, eligible: false, exclusion: cls.exclusion, note: cls.note, facts, fit, floor, proposal: null });
    else rows.push({ ...base, eligible: true, exclusion: null, note: null, facts, fit, floor, proposal: assessV1Target(facts, fit.plan?.planKey ?? null) });
  }
  return { catalogKey: catalog?.key ?? null, rows };
}

// ─────────────────────────── Ghi: MỘT tổ chức ───────────────────────────

export type V1ApplyResult = { applied: boolean; message: string; assessment: V1Assessment | null; facts: V1OrgFacts | null };

export async function applyV1Migration(input: { orgCode: string; planKey: string; reason: string; acceptOverage?: boolean; acceptBillingOn?: boolean; acceptLowerLimits?: boolean; now?: Date; source?: Extract<PlatformAuditSource, "SCRIPT" | "TEST">; email?: string | null }): Promise<V1ApplyResult> {
  const now = input.now ?? new Date();
  const reason = (input.reason ?? "").trim().slice(0, 500);
  const no = (message: string, assessment: V1Assessment | null = null, facts: V1OrgFacts | null = null): V1ApplyResult => ({ applied: false, message, assessment, facts });
  if (reason.length < 5) return no("Không ghim: cần lý do (ít nhất 5 ký tự) — nó vào nhật ký nền tảng.");
  invalidateOrganizations();
  invalidatePriceBook();
  const org = await findOrganization(input.orgCode);
  if (!org) return no(`Không có tổ chức «${input.orgCode}».`);
  // Bất biến «nhà không đổi gói qua đường khách» — hỏi TRƯỚC mọi lượt đọc khác (classifyForV1 cũng loại, đây là lớp thứ hai).
  if (org.isHome) return no(`Không ghim: ${V1_EXCLUSION_LABEL.HOME}.`);
  const v = await orgPriceVersion(org.code, now);
  const cls = classifyForV1({ org, pinKey: v.pinKey, version: v.version });
  if (!cls.eligible) return no(`Không ghim: ${cls.note}`);
  const facts = await readV1Facts(org, now);
  const a = assessV1Target(facts, input.planKey);
  const left = remainingBlockers(a, { overage: input.acceptOverage, billingOn: input.acceptBillingOn, lowerLimits: input.acceptLowerLimits });
  if (left.length || !a.target || !facts.catalog) return no(`Không ghim — ${left.map((b) => `[${b.code}] ${b.message}`).join(" | ") || "không có gói đích"}`, a, facts);
  const target = a.target;
  const catalogKey = facts.catalog.key;
  const accepted = a.blockers.filter((b) => !left.includes(b)).map((b) => b.code);

  const pdb = await getPlatformDb();
  const t = schema.platformOrganizations;
  const stored = org.plan?.trim() || null;
  const pinBefore = facts.pinKey;
  const email = input.email ?? V1_MIGRATION_EMAIL;
  const source = input.source ?? "SCRIPT";
  const usage = { aiCustomersBasis: facts.usage.aiCustomers.basis, fanpages: facts.usage.fanpages, users: facts.usage.users };
  // MỘT giao dịch: khoá dòng ghim, hỏi lại những sự thật có thể đổi giữa lúc đánh giá và lúc ghi, rồi cột gói + ghim + HAI dòng
  // nhật ký cùng thành hoặc cùng không — không còn nhánh «hoàn» sau giao dịch.
  const fail = await pdb.transaction(async (tx): Promise<string | null> => {
    const [pin] = await tx.select({ v: schema.platformPricePins.versionKey }).from(schema.platformPricePins).where(eq(schema.platformPricePins.orgCode, org.code)).for("update");
    if ((pin?.v ?? null) !== pinBefore) return "ghim giá vừa bị đổi";
    const [open] = await tx.select({ n: count() }).from(schema.platformInvoices).where(and(eq(schema.platformInvoices.orgCode, org.code), eq(schema.platformInvoices.status, "OPEN")));
    if (Number(open?.n ?? 0) > 0) return "vừa có hoá đơn đang mở";
    const [sub] = await tx.select({ on: schema.platformSubscriptions.billingEnabled }).from(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, org.code));
    if ((sub?.on === true) !== facts.billing.enabled) return "cờ thu phí vừa đổi";
    const [flag] = await tx
      .select({ on: schema.platformFlagOverrides.enabled })
      .from(schema.platformFlagOverrides)
      .where(and(eq(schema.platformFlagOverrides.organizationId, org.id), eq(schema.platformFlagOverrides.flagKey, AI_BALANCE_FLAG)));
    if (flag?.on === true) return "Số dư AI vừa được bật";
    // Ghi CÓ ĐIỀU KIỆN theo gói vừa đọc — một người vận hành đổi gói cùng lúc thì lượt này thua, không đè im lặng.
    const rows = await tx
      .update(t)
      .set({ plan: target.planKey, updatedAt: now })
      .where(and(eq(t.code, org.code), stored === null ? isNull(t.plan) : eq(t.plan, stored)))
      .returning({ id: t.id });
    if (!rows.length) return "gói của tổ chức vừa được người khác đổi";
    await pinOrgPriceVersion(org.code, catalogKey, { source: input.source === "TEST" ? "TEST" : "OPERATOR", reason, email, tx });
    const log = { targetOrgCode: org.code, reason, source, actorOrgCode: null, actorUserId: null, actorEmail: null };
    await tx.insert(schema.platformAuditLog).values([
      { ...log, action: "ORG_PLAN_SET", subject: "plan", before: { plan: planKeyOf(org) }, after: { plan: target.planKey, priceVersionKey: catalogKey, usage } },
      {
        ...log,
        action: "PRICE_VERSION_PIN",
        subject: `price-pin:${org.code}`,
        before: { versionKey: pinBefore, plan: planKeyOf(org), monthlyVnd: a.priceBeforeVnd },
        after: { versionKey: catalogKey, plan: target.planKey, monthlyVnd: target.monthlyVnd, expectedOverageVnd: a.overage?.totalVnd ?? null, accepted, billingEnabled: facts.billing.enabled },
      },
    ]);
    return null;
  });
  invalidateOrganizations();
  invalidatePricing(org.code);
  invalidateAiEntitlement(org.code);
  if (fail) return no(`Không ghim: ${fail} — chạy thử lại.`, a, facts);
  return {
    applied: true,
    message: `Đã ghim «${org.code}» vào «${target.name}» (bảng giá ${catalogKey}). Giá tham chiếu ${vnd(a.priceBeforeVnd)} → ${vnd(target.monthlyVnd)}/tháng. Thu phí ${facts.billing.enabled ? "ĐANG BẬT (không đổi)" : "vẫn TẮT"} · không tạo hoá đơn · không khởi động dùng thử.`,
    assessment: a,
    facts,
  };
}
