/**
 * ═══════════ SỐ DƯ AI — ĐƯỜNG GHI DUY NHẤT + PHIẾU NẠP QR (docs/saas/AI_BALANCE_V1.md) · CHỈ MÁY CHỦ ═══════════
 *
 *  · SỔ CÁI CHỈ GHI THÊM (`platform_ai_ledger_entries`, CSDL nhà): `postAiLedgerEntry` là đường ghi DUY NHẤT — không có
 *    hàm sửa / xoá dòng nào (`tests/ai-balance.test.ts` quét mã nguồn). Số dư = TỔNG sổ, đọc bằng `readAiBalance`.
 *  · NẠP TIỀN: khách chọn số tiền ⇒ `createAiTopupIntent` tạo phiếu với mã `ERPNAP…` DUY NHẤT nằm sẵn trong VietQR động
 *    (tài khoản nhận = tài khoản thu thuê bao, chủ shop 08/10/2026). Không nhập nội dung tay, không gửi ảnh, không ai duyệt.
 *  · TIỀN VỀ: SePay ghi giao dịch vào sổ ngân hàng của NHÀ (webhook ký HMAC · lượt quét API · sao kê) — `reconcileBillingPayments`
 *    đọc chính sổ ấy và chuyển giao dịch mang mã `ERPNAP…` vào `creditTopupFromBankRow`: MỘT dòng `platform_billing_payments`
 *    (khoá `bank_ref`) + MỘT dòng TOPUP (khoá `topup:<bank_ref>`) trong CÙNG một giao dịch CSDL ⇒ gửi lại 10 lần vẫn cộng một
 *    lần. Cộng NGUYÊN số tiền thật nhận được; lệch số / phiếu đã huỷ vẫn cộng, gắn `TOPUP_CREDITED_REVIEW`.
 *  · CHỈ TIỀN SEPAY ĐÃ XÁC NHẬN (review độc lập 08/10/2026, H1): dòng gõ tay / sao kê nhập chưa được SePay xác nhận KHÔNG tự cộng;
 *    tiền vào tài khoản khác tài khoản nhận, hoặc mang mã của phiếu ĐÃ cộng ⇒ `TOPUP_HELD` (giữ lại, không cộng). Phiếu được
 *    GIÀNH bằng câu UPDATE có điều kiện trong cùng giao dịch ⇒ hai khoản tiền khác mã tham chiếu tới cùng lúc không cộng hai lần.
 *  · TỰ LÀNH: màn khách hỏi trạng thái phiếu ⇒ `reconcileTopupCodes` khớp ĐÚNG mã của phiếu đó — lượt đối chiếu sau phản hồi
 *    webhook có hỏng thì tiền vẫn vào trong vài giây khách đang chờ, không phải chờ người vận hành bấm «Đối chiếu lại».
 *  · Màn khách KHÔNG có token / model / chi phí nhà cung cấp — chỉ số tiền và nhãn dễ hiểu.
 */
import { randomInt, randomUUID } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNull, like, lt, ne, or, sql } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { can, type SessionUser } from "@/lib/auth/session";
import {
  AI_LEDGER_LABEL,
  LOW_BALANCE_DEFAULT_VND,
  TOPUP_CODE_PREFIX,
  TOPUP_INTENT_TTL_MINUTES,
  TOPUP_PENDING_MAX,
  TOPUP_PRESETS_VND,
  TOPUP_STATUS_LABEL,
  balanceForecast,
  extractTopupCodes,
  ledgerEntryProblem,
  makeTopupCode,
  parseTopupAmount,
  parseVndInteger,
  topupBankRowTrust,
  topupOutcome,
  type AiBalancePeriod,
  type AiFundsClass,
  type AiLedgerEntryType,
  type AiLedgerSource,
  type BalanceForecast,
  type TopupIntentStatus,
} from "@/lib/billing/ai-balance-rules";
import { getBillingReceiver, type BillingReceiverView } from "@/lib/billing/receiver";
import { buildVietQrPayload } from "@/lib/payroll/vietqr";
import { KILL_SWITCH_REASON_MIN } from "@/lib/platform/kill-switches";
import { AI_BALANCE_FLAG, readOrgFlag } from "@/lib/platform/org-flags";
import { findOrganization, listOrganizations } from "@/lib/platform/organizations";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { resolveOrgPricing } from "@/lib/pricing/entitlements";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

type PlatformDb = Awaited<ReturnType<typeof getPlatformDb>>;
type Tx = Parameters<Parameters<PlatformDb["transaction"]>[0]>[0];
type Writer = PlatformDb | Tx;

/** Quyền nạp tiền / xem số dư của shop — cùng quyền với trang «Gói & thanh toán». */
const BALANCE_PERMISSION = "settings:manage";

// ─────────────────────────── Số dư ───────────────────────────

export type AiBalance = { cashVnd: number; promoVnd: number; totalVnd: number };

/** Số dư = TỔNG sổ cái theo lớp tiền (dựng lại từ sổ mỗi lần đọc — không có cột số dư để lệch). */
export async function readAiBalance(orgCode: string, db?: Writer): Promise<AiBalance> {
  const d = db ?? (await getPlatformDb());
  const e = schema.platformAiLedgerEntries;
  const rows = await d
    .select({ cls: e.fundsClass, n: sql<string>`coalesce(sum(${e.amountVnd}), 0)::bigint` })
    .from(e)
    .where(eq(e.orgCode, orgCode))
    .groupBy(e.fundsClass);
  const of = (c: AiFundsClass) => Number(rows.find((r) => r.cls === c)?.n ?? 0);
  const cashVnd = of("CASH");
  const promoVnd = of("PROMO");
  return { cashVnd, promoVnd, totalVnd: cashVnd + promoVnd };
}

