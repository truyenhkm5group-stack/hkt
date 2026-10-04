import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  BILLING_DEFAULT_GRACE_DAYS,
  BILLING_GRACE_MAX,
  billingStanding,
  mrrContribution,
  extractTransferCodes,
  isIsoDate,
  judgePayment,
  quoteRenewal,
  TRIAL_DAYS,
  TRIAL_GRACE_DAYS,
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
import { HOME_PLAN_KEY, listPlans, planKeyOf, type PlanRow } from "@/lib/entitlements/check";
import { buildVietQrPayload, toTransferText } from "@/lib/payroll/vietqr";
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

export const BILLING_RECEIVER_KEY = "platform.billing.receiver";
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

export type BillingReceiver = { bin: string; accountNumber: string; accountName: string };
export type BillingReceiverView = BillingReceiver & { bankName: string };

function parseReceiver(value: unknown): BillingReceiver | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const bin = typeof v.bin === "string" ? v.bin.trim() : "";
  const accountNumber = typeof v.accountNumber === "string" ? v.accountNumber.trim() : "";
  const accountName = typeof v.accountName === "string" ? v.accountName.trim() : "";
  if (!/^\d{6}$/.test(bin) || !/^[0-9A-Za-z]{4,19}$/.test(accountNumber) || !accountName) return null;
  return { bin, accountNumber, accountName };
}

export async function getBillingReceiver(): Promise<BillingReceiverView | null> {
  try {
    const pdb = await getPlatformDb();
    const row = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
    const r = parseReceiver(row?.value);
    return r ? { ...r, bankName: bankNameOf(r.bin) } : null;
  } catch {
    return null;
  }
}

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

function pricedOf(p: PlanRow | undefined | null): PricedPlan | null {
  return p ? { key: p.key, name: p.name, priceVnd: p.priceVnd, yearlyFreeMonths: p.yearlyFreeMonths } : null;
}

function newTransferCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return transferCodeFrom([...bytes]);
}

/** Báo giá (không ghi gì) — để màn hình hiện số tiền trước khi khách bấm tạo mã. */
export async function previewRenewal(orgCode: string, planKey: string, months: number, now: Date = new Date()): Promise<RenewalQuote | { error: string }> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  const plans = await listPlans();
  const target = plans.find((p) => p.key === planKey && p.key !== HOME_PLAN_KEY);
  if (!target) return { error: "Không có gói này." };
  const [terms, units] = await Promise.all([readSubscriptionTerms(org.code, { fresh: true }), readSubscriptionAddons(org.code, { fresh: true })]);
  const current = plans.find((p) => p.key === planKeyOf(org));
  // Phần mua thêm đi theo GIÁ CỦA GÓI ĐÍCH; gói đích không bán một hạng mục đang có ⇒ nói rõ, không đoán giá.
  const targetAddon = addonMonthlyVnd(units, parseAddonPrices(target.addonPrices));
  if (!targetAddon.ok) return { error: missingAddonMessage(target.name, targetAddon.missing) };
  const currentAddon = current ? addonMonthlyVnd(units, parseAddonPrices(current.addonPrices)) : null;
  return quoteRenewal({
    terms,
    currentPlan: pricedOf(current),
    target: pricedOf(target)!,
    months,
    today: vnDate(now),
    targetAddonMonthlyVnd: targetAddon.vnd,
    // Gói hiện tại vừa bị gỡ giá của phần đang có ⇒ phần trừ chỉ tính giá gói — không đoán giá.
    currentAddonMonthlyVnd: currentAddon?.ok ? currentAddon.vnd : 0,
  });
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
    });
  });
  return { ok: true, invoiceId: id, message: `Đã tạo mã thanh toán ${code} — ${vnd(d.amountVnd)}.` };
}

// ─────────────────────────── Mua thêm hạn mức giữa kỳ ───────────────────────────

