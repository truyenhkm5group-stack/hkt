import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, notInArray, notLike, sql } from "drizzle-orm";
import { getDb, getPlatformDb, schema } from "@/db";
import { activeUserIdsWhoCan, type SessionUser } from "@/lib/auth/session";
import {
  BILLING_DEFAULT_GRACE_DAYS,
  BILLING_GRACE_MAX,
  billingStanding,
  mrrContribution,
  extractTransferCodes,
  isIsoDate,
  judgePayment,
  quoteRenewal,
  TRIAL_GRACE_DAYS,
  TRANSFER_CODE_PREFIX,
  transferCodeFrom,
  trialPaidThrough,
  YEARLY_FREE_MONTHS_MAX,
  vnDate,
  type BillingStanding,
  type BillingStandingKind,
  type PaymentOutcome,
  type PricedPlan,
  type RenewalQuote,
  type SubscriptionTerms,
} from "@/lib/billing/rules";
import {
  ADDON_KINDS,
  ADDON_MAX_BLOCKS,
  ADDON_PRICE_MAX_VND,
  ADDON_PRICE_MIN_VND,
  addonMonthlyVnd,
  addonUnitsLabel,
  isAddonKind,
  missingAddonMessage,
  parseAddonPrices,
  parseAddonUnits,
  parseInvoiceInfo,
  quoteAddon,
  readInvoiceInfo,
  ADDON_STEP,
  type AddonKind,
  type AddonPrices,
  type AddonQuote,
  type AddonUnits,
  type InvoiceInfo,
} from "@/lib/billing/addons";
import { invalidateSubscriptions, readSubscriptionAddons, readSubscriptionTerms } from "@/lib/billing/standing";
import { ENTITLEMENT_SPEC } from "@/lib/entitlements/kinds";
import { VN_BANK_BY_BIN, bankNameOf } from "@/lib/constants/vn-banks";
import { BILLING_RECEIVER_KEY, getBillingReceiver, parseReceiver, type BillingReceiverView } from "@/lib/billing/receiver";
import { creditTopupFromBankRow } from "@/lib/billing/ai-balance";
import { extractTopupCodes, paymentBankRowTrust, SEPAY_ROW_SOURCES, TOPUP_CODE_PREFIX, TOPUP_PAYMENT_OUTCOMES } from "@/lib/billing/ai-balance-rules";
import { sendInboxMessages } from "@/lib/inbox/send";
import { currentOrganization, withOrganization } from "@/lib/platform/context";
import { normalizeBankRef } from "@/lib/integrations/bank/sepay";
import { DEFAULT_PLAN_KEY, HOME_PLAN_KEY, listPlans, planKeyOf, type PlanRow } from "@/lib/entitlements/check";
import { buildVietQrPayload, toTransferText } from "@/lib/payroll/vietqr";
import { parseCommercial, type PlanCommercial } from "@/lib/pricing/catalog";
import { catalogPlans, loadPriceBook, orgPriceVersion, pinOrgPriceVersion, plansForOrg, publishCatalogVersion, readPricePin } from "@/lib/pricing/price-book";
import { currentCatalogVersion, isSellable, priceOf, renewalPricing, type PlanPrice } from "@/lib/pricing/versions";
import { trialEndFromLastDay } from "@/lib/pricing/ai-entitlement";
import type { PlatformActor, PlatformAuditAction } from "@/lib/platform/audit";
import { KILL_SWITCH_REASON_MIN, parseOperatorTarget } from "@/lib/platform/kill-switches";
import { findOrganization, getHomeOrganization, invalidateOrganizations, listOrganizations } from "@/lib/platform/organizations";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

/**
 * ═══════════ THU PHÍ THUÊ BAO — ĐƯỜNG GHI DUY NHẤT (docs/platform/billing.md) ═══════════
 *
 * Luật (thuần) ở `lib/billing/rules.ts`; tệp này chỉ đọc / ghi CSDL NHÀ (`getPlatformDb()`).
 *
 *  · KHÁCH (người có `settings:manage` của tổ chức, ở /settings/plan) chọn gói + số tháng ⇒ `createRenewalInvoice` tạo
 *    MỘT hoá đơn đang mở mang mã chuyển khoản `ERPHD…` + mã VietQR tới tài khoản của nền tảng. Tạo cái mới ⇒ cái cũ VOID.
 *  · TIỀN VỀ: SePay ghi giao dịch vào sổ ngân hàng của NHÀ như mọi giao dịch khác; `reconcileBillingPayments` đọc chính
 *    sổ ấy (webhook · lượt quét API · sao kê nhập tay — ba đường, một nơi đọc) và khớp theo mã. Không có bảng tiền thứ hai.
 *  · TRẢ ĐỦ ⇒ MỘT giao dịch CSDL: hoá đơn PAID · `paid_through = period_end` · gói của tổ chức = gói của hoá đơn · một dòng
 *    nhật ký nền tảng. Hỏng một bước ⇒ không bước nào được ghi.
 *  · NGƯỜI VẬN HÀNH (tổ chức nhà + `platform:operate`, ở /platform) bật / tắt thu phí, sửa ngày trả tới, xác nhận tay một
 *    khoản tiền, huỷ hoá đơn, sửa giá gói, khai tài khoản nhận tiền — mọi lượt bắt buộc lý do và vào nhật ký nền tảng.
 */

export type BillingResult = { ok: true; message: string } | { error: string };

/** Số ngày lùi lại khi quét sổ ngân hàng tìm tiền thuê bao. Giao dịch cũ hơn đối chiếu tay. */
export const BILLING_RECONCILE_LOOKBACK_DAYS = 60;
/** Trần giá một tháng khi người vận hành sửa giá (chặn gõ thừa số 0). */
export const PLAN_PRICE_MAX_VND = 100_000_000;
export const PLAN_PRICE_MIN_VND = 1_000;

type PlatformDb = Awaited<ReturnType<typeof getPlatformDb>>;
type Tx = Parameters<Parameters<PlatformDb["transaction"]>[0]>[0];

async function auditTx(tx: Tx, entry: { action: PlatformAuditAction; targetOrgCode: string; subject: string; before?: unknown; after?: unknown; reason?: string | null; actor: PlatformActor }) {
  await tx.insert(schema.platformAuditLog).values({
    actorOrgCode: entry.actor?.orgCode ?? null,
    actorUserId: entry.actor?.userId ?? null,
    actorEmail: entry.actor?.email ?? null,
    targetOrgCode: entry.targetOrgCode,
    action: entry.action,
    subject: entry.subject,
    before: entry.before === undefined ? null : entry.before,
    after: entry.after === undefined ? null : entry.after,
    reason: entry.reason ?? null,
    source: "UI",
  });
}

function actorOf(user: SessionUser): PlatformActor {
  return user.organization ? { orgCode: user.organization.code, userId: user.id, email: user.email } : null;
}

function operatorReason(raw: unknown): string | { error: string } {
  const reason = typeof raw === "string" ? raw.trim().slice(0, 500) : "";
  if (reason.length < KILL_SWITCH_REASON_MIN) return { error: `Ghi lý do (ít nhất ${KILL_SWITCH_REASON_MIN} ký tự) — nó vào nhật ký nền tảng.` };
  return reason;
}

const vnd = (n: number) => `${n.toLocaleString("vi-VN")} ₫`;

// ─────────────────────────── Tài khoản nhận tiền ───────────────────────────

// Đọc + kiểm hợp lệ ở `lib/billing/receiver.ts` (đọc chung với tiền nạp Số dư AI); đường ghi ở đây.
export { BILLING_RECEIVER_KEY, getBillingReceiver, type BillingReceiver, type BillingReceiverView } from "@/lib/billing/receiver";

export async function setBillingReceiver(user: SessionUser, raw: { bin?: unknown; accountNumber?: unknown; accountName?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const next = parseReceiver({ bin: raw.bin, accountNumber: raw.accountNumber, accountName: typeof raw.accountName === "string" ? toTransferText(raw.accountName) : "" });
  if (!next) return { error: "Chọn ngân hàng, nhập số tài khoản (4–19 chữ/số) và tên chủ tài khoản." };
  if (!VN_BANK_BY_BIN.has(next.bin)) return { error: "Ngân hàng không có trong danh sách VietQR." };
  const before = await getBillingReceiver();
  const pdb = await getPlatformDb();
  const now = new Date();
  await pdb.transaction(async (tx) => {
    const set = { value: next, updatedAt: now, updatedBy: `${user.organization?.code ?? ""}:${user.id}`, updatedByEmail: user.email };
    await tx.insert(schema.platformSettings).values({ key: BILLING_RECEIVER_KEY, ...set }).onConflictDoUpdate({ target: schema.platformSettings.key, set });
    await auditTx(tx, { action: "BILLING_RECEIVER_SET", targetOrgCode: user.organization!.code, subject: BILLING_RECEIVER_KEY, before, after: next, reason, actor: actorOf(user) });
  });
  return { ok: true, message: `Tiền thuê bao sẽ chuyển về ${bankNameOf(next.bin)} · ${next.accountNumber} · ${next.accountName}.` };
}

// ─────────────────────────── Hoá đơn ───────────────────────────

export type InvoiceView = {
  id: string;
  orgCode: string;
  planKey: string;
  planName: string;
  months: number;
  periodStart: string;
  periodEnd: string;
  listAmountVnd: number;
  creditVnd: number;
  amountVnd: number;
  transferCode: string;
  status: "OPEN" | "PAID" | "VOID";
  createdAt: string;
  createdByEmail: string | null;
  paidAt: string | null;
  paidAmountVnd: number | null;
  paidSource: string | null;
  paidRef: string | null;
  paidByEmail: string | null;
  voidReason: string | null;
  /** 0192: `RENEWAL` · `ADDON` (mua thêm giữa kỳ — `months = 0`). */
  kind: "RENEWAL" | "ADDON";
  addonKind: AddonKind | null;
  addonUnits: number | null;
  /** Câu ngắn cho người đọc: «Gói Khởi đầu · 3 tháng» hoặc «Mua thêm 2 tài khoản». */
  label: string;
  /** Ảnh chụp phần mua thêm đã tính vào giá của hoá đơn gia hạn. */
  addons: AddonUnits;
  invoiceInfo: InvoiceInfo | null;
  vatIssuedAt: string | null;
  vatRef: string | null;
  vatIssuedByEmail: string | null;
};

type InvoiceRow = typeof schema.platformInvoices.$inferSelect;

function invoiceView(r: InvoiceRow, plans: readonly PlanRow[]): InvoiceView {
  const planName = plans.find((p) => p.key === r.planKey)?.name ?? r.planKey;
  const addonKind = r.kind === "ADDON" && isAddonKind(r.addonKind) ? r.addonKind : null;
  return {
    id: r.id,
    orgCode: r.orgCode,
    planKey: r.planKey,
    planName,
    months: r.months,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    listAmountVnd: r.listAmountVnd,
    creditVnd: r.creditVnd,
    amountVnd: r.amountVnd,
    transferCode: r.transferCode,
    status: r.status as InvoiceView["status"],
    createdAt: r.createdAt.toISOString(),
    createdByEmail: r.createdByEmail,
    paidAt: r.paidAt?.toISOString() ?? null,
    paidAmountVnd: r.paidAmountVnd,
    paidSource: r.paidSource,
    paidRef: r.paidRef,
    paidByEmail: r.paidByEmail,
    voidReason: r.voidReason,
    kind: r.kind === "ADDON" ? "ADDON" : "RENEWAL",
    addonKind,
    addonUnits: r.addonUnits,
    label: addonKind ? `Mua thêm ${addonUnitsLabel(addonKind, r.addonUnits ?? 0)}` : `Gói ${planName} · ${r.months} tháng`,
    addons: parseAddonUnits(r.addons),
    invoiceInfo: readInvoiceInfo(r.invoiceInfo),
    vatIssuedAt: r.vatIssuedAt?.toISOString() ?? null,
    vatRef: r.vatRef,
    vatIssuedByEmail: r.vatIssuedByEmail,
  };
}

const PRICE_READ_ERROR = "Không đọc được bảng giá của tổ chức lúc này — thử lại sau ít phút (chưa tạo mã thanh toán nào).";

/** Giá gói THEO PHIÊN BẢN (0228) ⇒ hình dạng báo giá. Giá năm tường minh của phiên bản đi kèm (`yearlyPriceVnd`). */
function pricedOfVersion(p: PlanPrice | null): PricedPlan | null {
  return p ? { key: p.planKey, name: p.name, priceVnd: p.monthlyVnd, yearlyFreeMonths: p.yearlyFreeMonths, yearlyPriceVnd: p.yearlyVnd } : null;
}

function newTransferCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return transferCodeFrom([...bytes]);
}