/** Số dư AI có mở cho tổ chức này không (cờ canary `ai_balance.enabled`, người vận hành bật). */
export async function aiBalanceEnabled(orgCode: string): Promise<boolean> {
  return (await readOrgFlag(orgCode, AI_BALANCE_FLAG))?.enabled === true;
}

// ─────────────────────────── Đường ghi DUY NHẤT của sổ cái ───────────────────────────

export type LedgerPost = {
  orgCode: string;
  entryType: AiLedgerEntryType;
  fundsClass: AiFundsClass;
  amountVnd: number;
  /** Khoá chống trùng — CÙNG một sự việc luôn ra cùng một khoá (vd `topup:<bank_ref>`). */
  idempotencyKey: string;
  sourceType: AiLedgerSource;
  sourceRef?: string | null;
  priceVersionKey?: string | null;
  unitPriceVnd?: number | null;
  units?: number | null;
  note?: string | null;
  actor?: { userId: string | null; email: string | null } | null;
  occurredAt?: Date;
};

/**
 * Ghi MỘT dòng sổ. Cùng khoá chống trùng ⇒ trả dòng đã có (`created: false`), không ghi lần hai. Cùng khoá mà KHÁC tổ chức
 * hoặc khác số tiền ⇒ ném: đó là lỗi khoá không đủ riêng, nuốt im lặng là để tiền lệch mà không ai biết.
 */
export async function postAiLedgerEntry(db: Writer, p: LedgerPost): Promise<{ created: boolean; id: string }> {
  const problem = ledgerEntryProblem(p);
  if (problem) throw new Error(`Dòng sổ Số dư AI không hợp lệ: ${problem}`);
  const key = p.idempotencyKey.trim();
  if (!key || key.length > 200) throw new Error("Dòng sổ Số dư AI thiếu khoá chống trùng");
  const e = schema.platformAiLedgerEntries;
  const ins = await db
    .insert(e)
    .values({
      id: randomUUID(),
      orgCode: p.orgCode,
      entryType: p.entryType,
      fundsClass: p.fundsClass,
      amountVnd: p.amountVnd,
      idempotencyKey: key,
      sourceType: p.sourceType,
      sourceRef: p.sourceRef ?? null,
      priceVersionKey: p.priceVersionKey ?? null,
      unitPriceVnd: p.unitPriceVnd ?? null,
      units: p.units ?? null,
      note: p.note ? p.note.slice(0, 500) : null,
      actorUserId: p.actor?.userId ?? null,
      actorEmail: p.actor?.email ?? null,
      occurredAt: p.occurredAt ?? new Date(),
    })
    .onConflictDoNothing({ target: e.idempotencyKey })
    .returning({ id: e.id });
  if (ins.length) return { created: true, id: ins[0].id };
  const [prev] = await db.select({ id: e.id, orgCode: e.orgCode, amountVnd: e.amountVnd }).from(e).where(eq(e.idempotencyKey, key)).limit(1);
  if (!prev || prev.orgCode !== p.orgCode || prev.amountVnd !== p.amountVnd) throw new Error("Khoá chống trùng của sổ Số dư AI đã dùng cho một dòng khác");
  return { created: false, id: prev.id };
}

// ─────────────────────────── Phiếu nạp ───────────────────────────

export type TopupIntentView = {
  id: string;
  referenceCode: string;
  amountVnd: number;
  status: TopupIntentStatus;
  statusLabel: string;
  expiresAt: string;
  /** Chuỗi VietQR động (EMVCo) — màn khách vẽ thành ảnh QR; có sẵn số tiền + mã chuyển khoản. */
  qrPayload: string;
  receiver: { bankName: string; accountNumber: string; accountName: string };
};
export type TopupResult = { ok: true; intent: TopupIntentView } | { error: string };

type IntentRow = typeof schema.platformPaymentIntents.$inferSelect;

/** `EXPIRED` chỉ là nhãn hiển thị cho phiếu chờ đã quá hạn — tiền tới muộn vẫn được cộng. */
function displayStatus(row: Pick<IntentRow, "status" | "expiresAt">, now: Date): TopupIntentStatus {
  const s = row.status as TopupIntentStatus;
  return s === "PENDING" && row.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : s;
}

function intentView(row: Pick<IntentRow, "id" | "referenceCode" | "amountVnd" | "status" | "expiresAt">, receiver: BillingReceiverView, now: Date): TopupIntentView | null {
  const qr = buildVietQrPayload({ bin: receiver.bin, accountNumber: receiver.accountNumber, amount: row.amountVnd, note: row.referenceCode });
  if (!qr.ok) return null;
  const status = displayStatus(row, now);
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    amountVnd: row.amountVnd,
    status,
    statusLabel: TOPUP_STATUS_LABEL[status],
    expiresAt: row.expiresAt.toISOString(),
    qrPayload: qr.payload,
    receiver: { bankName: receiver.bankName, accountNumber: receiver.accountNumber, accountName: receiver.accountName },
  };
}

