import { and, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import {
  BILLING_DEFAULT_GRACE_DAYS,
  BILLING_GRACE_MAX,
  billingStanding,
  countsTowardMrr,
  extractTransferCodes,
  isIsoDate,
  judgePayment,
  quoteRenewal,
  transferCodeFrom,
  vnDate,
  type BillingStanding,
  type BillingStandingKind,
  type PaymentOutcome,
  type PricedPlan,
  type RenewalQuote,
  type SubscriptionTerms,
} from "@/lib/billing/rules";
import { invalidateSubscriptions, readSubscriptionTerms } from "@/lib/billing/standing";
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
};

type InvoiceRow = typeof schema.platformInvoices.$inferSelect;

function invoiceView(r: InvoiceRow, plans: readonly PlanRow[]): InvoiceView {
  return {
    id: r.id,
    orgCode: r.orgCode,
    planKey: r.planKey,
    planName: plans.find((p) => p.key === r.planKey)?.name ?? r.planKey,
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
  };
}

function pricedOf(p: PlanRow | undefined | null): PricedPlan | null {
  return p ? { key: p.key, name: p.name, priceVnd: p.priceVnd } : null;
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
  const terms = await readSubscriptionTerms(org.code, { fresh: true });
  return quoteRenewal({ terms, currentPlan: pricedOf(plans.find((p) => p.key === planKeyOf(org))), target: pricedOf(target)!, months, today: vnDate(now) });
}

/**
 * KHÁCH tạo mã thanh toán cho lần gia hạn. Bấm lại với đúng lựa chọn cũ ⇒ trả lại hoá đơn đang mở (không đẻ mã thứ hai
 * — người ta hay bấm hai lần). Lựa chọn khác ⇒ hoá đơn cũ VOID, mã cũ không còn gia hạn được nữa.
 */
export async function createRenewalInvoice(user: SessionUser, raw: { planKey?: unknown; months?: unknown }, now: Date = new Date()): Promise<{ ok: true; invoiceId: string; message: string } | { error: string }> {
  const org = user.organization;
  if (!org) return { error: "Không xác định được tổ chức của phiên." };
  if (org.isHome) return { error: "Tổ chức nhà không trả phí thuê bao." };
  const planKey = typeof raw.planKey === "string" ? raw.planKey.trim() : "";
  const months = typeof raw.months === "number" ? raw.months : Number(raw.months);
  const q = await previewRenewal(org.code, planKey, months, now);
  if ("error" in q) return q;
  if (!(await getBillingReceiver())) return { error: "Nền tảng chưa khai tài khoản nhận tiền — báo người vận hành nền tảng, chưa tạo được mã thanh toán." };

  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const [open] = await pdb.select().from(inv).where(and(eq(inv.orgCode, org.code), eq(inv.status, "OPEN"))).limit(1);
  if (open && open.planKey === q.planKey && open.months === q.months && open.periodStart === q.periodStart && open.amountVnd === q.amountVnd) {
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
    if (open) await tx.update(inv).set({ status: "VOID", voidReason: `Khách tạo mã mới (${q.months} tháng gói ${q.planKey})`, updatedAt: now }).where(and(eq(inv.id, open.id), eq(inv.status, "OPEN")));
    await tx.insert(inv).values({
      id,
      orgCode: org.code,
      planKey: q.planKey,
      months: q.months,
      periodStart: q.periodStart,
      periodEnd: q.periodEnd,
      listAmountVnd: q.listAmountVnd,
      creditVnd: q.creditVnd,
      amountVnd: q.amountVnd,
      transferCode: code,
      status: "OPEN",
      createdByEmail: user.email,
    });
  });
  return { ok: true, invoiceId: id, message: `Đã tạo mã thanh toán ${code} — ${vnd(q.amountVnd)}.` };
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