/**
 * Báo giá (không ghi gì) — để màn hình hiện số tiền trước khi khách bấm tạo mã. GIÁ THEO PHIÊN BẢN (0228): gia hạn đúng gói
 * đang dùng ⇒ phiên bản đã ghim (khách hiện tại không đổi số tiền); đổi gói / mua lần đầu ⇒ bảng giá đang niêm yết.
 * `priceVersionKey` = phiên bản của giá gói đích — hoá đơn mang nó, trả xong thì tổ chức được ghim vào đó.
 */
export async function previewRenewal(orgCode: string, planKey: string, months: number, now: Date = new Date()): Promise<(RenewalQuote & { priceVersionKey: string }) | { error: string }> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  if (planKey === HOME_PLAN_KEY) return { error: "Không có gói này." };
  // Lỗi đọc sổ giá / ghim ⇒ TỪ CHỐI báo giá (không bao giờ rơi về bảng giá hiện hành — hoá đơn ấy sẽ ghim khách cũ vào giá mới).
  const read = await Promise.all([loadPriceBook(), readPricePin(org.code)]).catch(() => null);
  if (!read) return { error: PRICE_READ_ERROR };
  const [book, pinKey] = read;
  const pricing = renewalPricing({ book, pinKey, now, currentPlanKey: planKeyOf(org), targetPlanKey: planKey });
  if ("error" in pricing) return pricing;
  const [terms, units] = await Promise.all([readSubscriptionTerms(org.code, { fresh: true }), readSubscriptionAddons(org.code, { fresh: true })]);
  // Phần mua thêm đi theo GIÁ CỦA GÓI ĐÍCH; gói đích không bán một hạng mục đang có ⇒ nói rõ, không đoán giá.
  const targetAddon = addonMonthlyVnd(units, parseAddonPrices(pricing.target.addonPrices));
  if (!targetAddon.ok) return { error: missingAddonMessage(pricing.target.name, targetAddon.missing) };
  const currentAddon = pricing.current ? addonMonthlyVnd(units, parseAddonPrices(pricing.current.addonPrices)) : null;
  const q = quoteRenewal({
    terms,
    currentPlan: pricedOfVersion(pricing.current),
    target: pricedOfVersion(pricing.target)!,
    months,
    today: vnDate(now),
    targetAddonMonthlyVnd: targetAddon.vnd,
    // Gói hiện tại vừa bị gỡ giá của phần đang có ⇒ phần trừ chỉ tính giá gói — không đoán giá.
    currentAddonMonthlyVnd: currentAddon?.ok ? currentAddon.vnd : 0,
  });
  return "error" in q ? q : { ...q, priceVersionKey: pricing.targetVersionKey };
}

/**
 * KHÁCH tạo mã thanh toán cho lần gia hạn. Bấm lại với đúng lựa chọn cũ ⇒ trả lại hoá đơn đang mở (không đẻ mã thứ hai
 * — người ta hay bấm hai lần). Lựa chọn khác ⇒ hoá đơn cũ VOID, mã cũ không còn gia hạn được nữa.
 */
export async function createRenewalInvoice(user: SessionUser, raw: { planKey?: unknown; months?: unknown; vat?: unknown }, now: Date = new Date()): Promise<{ ok: true; invoiceId: string; message: string } | { error: string }> {
  const org = user.organization;
  if (!org) return { error: "Không xác định được tổ chức của phiên." };
  if (org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  const planKey = typeof raw.planKey === "string" ? raw.planKey.trim() : "";
  const months = typeof raw.months === "number" ? raw.months : Number(raw.months);
  const q = await previewRenewal(org.code, planKey, months, now);
  if ("error" in q) return q;
  const units = await readSubscriptionAddons(org.code, { fresh: true });
  return openInvoice(
    user,
    org.code,
    {
      kind: "RENEWAL",
      planKey: q.planKey,
      months: q.months,
      periodStart: q.periodStart,
      periodEnd: q.periodEnd,
      listAmountVnd: q.listAmountVnd,
      creditVnd: q.creditVnd,
      amountVnd: q.amountVnd,
      addonKind: null,
      addonUnits: null,
      addons: q.addonMonthlyVnd > 0 ? units : {},
      vat: raw.vat === true,
      voidNote: `${q.months} tháng gói ${q.planKey}`,
      priceVersionKey: q.priceVersionKey,
    },
    now,
  );
}

type InvoiceDraft = {
  kind: "RENEWAL" | "ADDON";
  planKey: string;
  months: number;
  periodStart: string;
  periodEnd: string;
  listAmountVnd: number;
  creditVnd: number;
  amountVnd: number;
  addonKind: AddonKind | null;
  addonUnits: number | null;
  addons: AddonUnits;
  vat: boolean;
  /** Vế sau của lý do huỷ hoá đơn đang mở: «Khách tạo mã mới (<vế này>)». */
  voidNote: string;
  /** Phiên bản giá tính ra số tiền (0228) — trả xong hoá đơn GIA HẠN thì tổ chức được ghim vào đây. */
  priceVersionKey: string | null;
};

/**
 * MỘT đường mở hoá đơn cho cả gia hạn lẫn mua thêm — cả hai chung luật «tối đa một hoá đơn đang mở» và chung bộ khớp mã
 * chuyển khoản. Bấm lại đúng lựa chọn cũ ⇒ trả lại hoá đơn đang mở (người ta hay bấm hai lần). Lựa chọn khác ⇒ hoá đơn cũ
 * VOID, mã cũ không còn khớp được nữa. `vat` ⇒ chụp thông tin xuất hoá đơn ĐÃ KHAI vào hoá đơn (chưa khai thì từ chối).
 */
async function openInvoice(user: SessionUser, orgCode: string, d: InvoiceDraft, now: Date): Promise<{ ok: true; invoiceId: string; message: string } | { error: string }> {
  if (!(await getBillingReceiver())) return { error: "Nền tảng chưa khai tài khoản nhận tiền — báo người vận hành nền tảng, chưa tạo được mã thanh toán." };
  const pdb = await getPlatformDb();
  let info: InvoiceInfo | null = null;
  if (d.vat) {
    const [sub] = await pdb.select({ invoiceInfo: schema.platformSubscriptions.invoiceInfo }).from(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, orgCode)).limit(1);
    info = readInvoiceInfo(sub?.invoiceInfo);
    if (!info) return { error: "Khai «Thông tin xuất hoá đơn» trước (tên công ty, mã số thuế, địa chỉ, email) rồi mới chọn xuất hoá đơn VAT." };
  }
  const inv = schema.platformInvoices;
  const [open] = await pdb.select().from(inv).where(and(eq(inv.orgCode, orgCode), eq(inv.status, "OPEN"))).limit(1);
  if (
    open &&
    open.kind === d.kind &&
    open.planKey === d.planKey &&
    open.months === d.months &&
    open.periodStart === d.periodStart &&
    open.amountVnd === d.amountVnd &&
    (open.addonKind ?? null) === d.addonKind &&
    (open.addonUnits ?? null) === d.addonUnits &&
    (open.priceVersionKey ?? null) === d.priceVersionKey &&
    JSON.stringify(readInvoiceInfo(open.invoiceInfo)) === JSON.stringify(info)
  ) {
    return { ok: true, invoiceId: open.id, message: "Mã thanh toán đang mở vẫn dùng được." };
  }
  let code = newTransferCode();
  for (let i = 0; i < 5; i++) {
    const [clash] = await pdb.select({ id: inv.id }).from(inv).where(eq(inv.transferCode, code)).limit(1);
    if (!clash) break;
    code = newTransferCode();
  }
  const id = crypto.randomUUID();
  await pdb.transaction(async (tx) => {
    if (open) await tx.update(inv).set({ status: "VOID", voidReason: `Khách tạo mã mới (${d.voidNote})`, updatedAt: now }).where(and(eq(inv.id, open.id), eq(inv.status, "OPEN")));
    await tx.insert(inv).values({
      id,
      orgCode,
      kind: d.kind,
      planKey: d.planKey,
      months: d.months,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      listAmountVnd: d.listAmountVnd,
      creditVnd: d.creditVnd,
      amountVnd: d.amountVnd,
      addonKind: d.addonKind,
      addonUnits: d.addonUnits,
      addons: d.addons,
      invoiceInfo: info,
      transferCode: code,
      status: "OPEN",
      createdByEmail: user.email,
      priceVersionKey: d.priceVersionKey,
    });
  });
  return { ok: true, invoiceId: id, message: `Đã tạo mã thanh toán ${code} — ${vnd(d.amountVnd)}.` };
}

// ─────────────────────────── Mua thêm hạn mức giữa kỳ ───────────────────────────

/** Báo giá mua thêm (không ghi gì). Cùng hàm thuần với lượt tạo mã — hai bước không lệch nhau. */
export async function previewAddon(orgCode: string, raw: { kind?: unknown; blocks?: unknown }, now: Date = new Date()): Promise<AddonQuote | { error: string }> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  // Đơn giá mua thêm theo PHIÊN BẢN đã ghim của tổ chức (0228) — đổi giá ở phiên bản mới không đổi giá khách đang trả.
  const plans = await plansForOrg(org.code, now).catch(() => null);
  if (!plans) return { error: PRICE_READ_ERROR };
  const plan = plans.find((p) => p.key === planKeyOf(org));
  if (!plan) return { error: "Không đọc được gói hiện tại của tổ chức." };
  const terms = await readSubscriptionTerms(org.code, { fresh: true });
  return quoteAddon({ terms, planName: plan.name, kind: raw.kind, blocks: raw.blocks, prices: parseAddonPrices(plan.addonPrices), today: vnDate(now) });
}