/** Khách tạo MỘT phiếu nạp. Chặn khi: không có quyền · cờ chưa bật · số tiền sai · nền tảng chưa khai tài khoản nhận tiền. */
export async function createAiTopupIntent(user: SessionUser, raw: { amountVnd?: unknown }, now: Date = new Date()): Promise<TopupResult> {
  const org = user.organization;
  if (!org) return { error: "Phiên không mang tổ chức." };
  if (!can(user, BALANCE_PERMISSION)) return { error: "Bạn không có quyền nạp tiền cho shop (cần quyền quản trị cài đặt)." };
  if (!(await aiBalanceEnabled(org.code))) return { error: "Số dư AI chưa mở cho shop này." };
  const amount = parseTopupAmount(raw.amountVnd);
  if (!amount.ok) return { error: amount.error };
  const receiver = await getBillingReceiver();
  if (!receiver) return { error: "Chưa mở nạp tiền: nền tảng chưa khai tài khoản nhận tiền. Vui lòng liên hệ đội hỗ trợ." };
  // Quyết định chủ shop #2 (08/10/2026): Số dư AI chỉ dùng cho gói TRẢ PHÍ — đang dùng thử thì chọn gói trước, không nhận tiền trước.
  const orgRow = await findOrganization(org.code);
  const price = orgRow ? ((await resolveOrgPricing(orgRow)).plan?.planPrice ?? null) : null;
  if (!orgRow || orgRow.status !== "ACTIVE" || !price || price.trialDays !== null) return { error: "Số dư AI dùng cho gói trả phí — chọn gói ở «Gói & thanh toán» trước khi nạp." };
  const pdb = await getPlatformDb();
  const t = schema.platformPaymentIntents;
  const [open] = await pdb
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.orgCode, org.code), eq(t.status, "PENDING"), gt(t.expiresAt, now)));
  if (Number(open?.n ?? 0) >= TOPUP_PENDING_MAX) return { error: `Đang có ${TOPUP_PENDING_MAX} mã nạp chờ chuyển khoản — dùng mã đang chờ, hoặc đợi mã hết hạn (${TOPUP_INTENT_TTL_MINUTES} phút).` };
  const expiresAt = new Date(now.getTime() + TOPUP_INTENT_TTL_MINUTES * 60_000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const referenceCode = makeTopupCode(Array.from({ length: 6 }, () => randomInt(0, 32)));
    const ins = await pdb
      .insert(t)
      .values({ id: randomUUID(), orgCode: org.code, amountVnd: amount.amountVnd, referenceCode, expiresAt, createdByUserId: user.id, createdByEmail: user.email })
      .onConflictDoNothing({ target: t.referenceCode })
      .returning();
    if (!ins.length) continue;
    const view = intentView(ins[0], receiver, now);
    if (!view) return { error: "Tài khoản nhận tiền của nền tảng không hợp lệ cho VietQR — liên hệ đội hỗ trợ." };
    return { ok: true, intent: view };
  }
  return { error: "Không tạo được mã nạp tiền — thử lại." };
}

export type TopupStatusResult = { ok: true; status: TopupIntentStatus; statusLabel: string; paidAmountVnd: number | null; balanceVnd: number } | { error: string };

/** Màn khách hỏi trạng thái phiếu (mỗi vài giây khi đang hiện mã QR). Chỉ đọc được phiếu của CHÍNH tổ chức trong phiên. */
export async function aiTopupStatus(user: SessionUser, intentId: unknown, now: Date = new Date()): Promise<TopupStatusResult> {
  const org = user.organization;
  if (!org) return { error: "Phiên không mang tổ chức." };
  if (!can(user, BALANCE_PERMISSION)) return { error: "Bạn không có quyền xem số dư của shop." };
  if (typeof intentId !== "string" || !intentId) return { error: "Thiếu mã phiếu nạp." };
  const pdb = await getPlatformDb();
  const t = schema.platformPaymentIntents;
  const read = async () => (await pdb.select().from(t).where(and(eq(t.id, intentId), eq(t.orgCode, org.code))).limit(1))[0] ?? null;
  let row = await read();
  if (!row) return { error: "Không có phiếu nạp này." };
  if (row.status === "PENDING") {
    // Tự lành: lượt đối chiếu sau phản hồi webhook có hỏng thì khách đang chờ vẫn được cộng tiền — chỉ khớp ĐÚNG mã của phiếu.
    await reconcileTopupCodes([row.referenceCode], now).catch(() => 0);
    row = (await read()) ?? row;
  }
  const status = displayStatus(row, now);
  const balance = await readAiBalance(org.code);
  return { ok: true, status, statusLabel: TOPUP_STATUS_LABEL[status], paidAmountVnd: row.paidAmountVnd, balanceVnd: balance.totalVnd };
}

// ─────────────────────────── Tiền về ───────────────────────────

/** Một dòng sổ ngân hàng của nhà — kèm DẤU XÁC NHẬN của SePay (`provider` · `providerTxnId`) và tài khoản phát sinh. */
export type BankRow = { bankRef: string; txnAt: Date; amount: number; description: string; provider: string; providerTxnId: string; account: string };
export type TopupCreditOutcome = "TOPUP_CREDITED" | "TOPUP_CREDITED_REVIEW" | "TOPUP_HELD" | "NO_INVOICE";

/**
 * MỘT giao dịch ngân hàng mang mã `ERPNAP…` ⇒ MỘT dòng `platform_billing_payments` + (khi được cộng) MỘT dòng TOPUP, cùng một
 * giao dịch CSDL. `null` = không ghi gì: giao dịch đã xử lý từ trước (khoá `bank_ref`) HOẶC SePay chưa xác nhận dòng này
 * (`topupBankRowTrust` = UNCONFIRMED — lượt sau xác nhận thì cộng). Mã không thuộc phiếu nào ⇒ `NO_INVOICE`: tiền nằm ở danh
 * sách người vận hành, không cộng cho ai. Phiếu đã cộng / tài khoản khác ⇒ `TOPUP_HELD`: ghi lại, KHÔNG cộng.
 */