export async function setPlanPrice(user: SessionUser, raw: { planKey?: unknown; priceVnd?: unknown; reason?: unknown }): Promise<BillingResult> {
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
  if ((plan.priceVnd ?? null) === price) return { ok: true, message: "Giá không đổi." };
  const home = await getHomeOrganization();
  await pdb.transaction(async (tx) => {
    await tx.update(t).set({ priceVnd: price, updatedAt: new Date() }).where(eq(t.key, planKey));
    await auditTx(tx, { action: "PLAN_PRICE_SET", targetOrgCode: home.code, subject: `plan:${planKey}`, before: { priceVnd: plan.priceVnd }, after: { priceVnd: price }, reason, actor: actorOf(user) });
  });
  return { ok: true, message: price === null ? `Gói «${plan.name}» thôi bán. Hoá đơn đang mở giữ giá cũ.` : `Gói «${plan.name}»: ${vnd(price)}/tháng cho hoá đơn tạo từ bây giờ. Hoá đơn đang mở giữ giá cũ.` };
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

export type PlanOffer = { key: string; name: string; description: string | null; priceVnd: number; limits: unknown };

export type TenantBilling = {
  today: string;
  standing: BillingStanding;
  terms: SubscriptionTerms | null;
  currentPlan: { key: string; name: string; priceVnd: number | null } | null;
  offers: PlanOffer[];
  receiver: BillingReceiverView | null;
  openInvoice: (InvoiceView & { qrPayload: string | null; qrError: string | null }) | null;
  invoices: InvoiceView[];
};

export async function loadTenantBilling(orgCode: string, now: Date = new Date()): Promise<TenantBilling | null> {
  const org = await findOrganization(orgCode);
  if (!org || org.isHome) return null;
  const [plans, terms, receiver] = await Promise.all([listPlans(), readSubscriptionTerms(org.code, { fresh: true }), getBillingReceiver()]);
  const today = vnDate(now);
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const rows = await pdb.select().from(inv).where(eq(inv.orgCode, org.code)).orderBy(desc(inv.createdAt)).limit(24);
  const views = rows.map((r) => invoiceView(r, plans));
  const open = views.find((v) => v.status === "OPEN") ?? null;
  let openInvoice: TenantBilling["openInvoice"] = null;
  if (open) {
    const qr = receiver ? buildVietQrPayload({ bin: receiver.bin, accountNumber: receiver.accountNumber, amount: open.amountVnd, note: open.transferCode }) : null;
    openInvoice = { ...open, qrPayload: qr?.ok ? qr.payload : null, qrError: !receiver ? "Nền tảng chưa khai tài khoản nhận tiền." : qr && !qr.ok ? qr.error : null };
  }
  const current = plans.find((p) => p.key === planKeyOf(org));
  return {
    today,
    standing: billingStanding(terms, today),
    terms,
    currentPlan: current ? { key: current.key, name: current.name, priceVnd: current.priceVnd } : null,
    offers: plans.filter((p) => p.priceVnd !== null && p.key !== HOME_PLAN_KEY).map((p) => ({ key: p.key, name: p.name, description: p.description, priceVnd: p.priceVnd!, limits: p.limits })),
    receiver,
    openInvoice,
    invoices: views.filter((v) => v.status !== "OPEN"),
  };
}

export type PaymentView = { id: string; bankRef: string; txnAt: string; amountVnd: number; description: string; transferCode: string; orgCode: string | null; outcome: PaymentOutcome; resolvedAt: string | null; resolvedByEmail: string | null; resolvedNote: string | null };

function paymentView(r: typeof schema.platformBillingPayments.$inferSelect): PaymentView {
  return { id: r.id, bankRef: r.bankRef, txnAt: r.txnAt.toISOString(), amountVnd: r.amountVnd, description: r.description, transferCode: r.transferCode, orgCode: r.orgCode, outcome: r.outcome as PaymentOutcome, resolvedAt: r.resolvedAt?.toISOString() ?? null, resolvedByEmail: r.resolvedByEmail, resolvedNote: r.resolvedNote };
}

export type OrgBillingRow = { code: string; name: string; status: string; planKey: string; planName: string; priceVnd: number | null; standing: BillingStanding };

export type PlatformBilling = {
  today: string;
  receiver: BillingReceiverView | null;
  plans: { key: string; name: string; priceVnd: number | null; position: number }[];
  orgs: OrgBillingRow[];
  /** Doanh thu định kỳ hằng tháng: tổng giá THÁNG của gói ở các tổ chức đang thu phí và chưa bị khoá. Tổ chức ACTIVE thôi. */
  mrrVnd: number;
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
  const countByStanding: Record<BillingStandingKind, number> = { NOT_BILLED: 0, ACTIVE: 0, DUE_SOON: 0, OVERDUE: 0, LOCKED: 0 };
  let mrr = 0;
  const rows: OrgBillingRow[] = [];
  for (const o of orgs) {
    if (o.isHome || o.status === "SETUP_FAILED" || o.status === "ARCHIVED") continue;
    const plan = plans.find((p) => p.key === planKeyOf(o));
    const standing = billingStanding(subs.get(o.code) ?? null, today);
    countByStanding[standing.kind]++;
    if (o.status === "ACTIVE" && countsTowardMrr(standing.kind) && plan?.priceVnd) mrr += plan.priceVnd;
    rows.push({ code: o.code, name: o.name, status: o.status, planKey: planKeyOf(o), planName: plan?.name ?? planKeyOf(o), priceVnd: plan?.priceVnd ?? null, standing });
  }
  const inv = schema.platformInvoices;
  const pay = schema.platformBillingPayments;
  const [openRows, paidRows, payRows] = await Promise.all([
    pdb.select().from(inv).where(eq(inv.status, "OPEN")).orderBy(desc(inv.createdAt)).limit(50),
    pdb.select().from(inv).where(eq(inv.status, "PAID")).orderBy(desc(inv.paidAt)).limit(15),
    pdb.select().from(pay).where(and(ne(pay.outcome, "MATCHED"), isNull(pay.resolvedAt))).orderBy(desc(pay.txnAt)).limit(50),
  ]);
  return {
    today,
    receiver,
    plans: plans.filter((p) => p.key !== HOME_PLAN_KEY).map((p) => ({ key: p.key, name: p.name, priceVnd: p.priceVnd, position: p.position })),
    orgs: rows,
    mrrVnd: mrr,
    countByStanding,
    openInvoices: openRows.map((r) => invoiceView(r, plans)),
    unresolvedPayments: payRows.map(paymentView),
    recentPaid: paidRows.map((r) => invoiceView(r, plans)),
  };
}

export type OrgBilling = { today: string; terms: SubscriptionTerms | null; standing: BillingStanding; invoices: InvoiceView[]; payments: PaymentView[] };

export async function loadOrgBilling(user: SessionUser, orgCode: string, now: Date = new Date()): Promise<OrgBilling | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const [plans, terms] = await Promise.all([listPlans(), readSubscriptionTerms(orgCode, { fresh: true })]);
  const today = vnDate(now);
  const pdb = await getPlatformDb();
  const inv = schema.platformInvoices;
  const pay = schema.platformBillingPayments;
  const [rows, payRows] = await Promise.all([
    pdb.select().from(inv).where(eq(inv.orgCode, orgCode)).orderBy(desc(inv.createdAt)).limit(24),
    pdb.select().from(pay).where(eq(pay.orgCode, orgCode)).orderBy(desc(pay.txnAt)).limit(24),
  ]);
  return { today, terms, standing: billingStanding(terms, today), invoices: rows.map((r) => invoiceView(r, plans)), payments: payRows.map(paymentView) };
}