/** KHÁCH tạo mã thanh toán cho một lần mua thêm. Trả xong ⇒ hạn mức tăng NGAY; ngày trả tới và gói không đổi. */
export async function createAddonInvoice(user: SessionUser, raw: { kind?: unknown; blocks?: unknown; vat?: unknown }, now: Date = new Date()): Promise<{ ok: true; invoiceId: string; message: string } | { error: string }> {
  const org = user.organization;
  if (!org) return { error: "Không xác định được tổ chức của phiên." };
  if (org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  const q = await previewAddon(org.code, raw, now);
  if ("error" in q) return q;
  const current = await findOrganization(org.code);
  if (!current) return { error: "Không đọc được tổ chức." };
  const version = await orgPriceVersion(org.code, now).catch(() => null);
  if (!version) return { error: PRICE_READ_ERROR };
  return openInvoice(
    user,
    org.code,
    {
      kind: "ADDON",
      planKey: planKeyOf(current),
      months: 0,
      periodStart: q.periodStart,
      periodEnd: q.periodEnd,
      listAmountVnd: q.amountVnd,
      creditVnd: 0,
      amountVnd: q.amountVnd,
      addonKind: q.kind,
      addonUnits: q.units,
      addons: {},
      vat: raw.vat === true,
      voidNote: `mua thêm ${addonUnitsLabel(q.kind, q.units)}`,
      priceVersionKey: version.version?.key ?? null,
    },
    now,
  );
}

/** KHÁCH khai / sửa thông tin xuất hoá đơn VAT. `clear` ⇒ xoá (hoá đơn đã tạo giữ ảnh chụp của chúng). */
export async function setInvoiceInfo(user: SessionUser, raw: { info?: unknown; clear?: unknown }): Promise<BillingResult> {
  const org = user.organization;
  if (!org) return { error: "Không xác định được tổ chức của phiên." };
  if (org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  let next: InvoiceInfo | null = null;
  if (raw.clear !== true) {
    const parsed = parseInvoiceInfo(raw.info);
    if ("error" in parsed) return parsed;
    next = parsed.info;
  }
  const pdb = await getPlatformDb();
  const subs = schema.platformSubscriptions;
  const [before] = await pdb.select({ invoiceInfo: subs.invoiceInfo }).from(subs).where(eq(subs.orgCode, org.code)).limit(1);
  const prev = readInvoiceInfo(before?.invoiceInfo);
  if (JSON.stringify(prev) === JSON.stringify(next)) return { ok: true, message: "Không có gì thay đổi." };
  const now = new Date();
  await pdb.transaction(async (tx) => {
    // Chưa có dòng thuê bao (đang dùng thử, chưa bật thu phí) ⇒ tạo dòng TẮT thu phí: không nhắc, không khoá.
    await tx.insert(subs).values({ orgCode: org.code, invoiceInfo: next }).onConflictDoUpdate({ target: subs.orgCode, set: { invoiceInfo: next, updatedAt: now } });
    await auditTx(tx, { action: "INVOICE_INFO_SET", targetOrgCode: org.code, subject: "invoice-info", before: prev, after: next, reason: null, actor: actorOf(user) });
  });
  return { ok: true, message: next ? `Đã lưu thông tin xuất hoá đơn: ${next.companyName} · MST ${next.taxCode}.` : "Đã xoá thông tin xuất hoá đơn." };
}

/**
 * Áp một lượt TRẢ ĐỦ trong giao dịch đang mở. Ghi có điều kiện `status = 'OPEN'` — hai đường (webhook và người vận hành)
 * cùng áp một hoá đơn thì đúng một đường thắng. Trả `false` khi hoá đơn không còn mở.
 */
async function applyInvoicePaid(tx: Tx, invoice: InvoiceRow, paid: { amountVnd: number; source: "BANK" | "MANUAL"; ref: string | null; byEmail: string | null; actor: PlatformActor; reason: string | null }, now: Date): Promise<boolean> {
  const inv = schema.platformInvoices;
  const won = await tx
    .update(inv)
    .set({ status: "PAID", paidAt: now, paidAmountVnd: paid.amountVnd, paidSource: paid.source, paidRef: paid.ref, paidByEmail: paid.byEmail, updatedAt: now })
    .where(and(eq(inv.id, invoice.id), eq(inv.status, "OPEN")))
    .returning({ id: inv.id });
  if (won.length === 0) return false;
  const subs = schema.platformSubscriptions;
  const [beforeSub] = await tx.select().from(subs).where(eq(subs.orgCode, invoice.orgCode)).limit(1);
  if (invoice.kind === "ADDON") {
    // MUA THÊM: cộng đơn vị vào phần đã mua; KHÔNG đổi ngày trả tới, KHÔNG đổi gói. Lượt cập nhật có điều kiện ở trên đã
    // bảo đảm hoá đơn chỉ được áp MỘT lần, nên phép cộng này không bao giờ chạy đôi.
    const kind = invoice.addonKind;
    const units = invoice.addonUnits ?? 0;
    if (!isAddonKind(kind) || units <= 0) throw new Error(`Hoá đơn mua thêm ${invoice.transferCode} thiếu hạng mục / số lượng.`);
    const beforeUnits = parseAddonUnits(beforeSub?.addons);
    const afterUnits: AddonUnits = { ...beforeUnits, [kind]: (beforeUnits[kind] ?? 0) + units };
    await tx
      .insert(subs)
      .values({ orgCode: invoice.orgCode, addons: afterUnits })
      .onConflictDoUpdate({ target: subs.orgCode, set: { addons: afterUnits, updatedAt: now } });
    await auditTx(tx, {
      action: "INVOICE_PAID",
      targetOrgCode: invoice.orgCode,
      subject: `invoice:${invoice.transferCode}`,
      before: { addons: beforeUnits },
      after: { addons: afterUnits, amountVnd: paid.amountVnd, source: paid.source, ref: paid.ref },
      reason: paid.reason,
      actor: paid.actor,
    });
    return true;
  }
  await tx
    .insert(subs)
    .values({ orgCode: invoice.orgCode, billingEnabled: true, paidThrough: invoice.periodEnd, graceDays: BILLING_DEFAULT_GRACE_DAYS })
    .onConflictDoUpdate({ target: subs.orgCode, set: { billingEnabled: true, paidThrough: invoice.periodEnd, updatedAt: now } });
  const orgs = schema.platformOrganizations;
  const [beforeOrg] = await tx.select({ plan: orgs.plan }).from(orgs).where(eq(orgs.code, invoice.orgCode)).limit(1);
  await tx.update(orgs).set({ plan: invoice.planKey, updatedAt: now }).where(and(eq(orgs.code, invoice.orgCode), eq(orgs.isHome, false)));
  // Ghim phiên bản giá của hoá đơn (0228) TRONG CÙNG giao dịch: kỳ đã trả và giá của nó là một việc. Hoá đơn trước 0228
  // (không mang phiên bản) ⇒ không đổi ghim.
  const pin = invoice.priceVersionKey ? await pinOrgPriceVersion(invoice.orgCode, invoice.priceVersionKey, { source: "INVOICE_PAID", reason: `Hoá đơn ${invoice.transferCode}`, email: paid.byEmail, tx }) : null;
  await auditTx(tx, {
    action: "INVOICE_PAID",
    targetOrgCode: invoice.orgCode,
    subject: `invoice:${invoice.transferCode}`,
    before: { paidThrough: beforeSub?.paidThrough ?? null, billingEnabled: beforeSub?.billingEnabled ?? false, plan: beforeOrg?.plan ?? null, priceVersionKey: pin?.before ?? null },
    after: { paidThrough: invoice.periodEnd, billingEnabled: true, plan: invoice.planKey, amountVnd: paid.amountVnd, source: paid.source, ref: paid.ref, priceVersionKey: invoice.priceVersionKey ?? pin?.before ?? null },
    reason: paid.reason,
    actor: paid.actor,
  });
  return true;
}

function afterPaidWrite(orgCode: string) {
  invalidateSubscriptions(orgCode);
  invalidateOrganizations();
}

// ─────────────────────────── Đối chiếu tiền về ───────────────────────────

/** `matched` / `unmatched` chỉ đếm tiền THUÊ BAO; tiền nạp Số dư AI đếm riêng (`topupCredited` · `topupHeld`) — gộp vào «khớp và
 * gia hạn» là để người vận hành tưởng tiền nạp là tiền thuê bao (review 08/10/2026, M1). */
export type ReconcileSummary = {
  scanned: number;
  recorded: number;
  matched: number;
  unmatched: number;
  /** Tiền mang mã THUÊ BAO mà dòng không do SePay tạo vào đúng tài khoản nhận — không ghi, không gia hạn, chờ người vận hành. */
  unconfirmed: number;
  topupCredited: number;
  topupHeld: number;
  errors: string[];
};

/**
 * Đọc sổ ngân hàng của NHÀ, tìm tiền VÀO mang mã `ERPHD…` chưa từng ghi ở `platform_billing_payments`, ghi mỗi khoản ĐÚNG
 * MỘT dòng (khoá `bank_ref`) và gia hạn khi khớp. Chạy lại bao nhiêu lần cũng được: khoản đã ghi bị bỏ qua ngay ở câu lọc,
 * và lượt ghi đua nhau thì `ON CONFLICT DO NOTHING` cho đúng một lượt thắng.
 */
export async function reconcileBillingPayments(opts: { bankRefs?: readonly string[]; lookbackDays?: number; now?: Date } = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date();
  const out: ReconcileSummary = { scanned: 0, recorded: 0, matched: 0, unmatched: 0, unconfirmed: 0, topupCredited: 0, topupHeld: 0, errors: [] };
  if (opts.bankRefs && opts.bankRefs.length === 0) return out;
  const pdb = await getPlatformDb();
  const bt = schema.bankTransactions;
  const since = new Date(now.getTime() - (opts.lookbackDays ?? BILLING_RECONCILE_LOOKBACK_DAYS) * 86_400_000);
  const rows = await pdb
    .select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description, provider: bt.provider, providerTxnId: bt.providerTxnId, account: bt.account, source: bt.source })
    .from(bt)
    .where(
      and(
        gt(bt.amount, 0),
        gte(bt.txnAt, since),
        // Mã thuê bao `ERPHD…` HOẶC mã phiếu nạp Số dư AI `ERPNAP…` (0235) — một lượt đọc sổ, mỗi giao dịch xử lý đúng một lần.
        sql`(regexp_replace(upper(${bt.description}), '[^A-Z0-9]', '', 'g') like '%ERPHD%' or regexp_replace(upper(${bt.description}), '[^A-Z0-9]', '', 'g') like '%ERPNAP%')`,
        // Câu con tương quan: viết tên bảng tường minh — `${bt.bankRef}` trong exists() in ra cột trần (bộ nhớ drizzle).
        sql`not exists (select 1 from platform_billing_payments p where p.bank_ref = "bank_transactions"."bank_ref")`,
        opts.bankRefs ? inArray(bt.bankRef, [...opts.bankRefs]) : undefined,
      ),
    )
    .orderBy(bt.txnAt);
  const inv = schema.platformInvoices;
  // Đọc MỘT lần cho cả lượt. Đọc hỏng / chưa khai ⇒ `null` ⇒ mọi dòng thuê bao chưa đủ căn cứ lượt này (không ghi gì — lượt sau đọc lại).
  const receiverAccount = (await getBillingReceiver())?.accountNumber ?? null;
  const unconfirmedCodes: string[] = [];
  for (const row of rows) {
    out.scanned++;
    const codes = extractTransferCodes(row.description);
    if (codes.length === 0) {
      // Tiền nạp Số dư AI: cùng sổ ngân hàng, cùng bảng ghi-một-lần (`bank_ref`), hàm cộng tiền ở `lib/billing/ai-balance.ts`.
      const topups = extractTopupCodes(row.description);
      if (topups.length === 0) continue;
      try {
        const credited = await creditTopupFromBankRow(row, topups, now);
        if (credited === null) continue;
        out.recorded++;
        if (credited === "TOPUP_CREDITED" || credited === "TOPUP_CREDITED_REVIEW") out.topupCredited++;
        else out.topupHeld++;
      } catch (error) {
        out.errors.push(`${row.bankRef}: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    // Tiền THUÊ BAO chỉ TỰ gia hạn khi dòng do SePay TẠO (webhook / lượt quét API, mã giao dịch SePay) vào ĐÚNG tài khoản nhận —
    // cùng luật với tiền nạp Số dư AI. Dòng sao kê nhập tệp / gõ tay mang mã `ERPHD…` (kể cả khi SePay điền mã giao dịch vào SAU:
    // số tiền + mô tả vẫn là của người nhập) KHÔNG ghi ở đây — ghi là «tiêu» mất dòng — mà nằm ở «Tiền thuê bao chờ xác nhận
    // nguồn» cho người vận hành kiểm ngân hàng rồi xác nhận tay.
    if (paymentBankRowTrust(row, receiverAccount) !== "TRUSTED") {
      out.unconfirmed++;
      unconfirmedCodes.push(...codes);
      continue;
    }
    try {
      const candidates = await pdb.select().from(inv).where(inArray(inv.transferCode, codes));
      const invoice = candidates.find((c) => c.status === "OPEN") ?? candidates[0] ?? null;
      const outcome = judgePayment(row.amount, invoice);
      const recorded = await pdb.transaction(async (tx) => {
        const ins = await tx
          .insert(schema.platformBillingPayments)
          .values({ bankRef: row.bankRef, txnAt: row.txnAt, amountVnd: row.amount, description: row.description.slice(0, 500), transferCode: invoice?.transferCode ?? codes[0], invoiceId: invoice?.id ?? null, orgCode: invoice?.orgCode ?? null, outcome })
          .onConflictDoNothing({ target: schema.platformBillingPayments.bankRef })
          .returning({ id: schema.platformBillingPayments.id });
        if (ins.length === 0) return null;
        if (outcome === "MATCHED" && invoice) {
          const applied = await applyInvoicePaid(tx, invoice, { amountVnd: row.amount, source: "BANK", ref: row.bankRef, byEmail: null, actor: null, reason: null }, now);
          if (!applied) await tx.update(schema.platformBillingPayments).set({ outcome: "INVOICE_NOT_OPEN" }).where(eq(schema.platformBillingPayments.id, ins[0].id));
          return applied ? "MATCHED" : "INVOICE_NOT_OPEN";
        }
        return outcome;
      });
      if (recorded === null) continue;
      out.recorded++;
      if (recorded === "MATCHED") {
        out.matched++;
        afterPaidWrite(invoice!.orgCode);
      } else out.unmatched++;
    } catch (error) {
      out.errors.push(`${row.bankRef}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Khoản chờ xác nhận mang mã của một hoá đơn ĐANG MỞ ⇒ khách nhiều khả năng đã trả mà máy không tự gia hạn — báo người vận hành
  // MỘT tin mỗi ngày (review PR thu phí, MEDIUM-2). Không báo thì khoản ấy nằm im ở /platform tới khi workspace bị khoá. Hỏng báo
  // không làm hỏng lượt đối chiếu.
  if (unconfirmedCodes.length) {
    const open = await pdb.select({ id: inv.id }).from(inv).where(and(inArray(inv.transferCode, [...new Set(unconfirmedCodes)]), eq(inv.status, "OPEN")));
    if (open.length) await notifyBillingOperators(open.length, now).catch(() => undefined);
  }
  return out;
}

/**
 * Báo người vận hành nền tảng (quyền `platform:operate`, CSDL nhà) qua HỘP THƯ cá nhân, MỘT tin mỗi ngày (khoá theo ngày giờ VN). Không
 * dùng chuông chung `notifications`: ai trong nhà có quyền xem cảnh báo cũng đọc được chuông, trong khi trang đích chỉ người vận hành mở.
 */
async function notifyBillingOperators(count: number, now: Date): Promise<void> {
  const home = await getHomeOrganization();
  const day = vnDate(now);
  const title = "Tiền thuê bao chờ xác nhận nguồn";
  const body = `${count} hoá đơn đang mở có khoản tiền mang đúng mã nhưng KHÔNG do SePay ghi vào đúng tài khoản nhận (sao kê nhập tệp · gõ tay · tài khoản khác) — máy không tự gia hạn. Kiểm tiền thật trong ngân hàng rồi xác nhận ở /platform.`;
  const href = "/platform#billing";
  await withOrganization(home.code, async () => {
    const db = await getDb();
    const users = await activeUserIdsWhoCan("platform:operate");
    await sendInboxMessages(users.map((userId) => ({ userId, kind: "BILLING_PAYMENT", title, body, href, dedupeKey: `billing-unconfirmed:${day}:${userId}` })), db);
  });
}

/** Đọc một dòng tiền VÀO mang mã thuê bao mà bộ khớp CHƯA ghi — đầu vào chung của «Đã nhận tiền…» và «Không phải tiền thuê bao». */
async function pendingBankRow(bankRef: string) {
  const pdb = await getPlatformDb();
  const bt = schema.bankTransactions;
  const [row] = await pdb
    .select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description, provider: bt.provider, providerTxnId: bt.providerTxnId, account: bt.account, source: bt.source })
    .from(bt)
    .where(eq(bt.bankRef, bankRef))
    .limit(1);
  if (!row || !(row.amount > 0)) return { error: "Không thấy khoản tiền vào mang mã bút toán này." } as const;
  const codes = extractTransferCodes(row.description);
  if (!codes.length) return { error: "Nội dung chuyển khoản không mang mã thuê bao." } as const;
  const [used] = await pdb.select({ id: schema.platformBillingPayments.id }).from(schema.platformBillingPayments).where(eq(schema.platformBillingPayments.bankRef, bankRef)).limit(1);
  if (used) return { error: "Khoản tiền này đã được dùng (đã khớp / đã xác nhận / đã bỏ qua) — một dòng chỉ xử lý MỘT lần." } as const;
  if (paymentBankRowTrust(row, (await getBillingReceiver())?.accountNumber ?? null) === "TRUSTED") return { error: "Khoản này do SePay ghi vào đúng tài khoản nhận — bộ khớp tự xử lý (bấm «Đối chiếu lại»), không xác nhận tay." } as const;
  return { row, codes } as const;
}

/**
 * NGƯỜI VẬN HÀNH XÁC NHẬN một khoản tiền thuê bao mà máy không tự khớp (dòng không do SePay tạo vào đúng tài khoản nhận). Máy chủ
 * đọc lại DÒNG NGÂN HÀNG — không tin số tiền client gửi; mã của hoá đơn phải nằm trong nội dung; áp CÙNG `judgePayment` với bộ
 * khớp: trả THIẾU ⇒ từ chối, trừ khi người vận hành chủ động «nhận thiếu» kèm lý do. Trong MỘT giao dịch: ghi `platform_billing_
 * payments` (khoá `bank_ref` ⇒ một dòng chỉ trả MỘT hoá đơn) rồi gia hạn (review PR thu phí, MEDIUM-1).
 */
export async function confirmBankPayment(user: SessionUser, raw: { bankRef?: unknown; invoiceId?: unknown; acceptUnderpaid?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const bankRef = typeof raw.bankRef === "string" ? raw.bankRef.trim() : "";
  const invoiceId = typeof raw.invoiceId === "string" ? raw.invoiceId.trim() : "";
  if (!bankRef || !invoiceId) return { error: "Thiếu mã bút toán hoặc hoá đơn." };
  const p = await pendingBankRow(bankRef);
  if ("error" in p) return { error: p.error ?? "Không đọc được khoản tiền." };
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const [invoice] = await pdb.select().from(inv).where(eq(inv.id, invoiceId)).limit(1);
  if (!invoice) return { error: "Không thấy hoá đơn." };
  if (!p.codes.includes(invoice.transferCode)) return { error: `Nội dung chuyển khoản không mang mã ${invoice.transferCode}.` };
  const outcome = judgePayment(p.row.amount, invoice);
  if (outcome === "INVOICE_NOT_OPEN") return { error: "Hoá đơn không còn mở (đã thu hoặc đã huỷ)." };
  const underpaid = outcome === "UNDERPAID";
  if (underpaid && raw.acceptUnderpaid !== true) return { error: `Khoản này THIẾU ${vnd(invoice.amountVnd - p.row.amount)} so với hoá đơn ${invoice.transferCode} — muốn vẫn gia hạn thì đánh dấu «nhận thiếu» và ghi lý do.` };
  const now = new Date();
  const note = `${underpaid ? "[NHẬN THIẾU] " : ""}${reason}`;
  const res = await pdb.transaction(async (tx) => {
    const ins = await tx
      .insert(schema.platformBillingPayments)
      .values({
        bankRef: p.row.bankRef,
        txnAt: p.row.txnAt,
        amountVnd: p.row.amount,
        description: p.row.description.slice(0, 500),
        transferCode: invoice.transferCode,
        invoiceId: invoice.id,
        orgCode: invoice.orgCode,
        outcome: underpaid ? "UNDERPAID" : "MATCHED",
        ...(underpaid ? { resolvedAt: now, resolvedByEmail: user.email, resolvedNote: note } : {}),
      })
      .onConflictDoNothing({ target: schema.platformBillingPayments.bankRef })
      .returning({ id: schema.platformBillingPayments.id });
    if (!ins.length) return "USED" as const;
    const applied = await applyInvoicePaid(tx, invoice, { amountVnd: p.row.amount, source: "MANUAL", ref: p.row.bankRef, byEmail: user.email, actor: actorOf(user), reason: note }, now);
    // Hoá đơn vừa được trả bằng đường khác ⇒ huỷ cả lượt ghi khoản tiền (dòng còn nguyên cho lượt xử lý sau).
    if (!applied) throw new InvoiceRaceError();
    return "OK" as const;
  }).catch((e: unknown) => {
    if (e instanceof InvoiceRaceError) return "RACE" as const;
    throw e;
  });
  if (res === "USED") return { error: "Khoản tiền này vừa được dùng ở lượt khác — một dòng chỉ trả MỘT hoá đơn." };
  if (res === "RACE") return { error: "Hoá đơn vừa được trả bằng đường khác — tải lại trang." };
  afterPaidWrite(invoice.orgCode);
  return { ok: true, message: `Đã xác nhận ${vnd(p.row.amount)} cho ${invoice.transferCode}${underpaid ? " (nhận thiếu)" : ""}.` };
}

class InvoiceRaceError extends Error {}

/**
 * «KHÔNG PHẢI TIỀN THUÊ BAO / TRÙNG» — người vận hành gạt một dòng chờ xác nhận ra khỏi danh sách (vd bản trùng của khoản đã thu, tiền
 * chuyển nhầm mã). Không xoá gì: ghi `platform_billing_payments` với phán quyết của `judgePayment` + «đã xử lý» kèm lý do, nhật ký
 * nền tảng. Dòng mang mã của hoá đơn ĐANG MỞ và đủ tiền thì không cho gạt — đó là việc «Đã nhận tiền…» hoặc huỷ hoá đơn trước.
 */
export async function dismissBankPayment(user: SessionUser, raw: { bankRef?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const bankRef = typeof raw.bankRef === "string" ? raw.bankRef.trim() : "";
  if (!bankRef) return { error: "Thiếu mã bút toán." };
  const p = await pendingBankRow(bankRef);
  if ("error" in p) return { error: p.error ?? "Không đọc được khoản tiền." };
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const candidates = await pdb.select().from(inv).where(inArray(inv.transferCode, p.codes));
  const invoice = candidates.find((c) => c.status === "OPEN") ?? candidates[0] ?? null;
  const outcome = judgePayment(p.row.amount, invoice);
  if (outcome === "MATCHED") return { error: `Hoá đơn ${invoice?.transferCode ?? ""} đang mở và khoản này đủ tiền — kiểm ngân hàng rồi «Đã nhận tiền…»; chắc chắn không phải tiền thuê bao thì huỷ hoá đơn trước.` };
  // Trả THIẾU cho hoá đơn ĐANG MỞ là tiền thật của khách — gạt đi thì nó biến khỏi mọi danh sách trong khi hoá đơn vẫn mở (lượt duyệt
  // lại, LOW-3): «Đã nhận tiền…» + «nhận thiếu», hoặc đợi khách chuyển bù.
  if (outcome === "UNDERPAID" && invoice?.status === "OPEN") return { error: `Khoản này là tiền trả THIẾU cho hoá đơn ${invoice.transferCode} đang mở — xác nhận «nhận thiếu» hoặc đợi khách chuyển bù, không gạt.` };
  const home = await getHomeOrganization();
  const now = new Date();
  const res = await pdb.transaction(async (tx) => {
    const ins = await tx
      .insert(schema.platformBillingPayments)
      .values({ bankRef: p.row.bankRef, txnAt: p.row.txnAt, amountVnd: p.row.amount, description: p.row.description.slice(0, 500), transferCode: invoice?.transferCode ?? p.codes[0], invoiceId: invoice?.id ?? null, orgCode: invoice?.orgCode ?? null, outcome, resolvedAt: now, resolvedByEmail: user.email, resolvedNote: reason })
      .onConflictDoNothing({ target: schema.platformBillingPayments.bankRef })
      .returning({ id: schema.platformBillingPayments.id });
    if (!ins.length) return false;
    await auditTx(tx, { action: "BILLING_PAYMENT_RESOLVE", targetOrgCode: invoice?.orgCode ?? home.code, subject: `payment:${p.row.bankRef}`, before: { outcome, source: p.row.source }, after: { resolved: true, dismissed: true }, reason, actor: actorOf(user) });
    return true;
  });
  if (!res) return { error: "Khoản tiền này vừa được xử lý ở lượt khác." };
  return { ok: true, message: "Đã gạt khoản tiền khỏi danh sách chờ xác nhận (không xoá — còn trong nhật ký)." };
}

/**
 * Sau khi NHẬP SAO KÊ vào sổ ngân hàng của NHÀ: đối chiếu đúng những dòng mang mã thuê bao / mã nạp (cửa sổ 60 ngày — khôi phục sau sự
 * cố thường nhập sao kê muộn vài ngày). Dòng sao kê không tự gia hạn, nhưng lượt này BÁO người vận hành khi nó khớp hoá đơn đang mở
 * (lượt duyệt lại, MEDIUM-A) — không đợi ai tình cờ bấm «Đối chiếu lại». Tổ chức khác ⇒ không làm gì. Không ném.
 */
export async function reconcileAfterStatementImport(rows: readonly { bankRef: string; description: string; amount: number }[]): Promise<ReconcileSummary | null> {
  try {
    if (!(await currentOrganization()).isHome) return null;
    const refs = rows.filter((r) => r.amount > 0 && (extractTransferCodes(r.description).length > 0 || extractTopupCodes(r.description).length > 0)).map((r) => r.bankRef);
    if (!refs.length) return null;
    return await reconcileBillingPayments({ bankRefs: refs, lookbackDays: BILLING_RECONCILE_LOOKBACK_DAYS });
  } catch {
    return null;
  }
}

/** Nút «Đối chiếu lại tiền thuê bao» của người vận hành. */
export async function reconcileBillingAsOperator(user: SessionUser): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const r = await reconcileBillingPayments();
  if (r.errors.length) return { error: `Đã ghi ${r.recorded} khoản (${r.matched} khớp); ${r.errors.length} khoản hỏng: ${r.errors.slice(0, 2).join(" · ")}` };
  const topups = r.topupCredited + r.topupHeld ? ` · Số dư AI: ${r.topupCredited} khoản nạp đã cộng, ${r.topupHeld} khoản giữ lại chờ xem (trang Số dư AI)` : "";
  const unconfirmed = r.unconfirmed ? ` · ${r.unconfirmed} khoản mang mã thuê bao KHÔNG do SePay ghi vào đúng tài khoản nhận — không tự gia hạn, xem «Tiền thuê bao chờ xác nhận nguồn»` : "";
  return { ok: true, message: (r.recorded === 0 ? `Không có khoản tiền mới mang mã thanh toán (đã quét ${BILLING_RECONCILE_LOOKBACK_DAYS} ngày)` : `Đã ghi ${r.recorded} khoản: ${r.matched} khớp và gia hạn, ${r.unmatched} cần xem tay${topups}`) + `${unconfirmed}.` };
}

// ─────────────────────────── Người vận hành ───────────────────────────

export async function setOrgBilling(user: SessionUser, raw: { orgCode?: unknown; enabled?: unknown; paidThrough?: unknown; graceDays?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = await parseOperatorTarget(user, raw);
  if ("error" in p) return p;
  if (p.org.isHome) return { error: "Tổ chức nhà không thu phí." };
  const enabled = raw.enabled === true;
  const paidThrough = typeof raw.paidThrough === "string" && raw.paidThrough.trim() ? raw.paidThrough.trim() : null;
  if (enabled && !isIsoDate(paidThrough)) return { error: "Bật thu phí phải khai «Đã trả tới ngày» (hạn dùng thử nếu chưa trả lần nào)." };
  if (paidThrough !== null && !isIsoDate(paidThrough)) return { error: "Ngày không hợp lệ." };
  const graceRaw = raw.graceDays === undefined || raw.graceDays === "" ? BILLING_DEFAULT_GRACE_DAYS : Number(raw.graceDays);
  if (!Number.isInteger(graceRaw) || graceRaw < 0 || graceRaw > BILLING_GRACE_MAX) return { error: `Số ngày ân hạn phải là số nguyên 0–${BILLING_GRACE_MAX}.` };
  const pdb = await getPlatformDb();
  const subs = schema.platformSubscriptions;
  const [before] = await pdb.select().from(subs).where(eq(subs.orgCode, p.org.code)).limit(1);
  const next = { billingEnabled: enabled, paidThrough, graceDays: graceRaw };
  // MỘT MỐC HẾT DÙNG THỬ (review L5): thuê bao đang mang điều khoản dùng thử (0232) ⇒ «Đã trả tới ngày» chính là ngày cuối dùng thử,
  // nên `trial_ends_at` đi CÙNG lượt ghi (cùng nhật ký). Không làm vậy thì người vận hành gia hạn dùng thử, thu phí «còn hạn» mà cổng
  // AI vẫn dừng ở mốc cũ.
  const trialEndsAt = before?.trialEndsAt && paidThrough ? trialEndFromLastDay(paidThrough) : null;
  if (trialEndsAt && before?.trialStartedAt && trialEndsAt.getTime() <= before.trialStartedAt.getTime()) return { error: "Hạn dùng thử phải sau ngày bắt đầu dùng thử." };
  const trialChanged = Boolean(trialEndsAt && before?.trialEndsAt && trialEndsAt.getTime() !== before.trialEndsAt.getTime());
  if (before && !trialChanged && before.billingEnabled === next.billingEnabled && (before.paidThrough ?? null) === next.paidThrough && before.graceDays === next.graceDays) return { ok: true, message: "Không có gì thay đổi." };
  const now = new Date();
  const write = { ...next, ...(trialEndsAt ? { trialEndsAt } : {}) };
  await pdb.transaction(async (tx) => {
    await tx.insert(subs).values({ orgCode: p.org.code, ...write }).onConflictDoUpdate({ target: subs.orgCode, set: { ...write, updatedAt: now } });
    await auditTx(tx, {
      action: "BILLING_SET",
      targetOrgCode: p.org.code,
      subject: "subscription",
      before: before ? { billingEnabled: before.billingEnabled, paidThrough: before.paidThrough, graceDays: before.graceDays, ...(before.trialEndsAt ? { trialEndsAt: before.trialEndsAt.toISOString() } : {}) } : null,
      after: { ...next, ...(trialEndsAt ? { trialEndsAt: trialEndsAt.toISOString() } : {}) },
      reason: p.reason,
      actor: p.actor,
    });
  });
  invalidateSubscriptions(p.org.code);
  const st = billingStanding(next, vnDate(now));
  return { ok: true, message: enabled ? `«${p.org.name}»: thu phí BẬT, trả tới ${paidThrough}, ân hạn ${graceRaw} ngày — hiện «${st.kind}».` : `«${p.org.name}»: thu phí TẮT — không nhắc, không khoá.` };
}

/**
 * KHỞI TẠO THU PHÍ CỦA MỘT WORKSPACE MỚI — MỘT dịch vụ cho cả hai cửa tạo khách: người vận hành (`lib/saas/provisioning.ts` · bước
 * BILLING, trước đây SKIPPED) và cửa hàng tự đăng ký / khách mời (`lib/onboarding/service.ts::runSetup`). Gọi MỘT lần sau khi
 * dựng tổ chức; chạy lại an toàn (mọi bước idempotent).
 *
 *  1. GHIM phiên bản giá: tổ chức chưa có ghim ⇒ ghim bảng giá CATALOG đang hiệu lực (V1), nguồn `PROVISIONING`. Đổi giá về sau
 *     (phiên bản mới) KHÔNG kéo khách này theo — đúng luật «thuê bao giữ phiên bản giá truy vết được». Ghim có sẵn ⇒ giữ nguyên.
 *  2. THUÊ BAO + KỲ: chèn dòng `platform_subscriptions` khi chưa có (có rồi — chạy lại, hoặc người vận hành đã đặt điều khoản riêng
 *     ⇒ không đụng). Kỳ tính tiền = tháng lịch giờ VN (`usagePeriodOf` — cùng kỳ của đồng hồ khách AI); không lưu bảng chu kỳ.
 *  3. DÙNG THỬ: dòng giá của gói khai `trial_days` ⇒ chụp `trial_days` / `trial_started_at` / `trial_ends_at` (00:00 giờ VN sau ngày
 *     cuối) + `paid_through` = ngày cuối. Cổng AI dừng bot khi tới `trial_ends_at` (lib/pricing/ai-gate.ts). Bật thu phí (khoá chỉ
 *     xem khi quá hạn) CHỈ cho cửa hàng TỰ ĐĂNG KÝ và CHỈ khi nền tảng đã khai tài khoản nhận tiền — khoá một khách không có đường
 *     trả tiền là khoá oan; khách người vận hành tạo giữ «Chưa thu phí» tới khi người vận hành đặt hạn trả.
 */
export type WorkspaceBillingInit = {
  status: "DONE" | "SKIPPED";
  detail: string;
  pinnedVersion: string | null;
  trial: { days: number; startedAt: string; endsAt: string; paidThrough: string } | null;
  billingEnabled: boolean;
  created: boolean;
};

export async function initWorkspaceBilling(orgCode: string, opts: { selfService: boolean; now?: Date; actor?: PlatformActor; reason?: string } = { selfService: false }): Promise<WorkspaceBillingInit> {
  const now = opts.now ?? new Date();
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { status: "SKIPPED", detail: org ? "workspace nhà không thu phí" : "không có workspace", pinnedVersion: null, trial: null, billingEnabled: false, created: false };
  const reason = opts.reason ?? (opts.selfService ? "Cửa hàng tự đăng ký" : "Cấp phát workspace");
  // 1 · Ghim phiên bản giá.
  const book = await loadPriceBook({ fresh: true });
  let pinKey = await readPricePin(org.code, { fresh: true });
  if (pinKey === null) {
    const catalog = currentCatalogVersion(book, now);
    if (catalog) {
      await pinOrgPriceVersion(org.code, catalog.key, { source: "PROVISIONING", reason, email: null });
      pinKey = catalog.key;
    }
  }
  // 2 · Gói theo phiên bản đã ghim ⇒ số ngày dùng thử (gói không có ở phiên bản ⇒ dòng legacy ⇒ không dùng thử).
  const price = priceOf(book, pinKey, org.plan ?? DEFAULT_PLAN_KEY)?.price ?? null;
  const trialDays = price?.trialDays ?? null;
  const today = vnDate(now);
  let trial: WorkspaceBillingInit["trial"] = null;
  let next: { billingEnabled: boolean; paidThrough: string | null; graceDays: number; note: string; trialStartedAt: Date | null; trialEndsAt: Date | null; trialDays: number | null };
  if (trialDays !== null) {
    const paidThrough = trialPaidThrough(today, trialDays);
    const endsAt = trialEndFromLastDay(paidThrough)!;
    const enable = opts.selfService && Boolean(await getBillingReceiver());
    trial = { days: trialDays, startedAt: now.toISOString(), endsAt: endsAt.toISOString(), paidThrough };
    next = { billingEnabled: enable, paidThrough, graceDays: TRIAL_GRACE_DAYS, note: `Dùng thử ${trialDays} ngày (phiên bản giá ${pinKey ?? "—"}) — ${reason}`, trialStartedAt: now, trialEndsAt: endsAt, trialDays };
  } else {
    next = { billingEnabled: false, paidThrough: null, graceDays: BILLING_DEFAULT_GRACE_DAYS, note: `Kỳ tính tiền tháng lịch giờ VN (phiên bản giá ${pinKey ?? "—"}) — người vận hành đặt hạn trả`, trialStartedAt: null, trialEndsAt: null, trialDays: null };
  }
  const pdb = await getPlatformDb();
  const subs = schema.platformSubscriptions;
  const created = await pdb.transaction(async (tx) => {
    const rows = await tx.insert(subs).values({ orgCode: org.code, ...next }).onConflictDoNothing({ target: subs.orgCode }).returning({ orgCode: subs.orgCode });
    if (rows.length === 0) return false;
    await auditTx(tx, {
      action: "BILLING_SET",
      targetOrgCode: org.code,
      subject: "subscription",
      before: null,
      after: { billingEnabled: next.billingEnabled, paidThrough: next.paidThrough, graceDays: next.graceDays, trialDays: next.trialDays, trialEndsAt: next.trialEndsAt?.toISOString() ?? null, priceVersion: pinKey },
      reason: trial ? `Dùng thử ${trial.days} ngày — ${reason}` : `Khởi tạo thu phí — ${reason}`,
      actor: opts.actor ?? null,
    });
    return true;
  });
  invalidateSubscriptions(org.code);
  const detail = [pinKey ? `ghim giá ${pinKey}` : "chưa có bảng giá niêm yết — chưa ghim", trial ? `dùng thử ${trial.days} ngày tới hết ${trial.paidThrough}` : "kỳ tháng lịch VN", created ? (next.billingEnabled ? "bật thu phí" : "chưa thu phí") : "thuê bao đã có — giữ điều khoản"].join(" · ");
  return { status: "DONE", detail, pinnedVersion: pinKey, trial: created ? trial : null, billingEnabled: created && next.billingEnabled, created };
}

async function operatorInvoice(user: SessionUser, raw: { invoiceId?: unknown; reason?: unknown }): Promise<{ invoice: InvoiceRow; reason: string } | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const id = typeof raw.invoiceId === "string" ? raw.invoiceId : "";
  const pdb = await getPlatformDb();
  const [invoice] = await pdb.select().from(schema.platformInvoices).where(eq(schema.platformInvoices.id, id)).limit(1);
  if (!invoice) return { error: "Không có hoá đơn này." };
  if (invoice.status !== "OPEN") return { error: `Hoá đơn ${invoice.transferCode} đang ${invoice.status} — chỉ hoá đơn đang mở mới xác nhận / huỷ được.` };
  return { invoice, reason };
}

/** Khách chuyển tiền mà sổ ngân hàng chưa có (ngân hàng khác, tiền mặt) — người vận hành xác nhận tay, bắt buộc lý do. */
export async function markInvoicePaidManually(user: SessionUser, raw: { invoiceId?: unknown; amountVnd?: unknown; ref?: unknown; reason?: unknown }): Promise<BillingResult> {
  const p = await operatorInvoice(user, raw);
  if ("error" in p) return p;
  const amount = typeof raw.amountVnd === "number" ? raw.amountVnd : Number(raw.amountVnd);
  if (!Number.isInteger(amount) || amount <= 0) return { error: "Nhập số tiền thực nhận (số nguyên VND)." };
  const ref = typeof raw.ref === "string" && raw.ref.trim() ? raw.ref.trim().slice(0, 120) : null;
  const pdb = await getPlatformDb();
  const now = new Date();
  // Một khoản tiền chỉ trả MỘT hoá đơn (review PR thu phí, MEDIUM-1 · MEDIUM-B). Tham chiếu so ở dạng GỐC lẫn dạng chuẩn hoá của mã
  // bút toán (`normalizeBankRef` — viết hoa, bỏ ký tự lạ): «ft26281 abc» và «FT26281ABC» là cùng một bút toán.
  if (ref) {
    const refs = [...new Set([ref, normalizeBankRef(ref)].filter((x) => x.length > 0))];
    const inv = schema.platformInvoices;
    const pay = schema.platformBillingPayments;
    const bt = schema.bankTransactions;
    const [usedByInvoice] = await pdb.select({ id: inv.id }).from(inv).where(and(inArray(inv.paidRef, refs), ne(inv.id, p.invoice.id))).limit(1);
    if (usedByInvoice) return { error: "Mã chứng từ này đã dùng cho một hoá đơn khác — một khoản tiền chỉ trả MỘT hoá đơn." };
    const [row] = await pdb.select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description }).from(bt).where(inArray(bt.bankRef, refs)).limit(1);
    if (row) {
      const [used] = await pdb.select({ id: pay.id }).from(pay).where(eq(pay.bankRef, row.bankRef)).limit(1);
      if (used) return { error: "Bút toán này đã được dùng (đã khớp / đã xác nhận / đã bỏ qua) — một khoản tiền chỉ trả MỘT hoá đơn." };
      // Mang mã thuê bao ⇒ đi danh sách chờ; mang mã NẠP Số dư AI ⇒ là tiền của sản phẩm khác — không để một khoản trả hai sản phẩm.
      if (extractTransferCodes(row.description).length) return { error: "Bút toán này mang mã thanh toán — xác nhận ở «Tiền thuê bao chờ xác nhận nguồn» (máy đọc lại số tiền, mỗi dòng dùng một lần)." };
      if (extractTopupCodes(row.description).length) return { error: "Bút toán này mang mã nạp Số dư AI (ERPNAP…) — là tiền của Số dư AI, không trả hoá đơn thuê bao." };
      if (!(row.amount > 0)) return { error: "Bút toán này không phải tiền vào." };
      if (row.amount !== amount) return { error: `Số tiền nhập (${vnd(amount)}) khác số tiền của bút toán (${vnd(row.amount)}) — nhập đúng số tiền thật nhận.` };
      // Khách chuyển khoản KHÔNG ghi mã (thường gặp): người vận hành chọn hoá đơn tường minh; bút toán được KHOÁ (ghi bảng đối chiếu)
      // trong CÙNG giao dịch với lượt gia hạn, số tiền là của bút toán.
      const underpaid = row.amount < p.invoice.amountVnd;
      const note = `${underpaid ? "[NHẬN THIẾU] " : ""}${p.reason}`;
      const res = await pdb
        .transaction(async (tx) => {
          const ins = await tx
            .insert(pay)
            .values({ bankRef: row.bankRef, txnAt: row.txnAt, amountVnd: row.amount, description: row.description.slice(0, 500), transferCode: p.invoice.transferCode, invoiceId: p.invoice.id, orgCode: p.invoice.orgCode, outcome: underpaid ? "UNDERPAID" : "MATCHED", ...(underpaid ? { resolvedAt: now, resolvedByEmail: user.email, resolvedNote: note } : {}) })
            .onConflictDoNothing({ target: pay.bankRef })
            .returning({ id: pay.id });
          if (!ins.length) return "USED" as const;
          if (!(await applyInvoicePaid(tx, p.invoice, { amountVnd: row.amount, source: "MANUAL", ref: row.bankRef, byEmail: user.email, actor: actorOf(user), reason: note }, now))) throw new InvoiceRaceError();
          return "OK" as const;
        })
        .catch((e: unknown) => {
          if (e instanceof InvoiceRaceError) return "RACE" as const;
          throw e;
        });
      if (res === "USED") return { error: "Bút toán này vừa được dùng ở lượt khác." };
      if (res === "RACE") return { error: "Hoá đơn vừa được trả bằng đường khác — tải lại trang." };
      afterPaidWrite(p.invoice.orgCode);
      return { ok: true, message: `Đã xác nhận ${p.invoice.transferCode} bằng bút toán ${row.bankRef}${underpaid ? " (nhận thiếu)" : ""}.` };
    }
  }
  const applied = await pdb.transaction((tx) => applyInvoicePaid(tx, p.invoice, { amountVnd: amount, source: "MANUAL", ref, byEmail: user.email, actor: actorOf(user), reason: p.reason }, now));
  if (!applied) return { error: "Hoá đơn vừa được trả bằng đường khác — tải lại trang." };
  afterPaidWrite(p.invoice.orgCode);
  if (p.invoice.kind === "ADDON" && isAddonKind(p.invoice.addonKind)) return { ok: true, message: `Đã xác nhận ${p.invoice.transferCode}: cộng ${addonUnitsLabel(p.invoice.addonKind, p.invoice.addonUnits ?? 0)} vào hạn mức.` };
  return { ok: true, message: `Đã xác nhận ${p.invoice.transferCode}: trả tới ${p.invoice.periodEnd}, gói ${p.invoice.planKey}.` };
}

export async function voidInvoice(user: SessionUser, raw: { invoiceId?: unknown; reason?: unknown }): Promise<BillingResult> {
  const p = await operatorInvoice(user, raw);
  if ("error" in p) return p;
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const now = new Date();
  const done = await pdb.transaction(async (tx) => {
    const won = await tx.update(inv).set({ status: "VOID", voidReason: p.reason, updatedAt: now }).where(and(eq(inv.id, p.invoice.id), eq(inv.status, "OPEN"))).returning({ id: inv.id });
    if (won.length === 0) return false;
    await auditTx(tx, { action: "INVOICE_VOID", targetOrgCode: p.invoice.orgCode, subject: `invoice:${p.invoice.transferCode}`, before: { status: "OPEN" }, after: { status: "VOID" }, reason: p.reason, actor: actorOf(user) });
    return true;
  });
  return done ? { ok: true, message: `Đã huỷ ${p.invoice.transferCode}. Tiền chuyển tới mã này về sau sẽ nằm ở «Tiền chưa khớp».` } : { error: "Hoá đơn vừa đổi trạng thái — tải lại trang." };
}

export async function setPlanPrice(user: SessionUser, raw: { planKey?: unknown; priceVnd?: unknown; yearlyFreeMonths?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const planKey = typeof raw.planKey === "string" ? raw.planKey : "";
  if (planKey === HOME_PLAN_KEY) return { error: "Gói nội bộ không bán." };
  const price = raw.priceVnd === null || raw.priceVnd === "" ? null : Number(raw.priceVnd);
  if (price !== null && (!Number.isInteger(price) || price < PLAN_PRICE_MIN_VND || price > PLAN_PRICE_MAX_VND)) return { error: `Giá một tháng là số nguyên ${vnd(PLAN_PRICE_MIN_VND)} – ${vnd(PLAN_PRICE_MAX_VND)}, hoặc để trống = không bán.` };
  // Sửa giá = PHÁT HÀNH phiên bản giá mới (0228) chép từ bảng giá hiện hành — không sửa dòng cũ. Tổ chức đã ghim phiên bản
  // cũ giữ giá cũ; mua mới / đổi gói đi giá mới.
  const { plans } = await catalogPlans();
  const plan = plans.find((p) => p.key === planKey)?.planPrice ?? null;
  if (!plan) return { error: `Gói «${planKey}» không có trong bảng giá hiện hành — gói cũ giữ nguyên giá cho thuê bao đang dùng (đổi giá cho họ = chuyển họ sang phiên bản khác).` };
  const free = raw.yearlyFreeMonths === undefined || raw.yearlyFreeMonths === "" ? plan.yearlyFreeMonths : Number(raw.yearlyFreeMonths);
  if (!Number.isInteger(free) || free < 0 || free > YEARLY_FREE_MONTHS_MAX) return { error: `Số tháng tặng khi trả 12 tháng là số nguyên 0–${YEARLY_FREE_MONTHS_MAX}.` };
  if (plan.monthlyVnd === price && plan.yearlyFreeMonths === free) return { ok: true, message: "Giá không đổi." };
  const r = await publishCatalogVersion({ planKey, patch: { monthlyVnd: price, yearlyFreeMonths: free }, reason, actor: actorOf(user), email: user.email });
  if ("error" in r) return r;
  const freeText = free > 0 ? ` Trả 12 tháng tặng ${free} tháng.` : "";
  return { ok: true, message: price === null ? `Gói «${plan.name}» thôi bán từ phiên bản ${r.versionKey}. Thuê bao đang dùng và hoá đơn đang mở giữ giá cũ.` : `Gói «${plan.name}»: ${vnd(price)}/tháng từ phiên bản ${r.versionKey}.${freeText} Thuê bao đã ghim giá cũ và hoá đơn đang mở giữ giá cũ.` };
}

/**
 * Đơn giá MUA THÊM của một gói: `{ <hạng mục>: VND / bước / tháng | null }` — `null` / bỏ trống = gói thôi bán hạng mục đó.
 * Không có giá mặc định (luật 38). Áp cho hoá đơn TẠO TỪ BÂY GIỜ — hoá đơn đang mở giữ giá cũ, phần khách đã mua giữ nguyên.
 */
export async function setPlanAddonPrices(user: SessionUser, raw: { planKey?: unknown; prices?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const planKey = typeof raw.planKey === "string" ? raw.planKey : "";
  if (planKey === HOME_PLAN_KEY) return { error: "Gói nội bộ không bán." };
  const input = raw.prices && typeof raw.prices === "object" && !Array.isArray(raw.prices) ? (raw.prices as Record<string, unknown>) : null;
  if (!input) return { error: "Thiếu bảng đơn giá." };
  const next: AddonPrices = {};
  for (const [k, v] of Object.entries(input)) {
    if (!isAddonKind(k)) return { error: `Hạng mục «${k}» không bán thêm được.` };
    if (v === null || v === "" || v === undefined) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < ADDON_PRICE_MIN_VND || n > ADDON_PRICE_MAX_VND) return { error: `${ENTITLEMENT_SPEC[k].label}: đơn giá là số nguyên ${vnd(ADDON_PRICE_MIN_VND)} – ${vnd(ADDON_PRICE_MAX_VND)} cho mỗi bước / tháng, hoặc để trống = không bán.` };
    next[k] = n;
  }
  // Như giá gói: đơn giá mua thêm mới = phiên bản giá mới (0228). Thuê bao đã ghim giữ đơn giá của phiên bản họ đang ở.
  const { plans } = await catalogPlans();
  const plan = plans.find((p) => p.key === planKey)?.planPrice ?? null;
  if (!plan) return { error: `Gói «${planKey}» không có trong bảng giá hiện hành — đơn giá mua thêm của gói cũ giữ nguyên cho thuê bao đang dùng.` };
  const before = parseAddonPrices(plan.addonPrices);
  if (JSON.stringify(before) === JSON.stringify(next)) return { ok: true, message: "Đơn giá không đổi." };
  const r = await publishCatalogVersion({ planKey, patch: { addonPrices: next }, reason, actor: actorOf(user), email: user.email });
  if ("error" in r) return r;
  const sold = ADDON_KINDS.filter((k) => next[k] !== undefined);
  return { ok: true, message: sold.length ? `Gói «${plan.name}» bán thêm (phiên bản ${r.versionKey}): ${sold.map((k) => `${ENTITLEMENT_SPEC[k].label.toLowerCase()} ${vnd(next[k]!)}`).join(" · ")} (mỗi bước / tháng).` : `Gói «${plan.name}» thôi bán thêm mọi hạng mục (phiên bản ${r.versionKey}).` };
}

/**
 * Người vận hành SỬA phần đã mua thêm của một tổ chức (`{ <hạng mục>: số BƯỚC }`) — tặng khi chăm sóc khách, giảm khi khách
 * xin bớt từ kỳ sau. Không tạo hoá đơn, không hoàn tiền: tiền là việc ngoài hệ thống, lý do vào nhật ký.
 */
export async function setOrgAddons(user: SessionUser, raw: { orgCode?: unknown; blocks?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const p = await parseOperatorTarget(user, raw);
  if ("error" in p) return p;
  if (p.org.isHome) return { error: "Tổ chức nhà không giới hạn — không có gì để mua thêm." };
  const input = raw.blocks && typeof raw.blocks === "object" && !Array.isArray(raw.blocks) ? (raw.blocks as Record<string, unknown>) : null;
  if (!input) return { error: "Thiếu số lượng." };
  const next: AddonUnits = {};
  for (const [k, v] of Object.entries(input)) {
    if (!isAddonKind(k)) return { error: `Hạng mục «${k}» không bán thêm được.` };
    const n = v === "" || v === null || v === undefined ? 0 : typeof v === "number" ? v : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > ADDON_MAX_BLOCKS * 10) return { error: `${ENTITLEMENT_SPEC[k].label}: số phần là số nguyên 0–${ADDON_MAX_BLOCKS * 10}.` };
    if (n > 0) next[k] = n * ADDON_STEP[k];
  }
  const pdb = await getPlatformDb();
  const subs = schema.platformSubscriptions;
  const [row] = await pdb.select({ addons: subs.addons }).from(subs).where(eq(subs.orgCode, p.org.code)).limit(1);
  const before = parseAddonUnits(row?.addons);
  if (JSON.stringify(before) === JSON.stringify(next)) return { ok: true, message: "Không có gì thay đổi." };
  const now = new Date();
  await pdb.transaction(async (tx) => {
    await tx.insert(subs).values({ orgCode: p.org.code, addons: next }).onConflictDoUpdate({ target: subs.orgCode, set: { addons: next, updatedAt: now } });
    await auditTx(tx, { action: "ORG_ADDONS_SET", targetOrgCode: p.org.code, subject: "addons", before, after: next, reason: p.reason, actor: p.actor });
  });
  invalidateSubscriptions(p.org.code);
  const parts = ADDON_KINDS.filter((k) => (next[k] ?? 0) > 0).map((k) => addonUnitsLabel(k, next[k]!));
  return { ok: true, message: `«${p.org.name}»: ${parts.length ? `mua thêm ${parts.join(" · ")}` : "không còn phần mua thêm nào"}. Có hiệu lực ngay; giá tháng từ lần gia hạn sau tính theo phần này.` };
}

/** Người vận hành ghi số hoá đơn VAT đã xuất (ngoài ERP) cho một hoá đơn ĐÃ TRẢ mà khách yêu cầu xuất. */
export async function markVatIssued(user: SessionUser, raw: { invoiceId?: unknown; vatRef?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const id = typeof raw.invoiceId === "string" ? raw.invoiceId : "";
  const vatRef = typeof raw.vatRef === "string" ? raw.vatRef.trim().slice(0, 60) : "";
  if (vatRef.length < 3) return { error: "Nhập số / ký hiệu hoá đơn VAT đã xuất." };
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const [row] = await pdb.select().from(inv).where(eq(inv.id, id)).limit(1);
  if (!row) return { error: "Không có hoá đơn này." };
  if (row.status !== "PAID") return { error: "Chỉ xuất hoá đơn VAT cho khoản ĐÃ THU." };
  if (!row.invoiceInfo) return { error: "Khách không yêu cầu hoá đơn VAT cho lần trả này." };
  if (row.vatIssuedAt) return { ok: true, message: `Đã ghi trước đó: ${row.vatRef ?? ""}.` };
  const now = new Date();
  const done = await pdb.transaction(async (tx) => {
    const won = await tx.update(inv).set({ vatIssuedAt: now, vatRef, vatIssuedByEmail: user.email, updatedAt: now }).where(and(eq(inv.id, id), isNull(inv.vatIssuedAt))).returning({ id: inv.id });
    if (won.length === 0) return false;
    await auditTx(tx, { action: "INVOICE_VAT_ISSUED", targetOrgCode: row.orgCode, subject: `invoice:${row.transferCode}`, before: { vatIssuedAt: null }, after: { vatRef }, reason: null, actor: actorOf(user) });
    return true;
  });
  return done ? { ok: true, message: `Đã ghi hoá đơn VAT ${vatRef} cho ${row.transferCode}.` } : { error: "Hoá đơn vừa được ghi bằng đường khác — tải lại trang." };
}

/** Khoản tiền không khớp đã được xử lý ngoài hệ thống (hoàn tiền, xác nhận tay hoá đơn khác…) — đánh dấu, không xoá. */
export async function resolveBillingPayment(user: SessionUser, raw: { paymentId?: unknown; reason?: unknown }): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const reason = operatorReason(raw.reason);
  if (typeof reason !== "string") return reason;
  const id = typeof raw.paymentId === "string" ? raw.paymentId : "";
  const pdb = await getPlatformDb();
  const t = schema.platformBillingPayments;
  const [row] = await pdb.select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) return { error: "Không có khoản tiền này." };
  if (row.outcome === "MATCHED") return { error: "Khoản này đã khớp — không có gì để xử lý." };
  if (row.resolvedAt) return { ok: true, message: "Khoản này đã được đánh dấu xử lý." };
  const home = await getHomeOrganization();
  const now = new Date();
  await pdb.transaction(async (tx) => {
    await tx.update(t).set({ resolvedAt: now, resolvedByEmail: user.email, resolvedNote: reason }).where(and(eq(t.id, id), isNull(t.resolvedAt)));
    await auditTx(tx, { action: "BILLING_PAYMENT_RESOLVE", targetOrgCode: row.orgCode ?? home.code, subject: `payment:${row.bankRef}`, before: { outcome: row.outcome }, after: { resolved: true }, reason, actor: actorOf(user) });
  });
  return { ok: true, message: "Đã đánh dấu xử lý." };
}

// ─────────────────────────── Màn hình ───────────────────────────

export type PlanOffer = { key: string; name: string; description: string | null; priceVnd: number; limits: unknown; yearlyFreeMonths: number; yearlyPriceVnd: number | null };

export type AddonOffer = { kind: AddonKind; label: string; unit: string; step: number; unitPriceVnd: number; ownedUnits: number };
export type OwnedAddon = { kind: AddonKind; label: string; units: number; unitsLabel: string };

export type TenantBilling = {
  today: string;
  standing: BillingStanding;
  terms: SubscriptionTerms | null;
  currentPlan: { key: string; name: string; priceVnd: number | null } | null;
  offers: PlanOffer[];
  receiver: BillingReceiverView | null;
  openInvoice: (InvoiceView & { qrPayload: string | null; qrError: string | null }) | null;
  invoices: InvoiceView[];
  /** Hạng mục gói hiện tại bán thêm (đã khai giá). Rỗng = gói chưa bán thêm gì. */
  addonOffers: AddonOffer[];
  /** Phần đã mua thêm. */
  addons: OwnedAddon[];
  /** Tiền một tháng của phần đã mua theo giá gói hiện tại; `null` = gói không còn khai giá cho một phần đang có. */
  addonMonthlyVnd: number | null;
  /** Vì sao chưa mua thêm được lúc này (chưa vào kỳ trả phí · quá hạn) — `null` = mua được. */
  addonBlockedReason: string | null;
  invoiceInfo: InvoiceInfo | null;
};

type PricedRow = PlanRow & { yearlyPriceVnd: number | null; planPrice: PlanPrice | null };

/**
 * Gói khách tự chọn được: mọi gói TỰ MUA của bảng giá đang niêm yết, cộng gói ĐANG DÙNG nếu nó còn gia hạn được ở giá đã ghim
 * (gói cũ không niêm yết nữa vẫn gia hạn được — không ép khách hiện tại lên giá mới).
 */
function tenantOffers(current: PricedRow | undefined, catalog: readonly PricedRow[]): PlanOffer[] {
  const offer = (p: PricedRow): PlanOffer => ({ key: p.key, name: p.name, description: p.description, priceVnd: p.priceVnd!, limits: p.limits, yearlyFreeMonths: p.yearlyFreeMonths, yearlyPriceVnd: p.yearlyPriceVnd });
  const out = catalog.filter((p) => p.key !== HOME_PLAN_KEY && p.planPrice && isSellable(p.planPrice)).map(offer);
  if (current && current.key !== HOME_PLAN_KEY && current.priceVnd !== null && current.planPrice && isSellable(current.planPrice)) {
    const i = out.findIndex((o) => o.key === current.key);
    if (i >= 0) out[i] = offer(current);
    else out.unshift(offer(current));
  }
  return out;
}

function ownedAddons(units: AddonUnits): OwnedAddon[] {
  return ADDON_KINDS.filter((k) => (units[k] ?? 0) > 0).map((k) => ({ kind: k, label: ENTITLEMENT_SPEC[k].label, units: units[k]!, unitsLabel: addonUnitsLabel(k, units[k]!) }));
}

export async function loadTenantBilling(orgCode: string, now: Date = new Date()): Promise<TenantBilling | null> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return null;
  // Giá theo PHIÊN BẢN (0228): gói đang dùng theo phiên bản đã ghim; gói mua mới theo bảng giá đang niêm yết.
  const [plans, terms, receiver, catalog] = await Promise.all([plansForOrg(org.code, now), readSubscriptionTerms(org.code, { fresh: true }), getBillingReceiver(), catalogPlans(now)]);
  const today = vnDate(now);
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const [rows, [sub]] = await Promise.all([
    pdb.select().from(inv).where(eq(inv.orgCode, org.code)).orderBy(desc(inv.createdAt)).limit(24),
    pdb.select({ addons: schema.platformSubscriptions.addons, invoiceInfo: schema.platformSubscriptions.invoiceInfo }).from(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, org.code)).limit(1),
  ]);
  const units = parseAddonUnits(sub?.addons);
  const views = rows.map((r) => invoiceView(r, plans));
  const open = views.find((v) => v.status === "OPEN") ?? null;
  let openInvoice: TenantBilling["openInvoice"] = null;
  if (open) {
    const qr = receiver ? buildVietQrPayload({ bin: receiver.bin, accountNumber: receiver.accountNumber, amount: open.amountVnd, note: open.transferCode }) : null;
    openInvoice = { ...open, qrPayload: qr?.ok ? qr.payload : null, qrError: !receiver ? "Nền tảng chưa khai tài khoản nhận tiền." : qr && !qr.ok ? qr.error : null };
  }
  const current = plans.find((p) => p.key === planKeyOf(org));
  const prices = parseAddonPrices(current?.addonPrices);
  const monthly = addonMonthlyVnd(units, prices);
  const standing = billingStanding(terms, today);
  const firstPriced = ADDON_KINDS.find((k) => prices[k] !== undefined);
  // Lý do chặn lấy từ CHÍNH hàm báo giá (một lần thử với 1 phần) — màn hình không tự dựng luật thứ hai.
  const probe = firstPriced ? quoteAddon({ terms, planName: current?.name ?? "", kind: firstPriced, blocks: 1, prices, today }) : null;
  return {
    today,
    standing,
    terms,
    currentPlan: current ? { key: current.key, name: current.name, priceVnd: current.priceVnd } : null,
    offers: tenantOffers(current, catalog.plans),
    receiver,
    openInvoice,
    invoices: views.filter((v) => v.status !== "OPEN"),
    addonOffers: ADDON_KINDS.filter((k) => prices[k] !== undefined).map((k) => ({ kind: k, label: ENTITLEMENT_SPEC[k].label, unit: ENTITLEMENT_SPEC[k].unit, step: ADDON_STEP[k], unitPriceVnd: prices[k]!, ownedUnits: units[k] ?? 0 })),
    addons: ownedAddons(units),
    addonMonthlyVnd: monthly.ok ? monthly.vnd : null,
    addonBlockedReason: probe && "error" in probe ? probe.error : null,
    invoiceInfo: readInvoiceInfo(sub?.invoiceInfo),
  };
}