export async function creditTopupFromBankRow(row: BankRow, codes: readonly string[], now: Date = new Date()): Promise<TopupCreditOutcome | null> {
  if (!codes.length || !(row.amount > 0)) return null;
  const trust = topupBankRowTrust(row, (await getBillingReceiver())?.accountNumber ?? null);
  if (trust === "UNCONFIRMED") return null;
  const pdb = await getPlatformDb();
  const t = schema.platformPaymentIntents;
  const candidates = await pdb.select().from(t).where(inArray(t.referenceCode, [...codes]));
  const intent = candidates.find((c) => c.status !== "PAID") ?? candidates[0] ?? null;
  const judged = topupOutcome(intent ? { status: intent.status as TopupIntentStatus, amountVnd: intent.amountVnd } : null, row.amount);
  const outcome: TopupCreditOutcome = judged === "NO_INTENT" ? "NO_INVOICE" : trust === "OTHER_ACCOUNT" ? "TOPUP_HELD" : judged;
  return pdb.transaction(async (tx) => {
    const bp = schema.platformBillingPayments;
    const ins = await tx
      .insert(bp)
      .values({ bankRef: row.bankRef, txnAt: row.txnAt, amountVnd: row.amount, description: row.description.slice(0, 500), transferCode: intent?.referenceCode ?? codes[0], paymentIntentId: intent?.id ?? null, orgCode: intent?.orgCode ?? null, outcome })
      .onConflictDoNothing({ target: bp.bankRef })
      .returning({ id: bp.id });
    if (!ins.length) return null;
    if (!intent || outcome === "NO_INVOICE" || outcome === "TOPUP_HELD") return outcome;
    // GIÀNH PHIẾU: chỉ MỘT khoản tiền biến phiếu chưa trả thành PAID. Khoản thứ hai tới cùng lúc (khác mã tham chiếu) chờ khoá
    // dòng, đọc lại điều kiện, thấy PAID ⇒ 0 dòng ⇒ giữ lại «cần xem lại», không cộng lần hai.
    const claimed = await tx
      .update(t)
      .set({ status: "PAID", paidAt: row.txnAt, paidAmountVnd: row.amount, bankRef: row.bankRef, updatedAt: now })
      .where(and(eq(t.id, intent.id), ne(t.status, "PAID")))
      .returning({ id: t.id });
    if (!claimed.length) {
      await tx.update(bp).set({ outcome: "TOPUP_HELD" }).where(eq(bp.id, ins[0].id));
      return "TOPUP_HELD";
    }
    const entry = await postAiLedgerEntry(tx, {
      orgCode: intent.orgCode,
      entryType: "TOPUP",
      fundsClass: "CASH",
      amountVnd: row.amount,
      idempotencyKey: `topup:${row.bankRef}`,
      sourceType: "BANK_PAYMENT",
      sourceRef: row.bankRef,
      note: `Nạp qua mã ${intent.referenceCode}`,
      occurredAt: row.txnAt,
    });
    await tx.update(t).set({ ledgerEntryId: entry.id }).where(eq(t.id, intent.id));
    return outcome;
  });
}

/** Số ngày lùi lại khi khớp riêng mã phiếu nạp (lượt tự lành từ màn khách). */
const TOPUP_RECONCILE_LOOKBACK_DAYS = 3;

/** Khớp riêng các mã phiếu nạp cho sẵn (lượt tự lành) — cùng hàm cộng tiền với `reconcileBillingPayments`. Trả số giao dịch đã xử lý. */
export async function reconcileTopupCodes(codes: readonly string[], now: Date = new Date()): Promise<number> {
  const wanted = codes.filter((c) => c.startsWith(TOPUP_CODE_PREFIX));
  if (!wanted.length) return 0;
  const pdb = await getPlatformDb();
  const bt = schema.bankTransactions;
  const since = new Date(now.getTime() - TOPUP_RECONCILE_LOOKBACK_DAYS * 86_400_000);
  const rows = await pdb
    .select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description, provider: bt.provider, providerTxnId: bt.providerTxnId, account: bt.account })
    .from(bt)
    .where(
      and(
        gt(bt.amount, 0),
        gte(bt.txnAt, since),
        or(...wanted.map((c) => sql`regexp_replace(upper(${bt.description}), '[^A-Z0-9]', '', 'g') like ${`%${c}%`}`)),
        // Câu con tương quan: tên bảng viết tường minh (bộ nhớ drizzle — `${bt.bankRef}` trong exists() in ra cột trần).
        sql`not exists (select 1 from platform_billing_payments p where p.bank_ref = "bank_transactions"."bank_ref")`,
      ),
    )
    .orderBy(bt.txnAt);
  let n = 0;
  for (const row of rows) {
    const found = extractTopupCodes(row.description);
    if (found.length && (await creditTopupFromBankRow(row, found, now)) !== null) n++;
  }
  return n;
}

// ─────────────────────────── Khách tự khai ngưỡng báo số dư thấp ───────────────────────────

export async function setLowBalanceThreshold(user: SessionUser, raw: { amountVnd?: unknown }): Promise<{ ok: true; message: string } | { error: string }> {
  const org = user.organization;
  if (!org) return { error: "Phiên không mang tổ chức." };
  if (!can(user, BALANCE_PERMISSION)) return { error: "Bạn không có quyền đổi cài đặt số dư." };
  if (!(await aiBalanceEnabled(org.code))) return { error: "Số dư AI chưa mở cho shop này." };
  // Dấu chấm / phẩy / khoảng trắng / «đ» là cách gõ tiền; dấu trừ thì KHÔNG được lặng lẽ bỏ đi («-1» không phải 1đ).
  const rawText = typeof raw.amountVnd === "string" ? raw.amountVnd.trim() : raw.amountVnd;
  if (typeof rawText === "string" && /-/.test(rawText)) return { error: "Ngưỡng cảnh báo phải là số tiền từ 0 tới 100.000.000đ." };
  const text = typeof rawText === "string" ? rawText.replace(/[.,\sđ₫]/gi, "") : rawText;
  const value = text === "" || text === null || text === undefined ? null : Number(text);
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100_000_000)) return { error: "Ngưỡng cảnh báo phải là số tiền từ 0 tới 100.000.000đ." };
  const pdb = await getPlatformDb();
  const a = schema.platformAiAccounts;
  const now = new Date();
  await pdb.insert(a).values({ orgCode: org.code, lowBalanceVnd: value }).onConflictDoUpdate({ target: a.orgCode, set: { lowBalanceVnd: value, updatedAt: now } });
  return { ok: true, message: value === null ? `Dùng ngưỡng mặc định ${LOW_BALANCE_DEFAULT_VND.toLocaleString("vi-VN")}đ.` : `Sẽ báo khi số dư dưới ${value.toLocaleString("vi-VN")}đ.` };
}