/** Báo giá mua thêm (không ghi gì). Cùng hàm thuần với lượt tạo mã — hai bước không lệch nhau. */
export async function previewAddon(orgCode: string, raw: { kind?: unknown; blocks?: unknown }, now: Date = new Date()): Promise<AddonQuote | { error: string }> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  const plans = await listPlans();
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
  await auditTx(tx, {
    action: "INVOICE_PAID",
    targetOrgCode: invoice.orgCode,
    subject: `invoice:${invoice.transferCode}`,
    before: { paidThrough: beforeSub?.paidThrough ?? null, billingEnabled: beforeSub?.billingEnabled ?? false, plan: beforeOrg?.plan ?? null },
    after: { paidThrough: invoice.periodEnd, billingEnabled: true, plan: invoice.planKey, amountVnd: paid.amountVnd, source: paid.source, ref: paid.ref },
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

export type ReconcileSummary = { scanned: number; recorded: number; matched: number; unmatched: number; errors: string[] };

/**
 * Đọc sổ ngân hàng của NHÀ, tìm tiền VÀO mang mã `ERPHD…` chưa từng ghi ở `platform_billing_payments`, ghi mỗi khoản ĐÚNG
 * MỘT dòng (khoá `bank_ref`) và gia hạn khi khớp. Chạy lại bao nhiêu lần cũng được: khoản đã ghi bị bỏ qua ngay ở câu lọc,
 * và lượt ghi đua nhau thì `ON CONFLICT DO NOTHING` cho đúng một lượt thắng.
 */
export async function reconcileBillingPayments(opts: { bankRefs?: readonly string[]; lookbackDays?: number; now?: Date } = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date();
  const out: ReconcileSummary = { scanned: 0, recorded: 0, matched: 0, unmatched: 0, errors: [] };
  if (opts.bankRefs && opts.bankRefs.length === 0) return out;
  const pdb = await getPlatformDb();
  const bt = schema.bankTransactions;
  const since = new Date(now.getTime() - (opts.lookbackDays ?? BILLING_RECONCILE_LOOKBACK_DAYS) * 86_400_000);
  const rows = await pdb
    .select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description })
    .from(bt)
    .where(
      and(
        gt(bt.amount, 0),
        gte(bt.txnAt, since),
        sql`regexp_replace(upper(${bt.description}), '[^A-Z0-9]', '', 'g') like '%ERPHD%'`,
        // Câu con tương quan: viết tên bảng tường minh — `${bt.bankRef}` trong exists() in ra cột trần (bộ nhớ drizzle).
        sql`not exists (select 1 from platform_billing_payments p where p.bank_ref = "bank_transactions"."bank_ref")`,
        opts.bankRefs ? inArray(bt.bankRef, [...opts.bankRefs]) : undefined,
      ),
    )
    .orderBy(bt.txnAt);
  const inv = schema.platformInvoices;
  for (const row of rows) {
    out.scanned++;
    const codes = extractTransferCodes(row.description);
    if (codes.length === 0) continue;
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
  return out;
}

/** Nút «Đối chiếu lại tiền thuê bao» của người vận hành. */
export async function reconcileBillingAsOperator(user: SessionUser): Promise<BillingResult> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const r = await reconcileBillingPayments();
  if (r.errors.length) return { error: `Đã ghi ${r.recorded} khoản (${r.matched} khớp); ${r.errors.length} khoản hỏng: ${r.errors.slice(0, 2).join(" · ")}` };
  return { ok: true, message: r.recorded === 0 ? `Không có khoản tiền mới mang mã thanh toán (đã quét ${BILLING_RECONCILE_LOOKBACK_DAYS} ngày).` : `Đã ghi ${r.recorded} khoản: ${r.matched} khớp và gia hạn, ${r.unmatched} cần xem tay.` };
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
  if (before && before.billingEnabled === next.billingEnabled && (before.paidThrough ?? null) === next.paidThrough && before.graceDays === next.graceDays) return { ok: true, message: "Không có gì thay đổi." };
  const now = new Date();
  await pdb.transaction(async (tx) => {
    await tx.insert(subs).values({ orgCode: p.org.code, ...next }).onConflictDoUpdate({ target: subs.orgCode, set: { ...next, updatedAt: now } });
    await auditTx(tx, { action: "BILLING_SET", targetOrgCode: p.org.code, subject: "subscription", before: before ? { billingEnabled: before.billingEnabled, paidThrough: before.paidThrough, graceDays: before.graceDays } : null, after: next, reason: p.reason, actor: p.actor });
  });
  invalidateSubscriptions(p.org.code);
  const st = billingStanding(next, vnDate(now));
  return { ok: true, message: enabled ? `«${p.org.name}»: thu phí BẬT, trả tới ${paidThrough}, ân hạn ${graceRaw} ngày — hiện «${st.kind}».` : `«${p.org.name}»: thu phí TẮT — không nhắc, không khoá.` };
}