/**
 * Khoản tiền THUÊ BAO (không phải tiền nạp Số dư AI): kết quả không thuộc nhóm TOPUP_* và mã không phải `ERPNAP…`. Tiền nạp có
 * màn riêng (/platform/ai-balance) — để chung danh sách «Tiền chưa khớp» là để người vận hành dùng nhầm một khoản nạp xác nhận
 * tay một hoá đơn thuê bao, tức một khoản tiền dùng hai lần (review 08/10/2026, M1).
 */
function notTopupPayment(pay: typeof schema.platformBillingPayments) {
  return and(notInArray(pay.outcome, [...TOPUP_PAYMENT_OUTCOMES]), notLike(pay.transferCode, `${TOPUP_CODE_PREFIX}%`));
}

export type PaymentView = { id: string; bankRef: string; txnAt: string; amountVnd: number; description: string; transferCode: string; orgCode: string | null; outcome: PaymentOutcome; resolvedAt: string | null; resolvedByEmail: string | null; resolvedNote: string | null };

function paymentView(r: typeof schema.platformBillingPayments.$inferSelect): PaymentView {
  return { id: r.id, bankRef: r.bankRef, txnAt: r.txnAt.toISOString(), amountVnd: r.amountVnd, description: r.description, transferCode: r.transferCode, orgCode: r.orgCode, outcome: r.outcome as PaymentOutcome, resolvedAt: r.resolvedAt?.toISOString() ?? null, resolvedByEmail: r.resolvedByEmail, resolvedNote: r.resolvedNote };
}