// ─────────────────────────── Người vận hành: tặng / điều chỉnh / hoàn ───────────────────────────

export const AI_BALANCE_ADJUST_KINDS = ["PROMO_CREDIT", "ADJUST_CASH", "ADJUST_PROMO", "REFUND", "REVERSE_USAGE"] as const;
export type AiBalanceAdjustKind = (typeof AI_BALANCE_ADJUST_KINDS)[number];

/**
 * Người vận hành (tổ chức nhà + `platform:operate`) ghi một dòng tặng / điều chỉnh / hoàn tiền — bắt buộc lý do, dòng sổ và
 * nhật ký nền tảng trong CÙNG một giao dịch. `requestKey` của form chặn bấm hai lần ra hai dòng. Hoàn tiền không vượt số dư
 * TIỀN THẬT đang có (không hoàn từ tiền được tặng).
 */
export async function adjustAiBalance(
  user: SessionUser,
  raw: { orgCode?: unknown; kind?: unknown; amountVnd?: unknown; reason?: unknown; requestKey?: unknown },
): Promise<{ ok: true; message: string } | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const code = typeof raw.orgCode === "string" ? raw.orgCode.trim() : "";
  if (!ORGANIZATION_CODE_PATTERN.test(code)) return { error: "Mã tổ chức không hợp lệ." };
  const org = await findOrganization(code);
  if (!org) return { error: `Không có tổ chức mã «${code}».` };
  if (!(AI_BALANCE_ADJUST_KINDS as readonly string[]).includes(String(raw.kind))) return { error: "Chọn loại: tặng · điều chỉnh tiền thật · điều chỉnh tiền tặng · hoàn tiền · đảo khoản trừ AI." };
  const kind = raw.kind as AiBalanceAdjustKind;
  const amount = parseVndInteger(raw.amountVnd);
  if (amount === null || amount === 0) return { error: "Số tiền phải là số nguyên VND khác 0 (vd 500.000) — không có phần lẻ." };
  if ((kind === "PROMO_CREDIT" || kind === "REFUND" || kind === "REVERSE_USAGE") && amount < 0) return { error: "Tặng / hoàn tiền / đảo khoản trừ nhập số DƯƠNG — muốn bớt tiền tặng thì chọn «điều chỉnh tiền tặng»." };
  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 500) : "";
  if (reason.length < KILL_SWITCH_REASON_MIN) return { error: `Ghi lý do (ít nhất ${KILL_SWITCH_REASON_MIN} ký tự) — nó vào sổ và nhật ký nền tảng.` };
  const requestKey = typeof raw.requestKey === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(raw.requestKey) ? raw.requestKey : null;
  if (!requestKey) return { error: "Thiếu mã lượt gửi — tải lại trang rồi thử lại." };
  // Đảo khoản trừ AI oan (review #648 M3): ADJUSTMENT tiền thật mang nguồn AI_CUSTOMER — trả lại tiền vào số dư VÀ trừ khỏi
  // doanh thu (`aiBalanceRevenueVnd`). «Điều chỉnh tiền thật» thường (nguồn OPERATOR) là tiền khách đưa ngoài QR — không đụng
  // doanh thu. Hai việc khác nhau thì hai loại dòng, không đoán từ lý do.
  const entry: Pick<LedgerPost, "entryType" | "fundsClass" | "amountVnd" | "sourceType"> =
    kind === "PROMO_CREDIT"
      ? { entryType: "PROMO_CREDIT", fundsClass: "PROMO", amountVnd: amount, sourceType: "OPERATOR" }
      : kind === "REFUND"
        ? { entryType: "REFUND", fundsClass: "CASH", amountVnd: -amount, sourceType: "OPERATOR" }
        : kind === "REVERSE_USAGE"
          ? { entryType: "ADJUSTMENT", fundsClass: "CASH", amountVnd: amount, sourceType: "AI_CUSTOMER" }
          : { entryType: "ADJUSTMENT", fundsClass: kind === "ADJUST_CASH" ? "CASH" : "PROMO", amountVnd: amount, sourceType: "OPERATOR" };
  const actor = { orgCode: user.organization!.code, userId: user.id, email: user.email };
  const pdb = await getPlatformDb();
  try {
    const out = await pdb.transaction(async (tx) => {
      if (entry.entryType === "REFUND") {
        const bal = await readAiBalance(org.code, tx);
        if (bal.cashVnd < Math.abs(entry.amountVnd)) return { error: `Chỉ hoàn được tối đa số tiền thật đang có (${bal.cashVnd.toLocaleString("vi-VN")}đ).` } as const;
      }
      if (kind === "REVERSE_USAGE") {
        // Không đảo nhiều hơn số tiền thật đã từng trừ cho AI (trừ phần đã đảo) — đảo vượt là bịa doanh thu âm.
        const e = schema.platformAiLedgerEntries;
        const [sum] = await tx
          .select({
            charged: sql<string>`coalesce(sum(-${e.amountVnd}) filter (where ${e.entryType} = 'AI_USAGE' and ${e.fundsClass} = 'CASH'), 0)::bigint`,
            reversed: sql<string>`coalesce(sum(${e.amountVnd}) filter (where ${e.entryType} = 'ADJUSTMENT' and ${e.fundsClass} = 'CASH' and ${e.sourceType} = 'AI_CUSTOMER'), 0)::bigint`,
          })
          .from(e)
          .where(eq(e.orgCode, org.code));
        const room = Number(sum?.charged ?? 0) - Number(sum?.reversed ?? 0);
        if (entry.amountVnd > room) return { error: `Chỉ đảo được tối đa số tiền thật đã trừ cho AI mà chưa đảo (${room.toLocaleString("vi-VN")}đ).` } as const;
      }
      const posted = await postAiLedgerEntry(tx, {
        orgCode: org.code,
        ...entry,
        idempotencyKey: `op:${org.code}:${requestKey}`,
        sourceRef: requestKey,
        note: reason,
        actor: { userId: user.id, email: user.email },
      });
      if (!posted.created) return { ok: true, message: "Lượt này đã ghi rồi — không ghi lần hai." } as const;
      await tx.insert(schema.platformAuditLog).values({
        actorOrgCode: actor.orgCode,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        targetOrgCode: org.code,
        action: "AI_BALANCE_ADJUST",
        subject: `ai_balance:${kind}`,
        before: null,
        after: { entryId: posted.id, entryType: entry.entryType, fundsClass: entry.fundsClass, amountVnd: entry.amountVnd },
        reason,
        source: "UI",
      });
      return { ok: true, message: `Đã ghi ${AI_LEDGER_LABEL[entry.entryType].toLowerCase()} ${entry.amountVnd.toLocaleString("vi-VN")}đ cho «${org.name}».` } as const;
    });
    return out;
  } catch (error) {
    return { error: `Không ghi được: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}` };
  }
}