/**
 * DÙNG THỬ 14 NGÀY cho cửa hàng TỰ ĐĂNG KÝ (nguồn OPEN của `/start`) — gọi MỘT lần lúc dựng tổ chức mới.
 *
 *  · Chỉ CHÈN khi tổ chức chưa có dòng thuê bao: chạy lại lượt dựng, hoặc người vận hành đã đặt điều khoản riêng ⇒ không
 *    đụng (`onConflictDoNothing`).
 *  · Nền tảng CHƯA khai tài khoản nhận tiền ⇒ KHÔNG bật: khoá một khách không có đường nào để trả tiền là khoá oan. Tổ
 *    chức giữ «Chưa thu phí» như trước bản này; người vận hành bật tay ở /platform/org/<mã> khi đã khai tài khoản.
 *  · Hết hạn đi đúng đường quá hạn → chỉ xem của thuê bao trả tiền; không xoá dữ liệu.
 */
export type TrialStart = { started: true; paidThrough: string } | { started: false; reason: "NOT_TENANT" | "NO_RECEIVER" | "EXISTS" };

export async function startSelfServiceTrial(orgCode: string, now: Date = new Date()): Promise<TrialStart> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return { started: false, reason: "NOT_TENANT" };
  if (!(await getBillingReceiver())) return { started: false, reason: "NO_RECEIVER" };
  const paidThrough = trialPaidThrough(vnDate(now));
  const next = { billingEnabled: true, paidThrough, graceDays: TRIAL_GRACE_DAYS };
  const pdb = await getPlatformDb();
  const subs = schema.platformSubscriptions;
  const started = await pdb.transaction(async (tx) => {
    const rows = await tx
      .insert(subs)
      .values({ orgCode, ...next, note: `Dùng thử ${TRIAL_DAYS} ngày — cửa hàng tự đăng ký` })
      .onConflictDoNothing({ target: subs.orgCode })
      .returning({ orgCode: subs.orgCode });
    if (rows.length === 0) return false;
    await auditTx(tx, { action: "BILLING_SET", targetOrgCode: orgCode, subject: "subscription", before: null, after: next, reason: `Dùng thử ${TRIAL_DAYS} ngày cho cửa hàng tự đăng ký`, actor: null });
    return true;
  });
  invalidateSubscriptions(orgCode);
  return started ? { started: true, paidThrough } : { started: false, reason: "EXISTS" };
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
  const pdb = await getPlatformDb();
  const t = schema.platformPlans;
  const [plan] = await pdb.select().from(t).where(eq(t.key, planKey)).limit(1);
  if (!plan) return { error: `Không có gói «${planKey}».` };
  const free = raw.yearlyFreeMonths === undefined || raw.yearlyFreeMonths === "" ? plan.yearlyFreeMonths : Number(raw.yearlyFreeMonths);
  if (!Number.isInteger(free) || free < 0 || free > YEARLY_FREE_MONTHS_MAX) return { error: `Số tháng tặng khi trả 12 tháng là số nguyên 0–${YEARLY_FREE_MONTHS_MAX}.` };
  if ((plan.priceVnd ?? null) === price && plan.yearlyFreeMonths === free) return { ok: true, message: "Giá không đổi." };
  const home = await getHomeOrganization();
  await pdb.transaction(async (tx) => {
    await tx.update(t).set({ priceVnd: price, yearlyFreeMonths: free, updatedAt: new Date() }).where(eq(t.key, planKey));
    await auditTx(tx, { action: "PLAN_PRICE_SET", targetOrgCode: home.code, subject: `plan:${planKey}`, before: { priceVnd: plan.priceVnd, yearlyFreeMonths: plan.yearlyFreeMonths }, after: { priceVnd: price, yearlyFreeMonths: free }, reason, actor: actorOf(user) });
  });
  const freeText = free > 0 ? ` Trả 12 tháng tặng ${free} tháng.` : "";
  return { ok: true, message: price === null ? `Gói «${plan.name}» thôi bán. Hoá đơn đang mở giữ giá cũ.` : `Gói «${plan.name}»: ${vnd(price)}/tháng cho hoá đơn tạo từ bây giờ.${freeText} Hoá đơn đang mở giữ giá cũ.` };
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
  const pdb = await getPlatformDb();
  const t = schema.platformPlans;
  const [plan] = await pdb.select().from(t).where(eq(t.key, planKey)).limit(1);
  if (!plan) return { error: `Không có gói «${planKey}».` };
  const before = parseAddonPrices(plan.addonPrices);
  if (JSON.stringify(before) === JSON.stringify(next)) return { ok: true, message: "Đơn giá không đổi." };
  const home = await getHomeOrganization();
  await pdb.transaction(async (tx) => {
    await tx.update(t).set({ addonPrices: next, updatedAt: new Date() }).where(eq(t.key, planKey));
    await auditTx(tx, { action: "ADDON_PRICE_SET", targetOrgCode: home.code, subject: `plan:${planKey}`, before, after: next, reason, actor: actorOf(user) });
  });
  const sold = ADDON_KINDS.filter((k) => next[k] !== undefined);
  return { ok: true, message: sold.length ? `Gói «${plan.name}» bán thêm: ${sold.map((k) => `${ENTITLEMENT_SPEC[k].label.toLowerCase()} ${vnd(next[k]!)}`).join(" · ")} (mỗi bước / tháng).` : `Gói «${plan.name}» thôi bán thêm mọi hạng mục.` };
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