/** `addonMonthlyVnd`: tiền tháng của phần mua thêm theo giá gói hiện tại — `null` = gói không còn khai giá cho phần đang có. */
export type OrgBillingRow = { code: string; name: string; status: string; planKey: string; planName: string; priceVnd: number | null; addonMonthlyVnd: number | null; addonsLabel: string | null; standing: BillingStanding };

export type PlatformBilling = {
  today: string;
  receiver: BillingReceiverView | null;
  /** `commercial` = phần thương mại đã đọc (0222, `lib/pricing/catalog.ts`) — khung sửa gói ở /platform. */
  plans: { key: string; name: string; description: string | null; priceVnd: number | null; position: number; addonPrices: AddonPrices; yearlyFreeMonths: number; commercial: PlanCommercial }[];
  orgs: OrgBillingRow[];
  /**
   * Doanh thu định kỳ hằng tháng: tổng giá THÁNG (gói + phần mua thêm) ở các tổ chức đang thu phí và chưa bị khoá. Tổ chức
   * ACTIVE thôi. Phần mua thêm mà gói không còn khai giá KHÔNG được cộng (không đoán giá) — `addonUnpriced` đếm số tổ chức đó.
   */
  mrrVnd: number;
  addonUnpriced: number;
  /** Hoá đơn ĐÃ THU mà khách yêu cầu hoá đơn VAT và chưa ghi số hoá đơn đã xuất. */
  vatPending: InvoiceView[];
  countByStanding: Record<BillingStandingKind, number>;
  openInvoices: InvoiceView[];
  unresolvedPayments: PaymentView[];
  /** Tiền mang mã thuê bao mà dòng KHÔNG do SePay tạo vào đúng tài khoản nhận (60 ngày) — máy không tự gia hạn. */
  unconfirmedPayments: UnconfirmedPaymentView[];
  recentPaid: InvoiceView[];
};