// ─────────────────────────── Màn khách ───────────────────────────

export type AiBalanceHistoryItem = { at: string; label: string; amountVnd: number; detail: string | null };

export type AiBalanceCustomerView = {
  enabled: boolean;
  receiverReady: boolean;
  balanceVnd: number;
  usedThisMonthVnd: number;
  forecast: BalanceForecast;
  lowBalanceVnd: number;
  isLow: boolean;
  presets: readonly number[];
  /** Phiếu chờ còn hạn gần nhất (mở lại trang vẫn thấy mã QR đang chờ). */
  pending: TopupIntentView | null;
  history: AiBalanceHistoryItem[];
};

const VN_OFFSET_MS = 7 * 3_600_000;

/** Đầu tháng (giờ VN) của `now` + số ngày còn lại của tháng, tính cả hôm nay. */
function vnMonthFrame(now: Date): { monthStart: Date; daysLeft: number } {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const y = vn.getUTCFullYear();
  const m = vn.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1) - VN_OFFSET_MS);
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { monthStart, daysLeft: daysInMonth - vn.getUTCDate() + 1 };
}

/** Dữ liệu trang «Số dư AI» của khách — chỉ số tiền + nhãn dễ hiểu; không token / model / chi phí nhà cung cấp. */
export async function loadAiBalanceView(orgCode: string, now: Date = new Date()): Promise<AiBalanceCustomerView> {
  const enabled = await aiBalanceEnabled(orgCode);
  const receiver = await getBillingReceiver();
  const pdb = await getPlatformDb();
  const e = schema.platformAiLedgerEntries;
  const balance = await readAiBalance(orgCode, pdb);
  const { monthStart, daysLeft } = vnMonthFrame(now);
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const [usage] = await pdb
    .select({
      month: sql<string>`coalesce(sum(case when ${e.occurredAt} >= ${monthStart.toISOString()}::timestamptz then -${e.amountVnd} else 0 end), 0)::bigint`,
      week: sql<string>`coalesce(sum(case when ${e.occurredAt} >= ${weekStart.toISOString()}::timestamptz then -${e.amountVnd} else 0 end), 0)::bigint`,
    })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), eq(e.entryType, "AI_USAGE"), gte(e.occurredAt, monthStart < weekStart ? monthStart : weekStart)));
  const usedThisMonthVnd = Number(usage?.month ?? 0);
  const spend7d = Number(usage?.week ?? 0);
  const [acct] = await pdb.select().from(schema.platformAiAccounts).where(eq(schema.platformAiAccounts.orgCode, orgCode)).limit(1);
  const lowBalanceVnd = acct?.lowBalanceVnd ?? LOW_BALANCE_DEFAULT_VND;
  // Lịch sử: dòng tiền vào / ra từng dòng; dùng AI GỘP theo ngày (khách không cần từng lượt gọi).
  const moves = await pdb
    .select({ at: e.occurredAt, type: e.entryType, amount: e.amountVnd, note: e.note })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), sql`${e.entryType} <> 'AI_USAGE'`))
    .orderBy(desc(e.occurredAt))
    .limit(30);
  const daily = await pdb
    .select({ day: sql<string>`to_char(${e.occurredAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`, n: sql<number>`coalesce(sum(coalesce(${e.units}, 1)), 0)::int`, amount: sql<string>`coalesce(sum(${e.amountVnd}), 0)::bigint` })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), eq(e.entryType, "AI_USAGE"), gte(e.occurredAt, new Date(now.getTime() - 60 * 86_400_000))))
    .groupBy(sql`1`)
    .orderBy(desc(sql`1`))
    .limit(30);
  const history: AiBalanceHistoryItem[] = [
    ...moves.map((m) => ({
      at: m.at.toISOString(),
      label: AI_LEDGER_LABEL[m.type as AiLedgerEntryType] ?? "Điều chỉnh",
      amountVnd: m.amount,
      // Lý do của người vận hành là chữ nội bộ — khách chỉ thấy nhãn; dòng nạp tiền hiện mã chuyển khoản của chính khách.
      detail: m.type === "TOPUP" ? m.note : m.type === "AI_USAGE" ? null : "Chốt Đơn điều chỉnh",
    })),
    ...daily.map((d) => ({ at: `${d.day}T12:00:00+07:00`, label: AI_LEDGER_LABEL.AI_USAGE, amountVnd: Number(d.amount), detail: `AI xử lý ${Number(d.n).toLocaleString("vi-VN")} khách` })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let pending: TopupIntentView | null = null;
  if (receiver) {
    const t = schema.platformPaymentIntents;
    const [p] = await pdb
      .select()
      .from(t)
      .where(and(eq(t.orgCode, orgCode), eq(t.status, "PENDING"), gt(t.expiresAt, now)))
      .orderBy(desc(t.createdAt))
      .limit(1);
    if (p) pending = intentView(p, receiver, now);
  }
  return {
    enabled,
    receiverReady: receiver !== null,
    balanceVnd: balance.totalVnd,
    usedThisMonthVnd,
    forecast: balanceForecast({ balanceVnd: balance.totalVnd, spend7dVnd: spend7d, daysToMonthEnd: daysLeft }),
    lowBalanceVnd,
    isLow: balance.totalVnd < lowBalanceVnd,
    presets: TOPUP_PRESETS_VND,
    pending,
    history: history.slice(0, 40),
  };
}

// ─────────────────────────── Màn người vận hành ───────────────────────────

export type AiBalanceOperatorRow = { orgCode: string; orgName: string; enabled: boolean; cashVnd: number; promoVnd: number; totalVnd: number; topup30dVnd: number; usage30dVnd: number; usage30dCashVnd: number; lastTopupAt: string | null };
export type AiBalanceReviewItem = { paymentId: string; bankRef: string; txnAt: string; amountVnd: number; transferCode: string; orgCode: string | null; outcome: string };
/** Tiền vào sổ ngân hàng nhà mang mã nạp nhưng SePay CHƯA xác nhận (gõ tay / sao kê nhập) — không tự cộng; người vận hành xem. */
export type AiBalanceUnconfirmedItem = { bankRef: string; txnAt: string; amountVnd: number; description: string; source: string };
export type AiBalanceOperatorView = { receiverReady: boolean; rows: AiBalanceOperatorRow[]; review: AiBalanceReviewItem[]; unconfirmed: AiBalanceUnconfirmedItem[] };

/** Bảng /platform: số dư từng tổ chức (tiền thật · tiền tặng) + các khoản tiền nạp cần xem lại. Chỉ người vận hành. */
export async function loadAiBalanceOperatorView(user: SessionUser, now: Date = new Date()): Promise<AiBalanceOperatorView | { error: string }> {
  const denial = platformOperatorDenial(user);
  if (denial) return { error: denial };
  const pdb = await getPlatformDb();
  const e = schema.platformAiLedgerEntries;
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const sums = await pdb
    .select({
      orgCode: e.orgCode,
      cash: sql<string>`coalesce(sum(case when ${e.fundsClass} = 'CASH' then ${e.amountVnd} else 0 end), 0)::bigint`,
      promo: sql<string>`coalesce(sum(case when ${e.fundsClass} = 'PROMO' then ${e.amountVnd} else 0 end), 0)::bigint`,
      topup30: sql<string>`coalesce(sum(case when ${e.entryType} = 'TOPUP' and ${e.occurredAt} >= ${since.toISOString()}::timestamptz then ${e.amountVnd} else 0 end), 0)::bigint`,
      usage30: sql<string>`coalesce(sum(case when ${e.entryType} = 'AI_USAGE' and ${e.occurredAt} >= ${since.toISOString()}::timestamptz then -${e.amountVnd} else 0 end), 0)::bigint`,
      usage30Cash: sql<string>`coalesce(sum(case when ${e.entryType} = 'AI_USAGE' and ${e.fundsClass} = 'CASH' and ${e.occurredAt} >= ${since.toISOString()}::timestamptz then -${e.amountVnd} else 0 end), 0)::bigint`,
      lastTopup: sql<Date | string | null>`max(case when ${e.entryType} = 'TOPUP' then ${e.occurredAt} end)`,
    })
    .from(e)
    .groupBy(e.orgCode);
  const byOrg = new Map(sums.map((s) => [s.orgCode, s]));
  const orgs = await listOrganizations();
  const rows: AiBalanceOperatorRow[] = [];
  for (const o of orgs) {
    const enabled = await aiBalanceEnabled(o.code);
    const s = byOrg.get(o.code);
    if (!enabled && !s) continue;
    const cash = Number(s?.cash ?? 0);
    const promo = Number(s?.promo ?? 0);
    const last = s?.lastTopup ? new Date(s.lastTopup) : null;
    rows.push({ orgCode: o.code, orgName: o.name, enabled, cashVnd: cash, promoVnd: promo, totalVnd: cash + promo, topup30dVnd: Number(s?.topup30 ?? 0), usage30dVnd: Number(s?.usage30 ?? 0), usage30dCashVnd: Number(s?.usage30Cash ?? 0), lastTopupAt: last ? last.toISOString() : null });
  }
  const bp = schema.platformBillingPayments;
  const review = await pdb
    .select({ paymentId: bp.id, bankRef: bp.bankRef, txnAt: bp.txnAt, amountVnd: bp.amountVnd, transferCode: bp.transferCode, orgCode: bp.orgCode, outcome: bp.outcome })
    .from(bp)
    .where(and(isNull(bp.resolvedAt), or(inArray(bp.outcome, ["TOPUP_CREDITED_REVIEW", "TOPUP_HELD"]), and(eq(bp.outcome, "NO_INVOICE"), like(bp.transferCode, `${TOPUP_CODE_PREFIX}%`)))))
    .orderBy(desc(bp.txnAt))
    .limit(50);
  const bt = schema.bankTransactions;
  const unconfirmed = await pdb
    .select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amountVnd: bt.amount, description: bt.description, source: bt.source })
    .from(bt)
    .where(
      and(
        gt(bt.amount, 0),
        gte(bt.txnAt, new Date(now.getTime() - 60 * 86_400_000)),
        sql`regexp_replace(upper(${bt.description}), '[^A-Z0-9]', '', 'g') like ${`%${TOPUP_CODE_PREFIX}%`}`,
        or(ne(bt.provider, "SEPAY"), eq(bt.providerTxnId, "")),
        // Câu con tương quan: tên bảng viết tường minh (bộ nhớ drizzle — cột trần trong exists() bị hiểu sai).
        sql`not exists (select 1 from platform_billing_payments p where p.bank_ref = "bank_transactions"."bank_ref")`,
      ),
    )
    .orderBy(desc(bt.txnAt))
    .limit(50);
  return {
    receiverReady: (await getBillingReceiver()) !== null,
    rows: rows.sort((a, b) => b.totalVnd - a.totalVnd),
    review: review.map((r) => ({ ...r, txnAt: r.txnAt.toISOString() })),
    unconfirmed: unconfirmed.map((r) => ({ ...r, txnAt: r.txnAt.toISOString() })),
  };
}