export type PlanOffer = { key: string; name: string; description: string | null; priceVnd: number; limits: unknown; yearlyFreeMonths: number };

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

function ownedAddons(units: AddonUnits): OwnedAddon[] {
  return ADDON_KINDS.filter((k) => (units[k] ?? 0) > 0).map((k) => ({ kind: k, label: ENTITLEMENT_SPEC[k].label, units: units[k]!, unitsLabel: addonUnitsLabel(k, units[k]!) }));
}

export async function loadTenantBilling(orgCode: string, now: Date = new Date()): Promise<TenantBilling | null> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return null;
  const [plans, terms, receiver] = await Promise.all([listPlans(), readSubscriptionTerms(org.code, { fresh: true }), getBillingReceiver()]);
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
    offers: plans.filter((p) => p.priceVnd !== null && p.key !== HOME_PLAN_KEY).map((p) => ({ key: p.key, name: p.name, description: p.description, priceVnd: p.priceVnd!, limits: p.limits, yearlyFreeMonths: p.yearlyFreeMonths })),
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

export type PaymentView = { id: string; bankRef: string; txnAt: string; amountVnd: number; description: string; transferCode: string; orgCode: string | null; outcome: PaymentOutcome; resolvedAt: string | null; resolvedByEmail: string | null; resolvedNote: string | null };

function paymentView(r: typeof schema.platformBillingPayments.$inferSelect): PaymentView {
  return { id: r.id, bankRef: r.bankRef, txnAt: r.txnAt.toISOString(), amountVnd: r.amountVnd, description: r.description, transferCode: r.transferCode, orgCode: r.orgCode, outcome: r.outcome as PaymentOutcome, resolvedAt: r.resolvedAt?.toISOString() ?? null, resolvedByEmail: r.resolvedByEmail, resolvedNote: r.resolvedNote };
}

/** `addonMonthlyVnd`: tiền tháng của phần mua thêm theo giá gói hiện tại — `null` = gói không còn khai giá cho phần đang có. */
export type OrgBillingRow = { code: string; name: string; status: string; planKey: string; planName: string; priceVnd: number | null; addonMonthlyVnd: number | null; addonsLabel: string | null; standing: BillingStanding };

export type PlatformBilling = {
  today: string;
  receiver: BillingReceiverView | null;
  plans: { key: string; name: string; priceVnd: number | null; position: number; addonPrices: AddonPrices; yearlyFreeMonths: number }[];
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
  recentPaid: InvoiceView[];
};

export async function loadPlatformBilling(user: SessionUser, now: Date = new Date()): Promise<PlatformBilling | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const today = vnDate(now);
  const [plans, orgs, receiver] = await Promise.all([listPlans(), listOrganizations(), getBillingReceiver()]);
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
    const plan = plans.find((p) => p.key === planKeyOf(o));
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
    pdb.select().from(pay).where(and(ne(pay.outcome, "MATCHED"), isNull(pay.resolvedAt))).orderBy(desc(pay.txnAt)).limit(50),
    pdb.select().from(inv).where(and(eq(inv.status, "PAID"), isNotNull(inv.invoiceInfo), isNull(inv.vatIssuedAt))).orderBy(inv.paidAt).limit(50),
  ]);
  return {
    today,
    receiver,
    plans: plans.filter((p) => p.key !== HOME_PLAN_KEY).map((p) => ({ key: p.key, name: p.name, priceVnd: p.priceVnd, position: p.position, addonPrices: parseAddonPrices(p.addonPrices), yearlyFreeMonths: p.yearlyFreeMonths })),
    orgs: rows,
    mrrVnd: mrr,
    addonUnpriced,
    vatPending: vatRows.map((r) => invoiceView(r, plans)),
    countByStanding,
    openInvoices: openRows.map((r) => invoiceView(r, plans)),
    unresolvedPayments: payRows.map(paymentView),
    recentPaid: paidRows.map((r) => invoiceView(r, plans)),
  };
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
    pdb.select().from(pay).where(eq(pay.orgCode, orgCode)).orderBy(desc(pay.txnAt)).limit(24),
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