/**
 * Một khoản tiền mang mã thuê bao CHƯA đủ căn cứ để máy tự gia hạn: `NOT_SEPAY` = sao kê nhập tệp / gõ tay; `OTHER_ACCOUNT` =
 * SePay ghi nhưng vào tài khoản khác tài khoản nhận. `invoice` = hoá đơn mang mã ấy (mọi trạng thái), để người vận hành xác nhận
 * đúng hoá đơn với tham chiếu = mã bút toán — xác nhận xong dòng rời danh sách.
 */
export type UnconfirmedPaymentView = {
  bankRef: string;
  txnAt: string;
  amountVnd: number;
  description: string;
  source: string;
  reason: "NOT_SEPAY" | "OTHER_ACCOUNT" | "NO_RECEIVER";
  /** Dòng sao kê / gõ tay mà SePay XÁC NHẬN SAU (điền mã giao dịch vào dòng có sẵn) — căn cứ mạnh nhất để người vận hành xác nhận. */
  sepayConfirmedLater: boolean;
  /** 4 số cuối tài khoản tiền vào (đã che) — người vận hành biết tiền vào TÀI KHOẢN NÀO trước khi xác nhận; `""` = sổ không ghi. */
  accountTail: string;
  invoice: { id: string; transferCode: string; orgCode: string; status: string; amountVnd: number; label: string } | null;
};