// ─────────────────────────── Kinh tế đơn vị (khung /platform/saas) ───────────────────────────

/**
 * Sổ cái gộp theo tổ chức cho khung doanh thu · chi phí · biên của người vận hành (`lib/pricing/admin.ts`). CHỈ ĐỌC. Dòng
 * trong `[from, to)` tạo số của kỳ; số dư tính mọi dòng TRƯỚC `to` (dòng ghi sau mốc đọc không làm đổi kỳ đang xem). Tổ chức
 * chưa có dòng sổ nào KHÔNG có mặt — khác «có, bằng 0»: chưa từng dùng Số dư AI thì cách tính doanh thu cũ giữ nguyên.
 */
export async function readAiBalancePeriod(from: Date, to: Date): Promise<Map<string, AiBalancePeriod>> {
  const pdb = await getPlatformDb();
  const e = schema.platformAiLedgerEntries;
  const inPeriod = sql`${e.occurredAt} >= ${from.toISOString()}::timestamptz`;
  const rows = await pdb
    .select({
      orgCode: e.orgCode,
      topup: sql<string>`coalesce(sum(${e.amountVnd}) filter (where ${e.entryType} = 'TOPUP' and ${inPeriod}), 0)::bigint`,
      usageCash: sql<string>`coalesce(sum(-${e.amountVnd}) filter (where ${e.entryType} = 'AI_USAGE' and ${e.fundsClass} = 'CASH' and ${inPeriod}), 0)::bigint`,
      usagePromo: sql<string>`coalesce(sum(-${e.amountVnd}) filter (where ${e.entryType} = 'AI_USAGE' and ${e.fundsClass} = 'PROMO' and ${inPeriod}), 0)::bigint`,
      // Đảo khoản trừ oan: ADJUSTMENT tiền thật mang nguồn AI_CUSTOMER (chỉ `REVERSE_USAGE` ghi) — khác điều chỉnh tay (OPERATOR).
      reversalCash: sql<string>`coalesce(sum(${e.amountVnd}) filter (where ${e.entryType} = 'ADJUSTMENT' and ${e.fundsClass} = 'CASH' and ${e.sourceType} = 'AI_CUSTOMER' and ${inPeriod}), 0)::bigint`,
      adjustCash: sql<string>`coalesce(sum(${e.amountVnd}) filter (where ${e.entryType} = 'ADJUSTMENT' and ${e.fundsClass} = 'CASH' and ${e.sourceType} = 'OPERATOR' and ${inPeriod}), 0)::bigint`,
      aiUnits: sql<string>`count(*) filter (where ${e.entryType} = 'AI_USAGE' and ${e.sourceType} = 'AI_CUSTOMER' and ${inPeriod})::bigint`,
      cash: sql<string>`coalesce(sum(${e.amountVnd}) filter (where ${e.fundsClass} = 'CASH'), 0)::bigint`,
      promo: sql<string>`coalesce(sum(${e.amountVnd}) filter (where ${e.fundsClass} = 'PROMO'), 0)::bigint`,
    })
    .from(e)
    .where(lt(e.occurredAt, to))
    .groupBy(e.orgCode);
  return new Map(
    rows.map((r) => [
      r.orgCode,
      {
        topupVnd: Number(r.topup),
        usageCashVnd: Number(r.usageCash),
        usagePromoVnd: Number(r.usagePromo),
        reversalCashVnd: Number(r.reversalCash),
        adjustCashVnd: Number(r.adjustCash),
        aiCustomerUnits: Number(r.aiUnits),
        balanceCashVnd: Number(r.cash),
        balancePromoVnd: Number(r.promo),
      },
    ]),
  );
}

/**
 * SỐ khách AI của MỘT tổ chức đã thu qua Số dư trong `[from, to)` (dòng `aic-charge` — kể cả khoản đã đảo: khách bị trừ oan
 * không bị tính lại ở bảng kê). Hoá đơn ước tính của chính khách đọc hàm này (chỉ tổ chức của PHIÊN). Lỗi ⇒ ném.
 */
export async function readAiCustomerChargedUnits(orgCode: string, from: Date, to: Date): Promise<number> {
  const pdb = await getPlatformDb();
  const e = schema.platformAiLedgerEntries;
  const [r] = await pdb
    .select({ n: sql<number>`count(*)::int` })
    .from(e)
    .where(and(eq(e.orgCode, orgCode), eq(e.entryType, "AI_USAGE"), eq(e.sourceType, "AI_CUSTOMER"), gte(e.occurredAt, from), lt(e.occurredAt, to)));
  return Number(r?.n ?? 0);
}