export async function loadPlatformBilling(user: SessionUser, now: Date = new Date()): Promise<PlatformBilling | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const today = vnDate(now);
  const [plans, orgs, receiver, catalog, book] = await Promise.all([listPlans(), listOrganizations(), getBillingReceiver(), catalogPlans(now), loadPriceBook()]);
  const pdb = await getPlatformDb();
  const subRows = await pdb.select().from(schema.platformSubscriptions);
  const subs = new Map(subRows.map((s) => [s.orgCode, { billingEnabled: s.billingEnabled, paidThrough: s.paidThrough ?? null, graceDays: s.graceDays } satisfies SubscriptionTerms]));
  const addonsByOrg = new Map(subRows.map((s) => [s.orgCode, parseAddonUnits(s.addons)]));
  const countByStanding: Record<BillingStandingKind, number> = { NOT_BILLED: 0, ACTIVE: 0, DUE_SOON: 0, OVERDUE: 0, LOCKED: 0 };
  let mrr = 0;
  let addonUnpriced = 0;
  const rows: OrgBillingRow[] = [];
  for (const o of orgs) {
    if (o.isHome || o.status === "SETUP_FAILED" || o.status === "ARCHIVED") continue;
    // Giá của tổ chức theo phiên bản đã ghim (0228) — MRR là số khách THẬT trả, không phải giá niêm yết hôm nay.
    const plan = (await plansForOrg(o.code, now)).find((p) => p.key === planKeyOf(o));
    const standing = billingStanding(subs.get(o.code) ?? null, today);
    const units = addonsByOrg.get(o.code) ?? {};
    const owned = ownedAddons(units);
    const monthly = addonMonthlyVnd(units, parseAddonPrices(plan?.addonPrices));
    countByStanding[standing.kind]++;
    const contribution = mrrContribution({ isHome: o.isHome, orgStatus: o.status, standing: standing.kind, planPriceVnd: plan?.priceVnd ?? null, addonMonthly: monthly });
    mrr += contribution.mrrVnd;
    if (contribution.paying && !monthly.ok) addonUnpriced++;
    rows.push({
      code: o.code,
      name: o.name,
      status: o.status,
      planKey: planKeyOf(o),
      planName: plan?.name ?? planKeyOf(o),
      priceVnd: plan?.priceVnd ?? null,
      addonMonthlyVnd: owned.length === 0 ? 0 : monthly.ok ? monthly.vnd : null,
      addonsLabel: owned.length ? owned.map((a) => `+${a.unitsLabel}`).join(" · ") : null,
      standing,
    });
  }
  const inv = schema.platformInvoices;
  const pay = schema.platformBillingPayments;
  const [openRows, paidRows, payRows, vatRows] = await Promise.all([
    pdb.select().from(inv).where(eq(inv.status, "OPEN")).orderBy(desc(inv.createdAt)).limit(50),
    pdb.select().from(inv).where(eq(inv.status, "PAID")).orderBy(desc(inv.paidAt)).limit(15),
    pdb.select().from(pay).where(and(ne(pay.outcome, "MATCHED"), notTopupPayment(pay), isNull(pay.resolvedAt))).orderBy(desc(pay.txnAt)).limit(50),
    pdb.select().from(inv).where(and(eq(inv.status, "PAID"), isNotNull(inv.invoiceInfo), isNull(inv.vatIssuedAt))).orderBy(inv.paidAt).limit(50),
  ]);
  const unconfirmedPayments = await readUnconfirmedPayments(receiver?.accountNumber ?? null, now, plans);
  return {
    today,
    receiver,
    // Khung «Bảng giá»: gói của bảng giá đang niêm yết (giá theo phiên bản) + gói cũ còn trong `platform_plans` (giá legacy,
    // không bán mới) — sửa giá ở đây = phát hành phiên bản mới.
    plans: [
      ...catalog.plans.map((p) => ({ key: p.key, name: p.name, description: p.description, priceVnd: p.priceVnd, position: p.position, addonPrices: parseAddonPrices(p.addonPrices), yearlyFreeMonths: p.yearlyFreeMonths, commercial: parseCommercial(p.commercial) })),
      ...plans
        .filter((p) => p.key !== HOME_PLAN_KEY && !catalog.plans.some((c) => c.key === p.key))
        .map((p) => {
          const legacy = priceOf(book, null, p.key)?.price ?? null;
          return { key: p.key, name: `${p.name} (giá cũ)`, description: p.description, priceVnd: legacy?.monthlyVnd ?? null, position: p.position, addonPrices: parseAddonPrices(legacy?.addonPrices), yearlyFreeMonths: legacy?.yearlyFreeMonths ?? 0, commercial: parseCommercial(p.commercial) };
        }),
    ],
    orgs: rows,
    mrrVnd: mrr,
    addonUnpriced,
    vatPending: vatRows.map((r) => invoiceView(r, plans)),
    countByStanding,
    openInvoices: openRows.map((r) => invoiceView(r, plans)),
    unresolvedPayments: payRows.map(paymentView),
    unconfirmedPayments,
    recentPaid: paidRows.map((r) => invoiceView(r, plans)),
  };
}

/** Cửa sổ của danh sách «chờ xác nhận nguồn» — dài hơn lượt đối chiếu để khoản cũ chưa ai xử lý vẫn còn thấy. */
const UNCONFIRMED_LOOKBACK_DAYS = 60;

async function readUnconfirmedPayments(receiverAccount: string | null, now: Date, plans: PlanRow[]): Promise<UnconfirmedPaymentView[]> {
  const pdb = await getPlatformDb();
  const bt = schema.bankTransactions;
  const rows = await pdb
    .select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description, provider: bt.provider, providerTxnId: bt.providerTxnId, account: bt.account, source: bt.source })
    .from(bt)
    .where(
      and(
        gt(bt.amount, 0),
        gte(bt.txnAt, new Date(now.getTime() - UNCONFIRMED_LOOKBACK_DAYS * 86_400_000)),
        sql`regexp_replace(upper(${bt.description}), '[^A-Z0-9]', '', 'g') like ${`%${TRANSFER_CODE_PREFIX}%`}`,
        // Chưa ghi ở bảng đối chiếu (dòng SePay đúng tài khoản thì bộ khớp đã ghi) và chưa ai xác nhận tay bằng chính mã bút toán.
        // Câu con tương quan: tên bảng viết tường minh (bộ nhớ drizzle — cột trần trong exists() bị hiểu sai).
        sql`not exists (select 1 from platform_billing_payments p where p.bank_ref = "bank_transactions"."bank_ref")`,
        sql`not exists (select 1 from platform_invoices i where i.paid_ref = "bank_transactions"."bank_ref")`,
      ),
    )
    .orderBy(desc(bt.txnAt))
    .limit(300);
  const pending = rows
    .map((r) => ({ r, codes: extractTransferCodes(r.description), trust: paymentBankRowTrust(r, receiverAccount) }))
    .filter((x) => x.codes.length > 0 && x.trust !== "TRUSTED");
  if (!pending.length) return [];
  const inv = schema.platformInvoices;
  const invoices = await pdb.select().from(inv).where(inArray(inv.transferCode, [...new Set(pending.flatMap((x) => x.codes))]));
  return pending.slice(0, 50).map(({ r, codes, trust }) => {
    const matches = invoices.filter((i) => codes.includes(i.transferCode));
    const i = matches.find((m) => m.status === "OPEN") ?? matches[0] ?? null;
    return {
      bankRef: r.bankRef,
      txnAt: r.txnAt.toISOString(),
      amountVnd: r.amount,
      description: r.description,
      source: r.source,
      reason: trust === "UNCONFIRMED" ? "NOT_SEPAY" : receiverAccount === null ? "NO_RECEIVER" : "OTHER_ACCOUNT",
      accountTail: r.account.replace(/\D/g, "").slice(-4),
      sepayConfirmedLater: trust === "UNCONFIRMED" && r.provider === "SEPAY" && r.providerTxnId.trim() !== "" && !(SEPAY_ROW_SOURCES as readonly string[]).includes(r.source),
      invoice: i ? { id: i.id, transferCode: i.transferCode, orgCode: i.orgCode, status: i.status, amountVnd: i.amountVnd, label: invoiceView(i, plans).label } : null,
    };
  });
}

export type OrgBilling = { today: string; terms: SubscriptionTerms | null; standing: BillingStanding; invoices: InvoiceView[]; payments: PaymentView[]; addons: OwnedAddon[]; invoiceInfo: InvoiceInfo | null };

export async function loadOrgBilling(user: SessionUser, orgCode: string, now: Date = new Date()): Promise<OrgBilling | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const [plans, terms] = await Promise.all([listPlans(), readSubscriptionTerms(orgCode, { fresh: true })]);
  const today = vnDate(now);
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const pay = schema.platformBillingPayments;
  const [rows, payRows, [sub]] = await Promise.all([
    pdb.select().from(inv).where(eq(inv.orgCode, orgCode)).orderBy(desc(inv.createdAt)).limit(24),
    pdb.select().from(pay).where(and(eq(pay.orgCode, orgCode), notTopupPayment(pay))).orderBy(desc(pay.txnAt)).limit(24),
    pdb.select({ addons: schema.platformSubscriptions.addons, invoiceInfo: schema.platformSubscriptions.invoiceInfo }).from(schema.platformSubscriptions).where(eq(schema.platformSubscriptions.orgCode, orgCode)).limit(1),
  ]);
  return {
    today,
    terms,
    standing: billingStanding(terms, today),
    invoices: rows.map((r) => invoiceView(r, plans)),
    payments: payRows.map(paymentView),
    addons: ownedAddons(parseAddonUnits(sub?.addons)),
    invoiceInfo: readInvoiceInfo(sub?.invoiceInfo),
  };
}
