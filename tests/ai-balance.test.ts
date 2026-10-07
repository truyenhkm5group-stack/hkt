/**
 * SỐ DƯ AI + NẠP QR (0235 · docs/saas/AI_BALANCE_V1.md · quyết định chủ shop 08/10/2026).
 *
 *  1. THUẦN — luật dấu của sổ cái (bảng chân lý), mã `ERPNAP…` (ngân hàng đổi chữ / chèn ký tự; không lẫn với `ERPHD…`; ký
 *     tự dễ nhầm không nhận), số tiền nạp, phán quyết tiền về, dự báo số ngày còn lại, nhãn khách không lộ số nội bộ.
 *  2. MÃ NGUỒN — sổ cái chỉ ghi thêm (không chỗ nào sửa / xoá dòng sổ; chỉ một tệp được ghi), webhook đối chiếu khi có mã nạp.
 *  3. VÒNG TIỀN THẬT (PGlite, hai tổ chức riêng): cờ tắt ⇒ không có gì · chỉ người vận hành bật, có lý do + nhật ký · chưa
 *     khai tài khoản nhận ⇒ không mã QR · dùng thử ⇒ không nhận nạp · tối đa 3 mã chờ · tạo phiếu (mã + số tiền nằm sẵn trong
 *     VietQR, hạn 30 phút) · tiền SePay xác nhận ⇒ cộng ĐÚNG một lần dù đối chiếu chạy 10 lần · tự lành khi khách hỏi trạng thái
 *     · lệch số tiền / mã lạ / trả muộn · cô lập tổ chức · khoá chống trùng + ràng buộc dấu ở CSDL · người vận hành tặng / hoàn
 *     (bấm hai lần ra một dòng) · màn khách / màn vận hành · tắt cờ không làm mất tiền.
 *  4. REVIEW ĐỘC LẬP 08/10/2026: dòng gõ tay / sao kê nhập KHÔNG tự cộng — kể cả khi SePay xác nhận cùng mã bút toán SAU đó
 *     (review #650: số tiền / nội dung vẫn của người nhập) · sao kê trùng một khoản đã cộng (khác mã tham chiếu) KHÔNG cộng lần hai · mã của phiếu đã cộng ⇒ GIỮ LẠI,
 *     không cộng · tiền vào tài khoản khác tài khoản nhận ⇒ giữ lại · tiền nạp không lẫn vào «Tiền chưa khớp» của thuê bao và
 *     không được đếm là «khớp và gia hạn» · số tiền có phần lẻ bị từ chối, tặng / hoàn số âm bị từ chối.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { adjustAiBalance, aiTopupStatus, createAiTopupIntent, creditTopupFromBankRow, loadAiBalanceOperatorView, loadAiBalanceView, postAiLedgerEntry, readAiBalance, setLowBalanceThreshold } from "@/lib/billing/ai-balance";
import {
  AI_LEDGER_LABEL,
  balanceForecast,
  extractTopupCodes,
  ledgerEntryProblem,
  makeTopupCode,
  parseTopupAmount,
  parseVndInteger,
  TOPUP_CODE_PATTERN,
  TOPUP_PENDING_MAX,
  topupBankRowTrust,
  TOPUP_MAX_VND,
  TOPUP_MIN_VND,
  topupOutcome,
  type AiFundsClass,
  type AiLedgerEntryType,
} from "@/lib/billing/ai-balance-rules";
import { extractTransferCodes } from "@/lib/billing/rules";
import { BILLING_RECEIVER_KEY, initWorkspaceBilling, loadPlatformBilling, reconcileBillingPayments, setBillingReceiver } from "@/lib/billing/service";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setAiBalanceEnabled } from "@/lib/platform/kill-switches";
import { AI_BALANCE_FLAG, invalidateOrgFlags } from "@/lib/platform/org-flags";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const A = "aib-a";
const B = "aib-b";
const ORGS = [A, B] as const;
const REF = "aib-test-";
const OP_EMAIL = "op@aib.local";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "aib-user", email: "aib@local", name: "AIB", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

const errorOf = (r: object): string => ("error" in r ? String((r as { error: unknown }).error) : "");

// ─────────────────────────── 1 · THUẦN ───────────────────────────

function testPure() {
  const ok = (entryType: AiLedgerEntryType, fundsClass: AiFundsClass, amountVnd: number) => ledgerEntryProblem({ entryType, fundsClass, amountVnd }) === null;
  assert.ok(ok("TOPUP", "CASH", 100) && !ok("TOPUP", "CASH", -100) && !ok("TOPUP", "PROMO", 100), "nạp = tiền thật, dương");
  assert.ok(ok("PROMO_CREDIT", "PROMO", 100) && !ok("PROMO_CREDIT", "CASH", 100) && !ok("PROMO_CREDIT", "PROMO", -1), "tặng = lớp PROMO, dương");
  assert.ok(ok("AI_USAGE", "CASH", -490) && ok("AI_USAGE", "PROMO", -490) && !ok("AI_USAGE", "CASH", 490), "dùng AI = âm");
  assert.ok(ok("REFUND", "CASH", -1_000) && !ok("REFUND", "PROMO", -1_000) && !ok("REFUND", "CASH", 1_000), "hoàn = trả lại tiền thật, âm");
  assert.ok(ok("EXPIRY", "PROMO", -10) && !ok("EXPIRY", "PROMO", 10));
  assert.ok(ok("ADJUSTMENT", "CASH", 5) && ok("ADJUSTMENT", "PROMO", -5) && !ok("ADJUSTMENT", "CASH", 0), "điều chỉnh khác 0");
  assert.ok(!ok("TOPUP", "CASH", 1.5) && !ok("TOPUP", "CASH", 2_000_000_000), "số nguyên, dưới trần một dòng");

  const code = makeTopupCode([0, 1, 2, 3, 4, 31]);
  assert.match(code, TOPUP_CODE_PATTERN);
  assert.deepEqual(extractTopupCodes(`ck erpnap-${code.slice(6).toLowerCase()} cam on shop`), [code], "ngân hàng đổi chữ thường + chèn gạch ⇒ vẫn đọc ra mã");
  assert.deepEqual(extractTopupCodes("Thanh toan ERPHD23ABCD"), [], "mã thuê bao không bị đọc thành mã nạp");
  assert.deepEqual(extractTransferCodes(`NAP ${code}`), [], "mã nạp không bị đọc thành mã thuê bao");
  assert.deepEqual(extractTopupCodes("ERPNAP0O1I23"), [], "ký tự dễ nhầm (0 · O · 1 · I) không thuộc bảng mã");

  assert.deepEqual(parseTopupAmount("1.000.000"), { ok: true, amountVnd: 1_000_000 });
  assert.ok(!parseTopupAmount(TOPUP_MIN_VND - 1).ok && !parseTopupAmount(TOPUP_MAX_VND + 1).ok && !parseTopupAmount("abc").ok && !parseTopupAmount(null).ok);

  assert.equal(topupOutcome({ status: "PENDING", amountVnd: 500_000 }, 500_000), "TOPUP_CREDITED");
  assert.equal(topupOutcome({ status: "PENDING", amountVnd: 500_000 }, 400_000), "TOPUP_CREDITED_REVIEW", "lệch số tiền ⇒ vẫn cộng, cần xem lại");
  assert.equal(topupOutcome({ status: "PAID", amountVnd: 500_000 }, 500_000), "TOPUP_HELD", "mã của phiếu ĐÃ cộng ⇒ giữ lại, KHÔNG cộng (không phân biệt được trả lần hai với cùng khoản vào sổ hai lần)");
  assert.equal(topupOutcome({ status: "CANCELLED", amountVnd: 500_000 }, 500_000), "TOPUP_CREDITED_REVIEW", "phiếu đã huỷ mà tiền vẫn tới ⇒ cộng, cần xem lại");

  // Độ tin của dòng sổ ngân hàng: chỉ dòng SePay xác nhận, vào ĐÚNG tài khoản nhận.
  const sepay = { provider: "SEPAY", providerTxnId: "92001", account: "0123456789", source: "WEBHOOK" };
  assert.equal(topupBankRowTrust(sepay, "0123 456 789"), "TRUSTED");
  assert.equal(topupBankRowTrust({ ...sepay, source: "API" }, "0123456789"), "TRUSTED", "lượt quét API của SePay");
  assert.equal(topupBankRowTrust({ ...sepay, source: "IMPORT" }, "0123456789"), "UNCONFIRMED", "sao kê nhập TRƯỚC rồi SePay điền mã giao dịch SAU — số tiền vẫn do người nhập dựng");
  assert.equal(topupBankRowTrust({ ...sepay, source: "MANUAL" }, "0123456789"), "UNCONFIRMED");
  assert.equal(topupBankRowTrust({ ...sepay, provider: "" }, "0123456789"), "UNCONFIRMED", "dòng gõ tay / sao kê nhập");
  assert.equal(topupBankRowTrust({ ...sepay, providerTxnId: " " }, "0123456789"), "UNCONFIRMED");
  assert.equal(topupBankRowTrust({ ...sepay, account: "9999999999" }, "0123456789"), "OTHER_ACCOUNT", "tiền vào tài khoản khác tài khoản nhận");
  assert.equal(topupBankRowTrust({ ...sepay, account: "" }, "0123456789"), "OTHER_ACCOUNT");
  assert.equal(topupBankRowTrust(sepay, null), "OTHER_ACCOUNT", "chưa khai tài khoản nhận ⇒ không tự cộng");

  // Số tiền gõ tay: phân cách nghìn hợp lệ ⇒ số nguyên; có phần lẻ / chữ ⇒ từ chối (không đọc 1.000.000,5 thành 10.000.005).
  assert.deepEqual(["1.000.000", "1,000,000", "1000000", "-500.000", " 2.000.000 đ", 750_000].map(parseVndInteger), [1_000_000, 1_000_000, 1_000_000, -500_000, 2_000_000, 750_000]);
  assert.deepEqual(["1.000.000,5", "1,5", "10.00", "1.0000", "abc", "", 1.5].map(parseVndInteger), [null, null, null, null, null, null, null]);
  assert.ok(!parseTopupAmount("1.000.000,5").ok, "khách gõ số có phần lẻ ⇒ từ chối, không đoán");
  assert.equal(topupOutcome(null, 500_000), "NO_INTENT");

  // Ví dụ của chủ shop (08/10/2026): 842.000đ · chi TB 42.000đ/ngày ⇒ còn 20 ngày; còn 23 ngày tháng ⇒ nên nạp thêm 500.000đ.
  assert.deepEqual(balanceForecast({ balanceVnd: 842_000, spend7dVnd: 294_000, daysToMonthEnd: 23 }), { avgDailyVnd: 42_000, daysRemaining: 20, recommendTopupVnd: 500_000 });
  assert.deepEqual(balanceForecast({ balanceVnd: 100_000, spend7dVnd: 0, daysToMonthEnd: 10 }), { avgDailyVnd: null, daysRemaining: null, recommendTopupVnd: null }, "chưa chi gì ⇒ CHƯA dự báo, không phải 0");
  assert.equal(balanceForecast({ balanceVnd: -490, spend7dVnd: 7_000, daysToMonthEnd: 5 }).daysRemaining, 0);
  assert.equal(balanceForecast({ balanceVnd: 5_000_000, spend7dVnd: 7_000, daysToMonthEnd: 5 }).recommendTopupVnd, null, "đủ tới cuối tháng ⇒ không gợi ý nạp");

  for (const label of Object.values(AI_LEDGER_LABEL)) assert.ok(!/token|model|usd|nhà cung cấp|gemini|claude|openai/i.test(label), `nhãn khách «${label}» không lộ số nội bộ`);
}

// ─────────────────────────── 2 · MÃ NGUỒN ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function testSource() {
  const goc = process.cwd();
  const rel = (p: string) => path.relative(goc, p).split(path.sep).join("/");
  const offenders: string[] = [];
  for (const file of ["lib", "app", "components"].flatMap((d) => walk(path.join(goc, d)))) {
    const src = readFileSync(file, "utf8");
    const f = rel(file);
    // Sổ cái CHỈ GHI THÊM: không chỗ nào được sửa / xoá dòng sổ (dọn CSDL tổ chức ở db/migrate.ts không thuộc lib/app).
    if (/\.(update|delete)\(\s*schema\.platformAiLedgerEntries\b/.test(src) || /(update|delete\s+from)\s+"?platform_ai_ledger_entries/i.test(src)) offenders.push(`${f}: sửa / xoá dòng sổ`);
    // MỘT đường ghi: chỉ lib/billing/ai-balance.ts chèn dòng sổ.
    if (f !== "lib/billing/ai-balance.ts" && (/\.insert\(\s*schema\.platformAiLedgerEntries\b/.test(src) || /insert\s+into\s+"?platform_ai_ledger_entries/i.test(src))) offenders.push(`${f}: ghi thẳng vào sổ`);
  }
  assert.deepEqual(offenders, [], "sổ cái Số dư AI chỉ ghi thêm, qua MỘT đường ghi");
  const own = readFileSync(path.join(goc, "lib/billing/ai-balance.ts"), "utf8");
  assert.ok(!/\.update\(\s*e\b|\.delete\(\s*e\b/.test(own), "chính đường ghi cũng không sửa / xoá dòng sổ");
  assert.match(readFileSync(path.join(goc, "app/api/webhooks/sepay/route.ts"), "utf8"), /extractTopupCodes\(parsed\.txn\.content\)/, "webhook SePay đối chiếu khi nội dung mang mã nạp");
}

// ─────────────────────────── 3 · VÒNG TIỀN THẬT ───────────────────────────

let txnSeq = 0;
const RECEIVER_ACCOUNT = "0123456789";
/** Tiền vào mà SePay đã xác nhận (webhook): mang mã giao dịch SePay, vào đúng tài khoản nhận — đường duy nhất được tự cộng. */
async function bankIn(amount: number, description: string, txnAt: Date = new Date(), account: string = RECEIVER_ACCOUNT): Promise<string> {
  const pdb = await getPlatformDb();
  const bankRef = `${REF}${++txnSeq}`;
  await pdb.insert(schema.bankTransactions).values({ txnAt, amount, description, bankRef, source: "WEBHOOK", provider: "SEPAY", providerTxnId: `aib-sepay-${txnSeq}`, account, lastSeenSource: "WEBHOOK" });
  return bankRef;
}
/** Dòng KHÔNG có SePay xác nhận: gõ tay (MANUAL) / sao kê nhập (IMPORT) — có thể là thật, có thể là trùng, có thể là bịa. */
async function bankInRaw(amount: number, description: string, source: "MANUAL" | "IMPORT", txnAt: Date = new Date()): Promise<string> {
  const pdb = await getPlatformDb();
  const bankRef = `${REF}${++txnSeq}`;
  await pdb.insert(schema.bankTransactions).values({ txnAt, amount, description, bankRef, source, account: RECEIVER_ACCOUNT });
  return bankRef;
}

/** Gói TRẢ PHÍ (Growth, ghim bảng giá hiện hành) — Số dư AI chỉ nhận nạp ở gói trả phí (quyết định chủ shop #2). */
async function toPaidPlan(code: string, now: Date) {
  const pdb = await getPlatformDb();
  await pdb.update(schema.platformOrganizations).set({ plan: "growth" }).where(eq(schema.platformOrganizations.code, code));
  invalidateOrganizations();
  invalidatePricing();
  await initWorkspaceBilling(code, { selfService: false, now });
}

async function cleanup(savedReceiver: unknown) {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformBillingPayments).where(like(schema.platformBillingPayments.bankRef, `${REF}%`));
  await pdb.delete(schema.bankTransactions).where(like(schema.bankTransactions.bankRef, `${REF}%`));
  await pdb.delete(schema.platformAiLedgerEntries).where(inArray(schema.platformAiLedgerEntries.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPaymentIntents).where(inArray(schema.platformPaymentIntents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiAccounts).where(inArray(schema.platformAiAccounts.orgCode, [...ORGS]));
  if (savedReceiver === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  else await pdb.update(schema.platformSettings).set({ value: savedReceiver }).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.actorEmail, OP_EMAIL));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateOrgFlags();
}

async function adminOf(code: string): Promise<SessionUser> {
  const u = await withOrganization(code, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) }));
  assert.ok(u, `quản trị của ${code}`);
  return sessionUser({ id: u.id, email: u.email, organization: { code, name: `Tổ chức ${code}`, isHome: false } });
}

async function paymentOf(bankRef: string) {
  const pdb = await getPlatformDb();
  return (await pdb.select().from(schema.platformBillingPayments).where(eq(schema.platformBillingPayments.bankRef, bankRef)))[0];
}

async function run() {
  const pdb = await getPlatformDb();
  const home = await getHomeOrganization();
  const op = sessionUser({ id: "aib-op", email: OP_EMAIL, organization: { code: home.code, name: home.name, isHome: true } });
  const outsider = sessionUser({ id: "aib-x", email: "x@aib-b.local", permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });
  const tenantA = await adminOf(A);
  const tenantB = await adminOf(B);
  const viewerA = sessionUser({ id: "aib-viewer", email: "xem@aib-a.local", role: "VIEWER", permissions: ["dashboard:view"], organization: tenantA.organization });
  const now = new Date();

  // ── Cờ TẮT ⇒ không trang, không phiếu.
  assert.match(errorOf(await createAiTopupIntent(tenantA, { amountVnd: 1_000_000 })), /chưa mở/);
  assert.equal((await loadAiBalanceView(A)).enabled, false);

  // ── Chỉ người vận hành bật, bắt buộc lý do, có nhật ký.
  assert.ok("error" in (await setAiBalanceEnabled(outsider, { orgCode: A, enabled: true, reason: "thử bật hộ" })), "người ngoài tổ chức nhà không bật được");
  assert.ok("error" in (await setAiBalanceEnabled(op, { orgCode: A, enabled: true, reason: "" })), "thiếu lý do");
  const on = await setAiBalanceEnabled(op, { orgCode: A, enabled: true, reason: "Canary workspace thử" });
  assert.ok("ok" in on && on.changed, JSON.stringify(on));
  const flagAudit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), eq(schema.platformAuditLog.subject, AI_BALANCE_FLAG)));
  assert.equal(flagAudit.length, 1, "một dòng nhật ký bật cờ");

  // ── Chưa khai tài khoản nhận tiền ⇒ không có mã QR nào.
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  assert.match(errorOf(await createAiTopupIntent(tenantA, { amountVnd: 1_000_000 })), /tài khoản nhận tiền/);
  assert.equal((await loadAiBalanceView(A)).receiverReady, false);
  assert.ok("ok" in (await setBillingReceiver(op, { bin: "970422", accountNumber: "0123456789", accountName: "Công ty Nền Tảng", reason: "Tài khoản doanh thu nền tảng" })));

  // ── Dùng thử ⇒ không nhận nạp (Số dư AI chỉ cho gói trả phí); B sang gói trả phí ⇒ nạp được, tối đa 3 mã chờ cùng lúc.
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: B, enabled: true, reason: "Canary thử trần mã chờ" })));
  invalidateOrgFlags();
  assert.match(errorOf(await createAiTopupIntent(tenantB, { amountVnd: 500_000 }, now)), /gói trả phí/, "dùng thử ⇒ chọn gói trước khi nạp");
  await toPaidPlan(B, now);
  for (let k = 0; k < TOPUP_PENDING_MAX; k++) assert.ok("ok" in (await createAiTopupIntent(tenantB, { amountVnd: 500_000 }, now)), `mã chờ thứ ${k + 1}`);
  assert.match(errorOf(await createAiTopupIntent(tenantB, { amountVnd: 500_000 }, now)), /Đang có 3 mã/, "quá trần mã chờ ⇒ từ chối, không sinh vô hạn");
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: B, enabled: false, reason: "Xong thử trần mã chờ" })));
  invalidateOrgFlags();
  await toPaidPlan(A, now);

  // ── Quyền + số tiền.
  assert.ok("error" in (await createAiTopupIntent(viewerA, { amountVnd: 1_000_000 })), "người xem không tạo được phiếu");
  assert.ok("error" in (await createAiTopupIntent(tenantA, { amountVnd: 50_000 })), "dưới sàn");

  // ── Tạo phiếu 1.000.000đ: mã + số tiền nằm sẵn trong VietQR, hạn 30 phút.
  const r1 = await createAiTopupIntent(tenantA, { amountVnd: 1_000_000 }, now);
  assert.ok("ok" in r1, JSON.stringify(r1));
  const i1 = r1.intent;
  assert.match(i1.referenceCode, TOPUP_CODE_PATTERN);
  assert.deepEqual([i1.amountVnd, i1.status], [1_000_000, "PENDING"]);
  assert.ok(Math.abs(Date.parse(i1.expiresAt) - now.getTime() - 30 * 60_000) < 2_000, "hạn 30 phút");
  assert.ok(i1.qrPayload.includes("54071000000") && i1.qrPayload.includes(i1.referenceCode), "VietQR động mang đúng số tiền + mã chuyển khoản");
  assert.deepEqual([i1.receiver.accountNumber, i1.receiver.accountName], ["0123456789", "CONG TY NEN TANG"]);
  assert.equal((await loadAiBalanceView(A, now)).pending?.id, i1.id, "mở lại trang vẫn thấy mã đang chờ");

  // ── Cô lập tổ chức: B không đọc được phiếu của A.
  assert.match(errorOf(await aiTopupStatus(tenantB, i1.id, now)), /Không có phiếu/);

  // ── Tiền về (ngân hàng đổi chữ thường, chèn chữ) ⇒ đối chiếu chạy 10 lần (webhook gửi lại) vẫn cộng ĐÚNG một lần.
  const ref1 = await bankIn(1_000_000, `NGUYEN VAN A chuyen tien ${i1.referenceCode.toLowerCase()} FT2610`);
  const firstRun = await reconcileBillingPayments({ lookbackDays: 3 });
  assert.deepEqual([firstRun.matched, firstRun.topupCredited, firstRun.topupHeld], [0, 1, 0], "tiền nạp đã cộng đếm riêng — không phải «khớp và gia hạn» của thuê bao");
  for (let k = 0; k < 9; k++) await reconcileBillingPayments({ lookbackDays: 3 });
  assert.deepEqual(await readAiBalance(A), { cashVnd: 1_000_000, promoVnd: 0, totalVnd: 1_000_000 }, "số dư tăng đúng một lần");
  const p1 = await paymentOf(ref1);
  assert.deepEqual([p1.outcome, p1.paymentIntentId, p1.orgCode], ["TOPUP_CREDITED", i1.id, A]);
  const st1 = await aiTopupStatus(tenantA, i1.id, now);
  assert.ok("ok" in st1 && st1.status === "PAID" && st1.paidAmountVnd === 1_000_000 && st1.balanceVnd === 1_000_000, JSON.stringify(st1));
  const topups = await pdb.select().from(schema.platformAiLedgerEntries).where(and(eq(schema.platformAiLedgerEntries.orgCode, A), eq(schema.platformAiLedgerEntries.entryType, "TOPUP")));
  assert.deepEqual(topups.map((t) => t.idempotencyKey), [`topup:${ref1}`]);

  // ── TỰ LÀNH: tiền về mà KHÔNG ai gọi đối chiếu (lượt sau phản hồi webhook hỏng) ⇒ khách hỏi trạng thái là được cộng.
  const r2 = await createAiTopupIntent(tenantA, { amountVnd: 500_000 }, now);
  assert.ok("ok" in r2);
  await bankIn(500_000, `NAP ${r2.intent.referenceCode}`);
  const st2 = await aiTopupStatus(tenantA, r2.intent.id, now);
  assert.ok("ok" in st2 && st2.status === "PAID" && st2.balanceVnd === 1_500_000, `tự lành khi khách hỏi trạng thái: ${JSON.stringify(st2)}`);

  // ── Lệch số tiền ⇒ cộng NGUYÊN số thật nhận, gắn cần xem lại; không ai phải duyệt.
  const r3 = await createAiTopupIntent(tenantA, { amountVnd: 2_000_000 }, now);
  assert.ok("ok" in r3);
  const ref3 = await bankIn(1_500_000, `${r3.intent.referenceCode}`);
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await readAiBalance(A)).totalVnd, 3_000_000);
  assert.equal((await paymentOf(ref3)).outcome, "TOPUP_CREDITED_REVIEW");
  // ── Khoản THỨ HAI mang mã của phiếu ĐÃ cộng (khách chuyển lần hai, hoặc cùng một khoản vào sổ hai lần) ⇒ GIỮ LẠI, KHÔNG
  //    cộng — máy không phân biệt được hai trường hợp; người vận hành xem và cộng tay nếu là tiền thật.
  const ref3b = await bankIn(500_000, `${r3.intent.referenceCode}`);
  const sum3b = await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await readAiBalance(A)).totalVnd, 3_000_000, "mã của phiếu đã cộng ⇒ không cộng lần hai");
  assert.equal((await paymentOf(ref3b)).outcome, "TOPUP_HELD");
  assert.deepEqual([sum3b.matched, sum3b.topupCredited, sum3b.topupHeld], [0, 0, 1], "tiền nạp đếm riêng — không phải «khớp và gia hạn» của thuê bao");
  // ── Mã nạp không thuộc phiếu nào ⇒ không cộng cho ai, nằm ở danh sách người vận hành.
  const refX = await bankIn(300_000, `NAP ${makeTopupCode([9, 9, 9, 9, 9, 9])}`);
  await reconcileBillingPayments({ lookbackDays: 3 });
  const pX = await paymentOf(refX);
  assert.deepEqual([pX.outcome, pX.orgCode, pX.paymentIntentId], ["NO_INVOICE", null, null]);
  assert.equal((await readAiBalance(A)).totalVnd, 3_000_000, "mã lạ không cộng");

  // ── H1: dòng GÕ TAY mang mã của phiếu đang chờ ⇒ KHÔNG tự cộng, KHÔNG ghi gì — kể cả khi SePay điền mã giao dịch cho CÙNG mã
  //    bút toán SAU đó (review #650: đường ghi SePay không sửa số tiền / nội dung của dòng đã có). Người vận hành đối chiếu app
  //    ngân hàng rồi «điều chỉnh tiền thật».
  const r6 = await createAiTopupIntent(tenantA, { amountVnd: 100_000 }, now);
  assert.ok("ok" in r6);
  const refM = await bankInRaw(100_000, `NAP ${r6.intent.referenceCode}`, "MANUAL");
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal(await aiTopupStatus(tenantA, r6.intent.id, now).then((st) => ("ok" in st ? st.status : st.error)), "PENDING", "người có quyền ghi sổ ngân hàng không tự «nạp» được cho khách");
  assert.equal((await readAiBalance(A)).totalVnd, 3_000_000);
  assert.equal(await paymentOf(refM), undefined, "dòng chưa xác nhận không bị «xử lý xong» — lượt sau còn xét lại");
  await pdb.update(schema.bankTransactions).set({ provider: "SEPAY", providerTxnId: "aib-sepay-confirm-m", account: RECEIVER_ACCOUNT, lastSeenSource: "WEBHOOK" }).where(eq(schema.bankTransactions.bankRef, refM));
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal(await paymentOf(refM), undefined, "dòng không do SePay tạo ⇒ vẫn không tự cộng dù SePay điền mã giao dịch sau");
  assert.equal((await readAiBalance(A)).totalVnd, 3_000_000);
  assert.ok("ok" in (await adjustAiBalance(op, { orgCode: A, kind: "ADJUST_CASH", amountVnd: 100_000, reason: `Tiền thật, đối chiếu app ngân hàng — ${refM}`, requestKey: "rkaibmanual01" })));
  assert.equal((await readAiBalance(A)).totalVnd, 3_100_000, "người vận hành cộng tay sau khi đối chiếu");
  // ── H1: SAO KÊ nhập trùng một khoản ĐÃ cộng (khác mã tham chiếu) ⇒ không cộng lần hai, không ghi gì.
  const refDup = await bankInRaw(500_000, `NAP ${r2.intent.referenceCode}`, "IMPORT");
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await readAiBalance(A)).totalVnd, 3_100_000, "sao kê trùng không sinh tiền");
  assert.equal(await paymentOf(refDup), undefined);
  // ── H1: SePay xác nhận nhưng tiền vào tài khoản KHÁC tài khoản nhận ⇒ giữ lại, phiếu vẫn chờ.
  const r7 = await createAiTopupIntent(tenantA, { amountVnd: 300_000 }, now);
  assert.ok("ok" in r7);
  const refO = await bankIn(300_000, `${r7.intent.referenceCode}`, now, "9999999999");
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await paymentOf(refO)).outcome, "TOPUP_HELD");
  assert.equal((await readAiBalance(A)).totalVnd, 3_100_000);
  assert.equal(await aiTopupStatus(tenantA, r7.intent.id, now).then((st) => ("ok" in st ? st.status : st.error)), "PENDING");
  // ── Hai khoản tiền KHÁC mã tham chiếu mang CÙNG mã phiếu tới CÙNG LÚC (webhook + lượt quét API song song, cả hai cùng đọc thấy
  //    phiếu đang chờ) ⇒ chỉ MỘT khoản giành được phiếu; khoản kia giữ lại — không cộng hai lần.
  const r8 = await createAiTopupIntent(tenantA, { amountVnd: 200_000 }, now);
  assert.ok("ok" in r8);
  const refR1 = await bankIn(200_000, `${r8.intent.referenceCode}`);
  const refR2 = await bankIn(200_000, `${r8.intent.referenceCode} lan hai`);
  const bt = schema.bankTransactions;
  const rowOf = async (ref: string) => (await pdb.select({ bankRef: bt.bankRef, txnAt: bt.txnAt, amount: bt.amount, description: bt.description, provider: bt.provider, providerTxnId: bt.providerTxnId, account: bt.account, source: bt.source }).from(bt).where(eq(bt.bankRef, ref)))[0];
  const [row1, row2] = [await rowOf(refR1), await rowOf(refR2)];
  const raced = await Promise.all([creditTopupFromBankRow(row1, [r8.intent.referenceCode], now), creditTopupFromBankRow(row2, [r8.intent.referenceCode], now)]);
  assert.deepEqual([...raced].sort(), ["TOPUP_CREDITED", "TOPUP_HELD"], `một khoản cộng, một khoản giữ lại: ${JSON.stringify(raced)}`);
  assert.equal((await readAiBalance(A)).totalVnd, 3_300_000, "phiếu 200.000đ cộng ĐÚNG một lần");

  // ── Trả MUỘN sau hạn 30 phút ⇒ vẫn cộng (tiền không bao giờ biến mất).
  const r4 = await createAiTopupIntent(tenantA, { amountVnd: 100_000 }, new Date(now.getTime() - 3 * 3_600_000));
  assert.ok("ok" in r4);
  assert.equal((await aiTopupStatus(tenantA, r4.intent.id, now).then((s) => ("ok" in s ? s.status : s.error))), "EXPIRED", "phiếu quá hạn hiện «Hết hạn»");
  await bankIn(100_000, `${r4.intent.referenceCode}`);
  const st4 = await aiTopupStatus(tenantA, r4.intent.id, now);
  assert.ok("ok" in st4 && st4.status === "PAID" && st4.balanceVnd === 3_400_000, `trả muộn vẫn cộng: ${JSON.stringify(st4)}`);

  // ── Khoá chống trùng của sổ + ràng buộc dấu ở CSDL (cùng luật với TypeScript).
  const k1 = await postAiLedgerEntry(pdb, { orgCode: B, entryType: "PROMO_CREDIT", fundsClass: "PROMO", amountVnd: 10_000, idempotencyKey: "aib-test-key-1", sourceType: "SYSTEM" });
  const k2 = await postAiLedgerEntry(pdb, { orgCode: B, entryType: "PROMO_CREDIT", fundsClass: "PROMO", amountVnd: 10_000, idempotencyKey: "aib-test-key-1", sourceType: "SYSTEM" });
  assert.deepEqual([k1.created, k2.created, k1.id === k2.id], [true, false, true], "cùng khoá ⇒ một dòng");
  await assert.rejects(postAiLedgerEntry(pdb, { orgCode: B, entryType: "PROMO_CREDIT", fundsClass: "PROMO", amountVnd: 99_000, idempotencyKey: "aib-test-key-1", sourceType: "SYSTEM" }), /khác/, "cùng khoá khác số tiền ⇒ ném, không nuốt im lặng");
  await assert.rejects(postAiLedgerEntry(pdb, { orgCode: B, entryType: "TOPUP", fundsClass: "CASH", amountVnd: -5, idempotencyKey: "aib-test-key-2", sourceType: "SYSTEM" }), /không hợp lệ/);
  await assert.rejects(
    pdb.execute(sql`insert into platform_ai_ledger_entries (id, org_code, entry_type, funds_class, amount_vnd, idempotency_key, source_type) values ('aib-raw-1', ${B}, 'TOPUP', 'CASH', -5, 'aib-test-key-3', 'SYSTEM')`),
    "CSDL chặn dòng nạp âm dù có ai ghi thẳng",
  );
  assert.equal((await readAiBalance(B)).totalVnd, 10_000, "tổ chức B chỉ có đúng dòng của B");

  // ── Người vận hành: tặng / hoàn — bắt buộc lý do, bấm hai lần ra một dòng, hoàn không vượt tiền thật.
  assert.ok("error" in (await adjustAiBalance(outsider, { orgCode: A, kind: "PROMO_CREDIT", amountVnd: 200_000, reason: "tặng thử", requestKey: "rkaibtest001" })));
  assert.ok("error" in (await adjustAiBalance(op, { orgCode: A, kind: "PROMO_CREDIT", amountVnd: 200_000, reason: "", requestKey: "rkaibtest001" })));
  assert.match(errorOf(await adjustAiBalance(op, { orgCode: A, kind: "PROMO_CREDIT", amountVnd: -200_000, reason: "Tặng số âm", requestKey: "rkaibtestneg1" })), /số DƯƠNG/, "tặng số âm bị từ chối, không lặng lẽ đổi dấu");
  assert.match(errorOf(await adjustAiBalance(op, { orgCode: A, kind: "ADJUST_CASH", amountVnd: "1.000.000,5", reason: "Số lẻ", requestKey: "rkaibtestdec1" })), /số nguyên/, "phần lẻ bị từ chối");
  const g1 = await adjustAiBalance(op, { orgCode: A, kind: "PROMO_CREDIT", amountVnd: 200_000, reason: "Tặng khách canary", requestKey: "rkaibtest001" });
  const g2 = await adjustAiBalance(op, { orgCode: A, kind: "PROMO_CREDIT", amountVnd: 200_000, reason: "Tặng khách canary", requestKey: "rkaibtest001" });
  assert.ok("ok" in g1 && "ok" in g2 && /không ghi lần hai/.test(g2.message), JSON.stringify([g1, g2]));
  assert.deepEqual(await readAiBalance(A), { cashVnd: 3_400_000, promoVnd: 200_000, totalVnd: 3_600_000 });
  assert.match(errorOf(await adjustAiBalance(op, { orgCode: A, kind: "REFUND", amountVnd: 9_000_000, reason: "Hoàn tiền thử", requestKey: "rkaibtest002" })), /tối đa/);
  assert.ok("ok" in (await adjustAiBalance(op, { orgCode: A, kind: "REFUND", amountVnd: 100_000, reason: "Khách xin hoàn một phần", requestKey: "rkaibtest003" })));
  assert.deepEqual(await readAiBalance(A), { cashVnd: 3_300_000, promoVnd: 200_000, totalVnd: 3_500_000 });
  const adjAudit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), eq(schema.platformAuditLog.action, "AI_BALANCE_ADJUST")));
  assert.equal(adjAudit.length, 3, "một dòng nhật ký mỗi lượt ghi thật — cộng tay dòng gõ tay (H1) + tặng + hoàn; lượt bấm lại không ghi");

  // ── Ngưỡng báo số dư thấp.
  assert.ok("error" in (await setLowBalanceThreshold(viewerA, { amountVnd: "400000" })));
  assert.ok("error" in (await setLowBalanceThreshold(tenantA, { amountVnd: "-1" })));
  assert.ok("ok" in (await setLowBalanceThreshold(tenantA, { amountVnd: "5.000.000" })));

  // ── Màn khách: số dư = tổng sổ; lịch sử có nạp; lý do của người vận hành không lộ; không trường / chữ nội bộ.
  const view = await loadAiBalanceView(A, now);
  assert.deepEqual([view.enabled, view.receiverReady, view.balanceVnd, view.lowBalanceVnd, view.isLow], [true, true, 3_500_000, 5_000_000, true]);
  assert.ok(view.history.some((h) => h.label === "Nạp tiền" && h.amountVnd === 1_000_000));
  assert.ok(!JSON.stringify(view.history).includes("Khách xin hoàn"), "lý do nội bộ của người vận hành không hiện cho khách");
  assert.ok(!/token|usd|cost|model|provider|margin/i.test(JSON.stringify(view)), "màn khách không chứa số nội bộ");

  // ── Màn vận hành: số dư tách tiền thật / tiền tặng; danh sách cần xem lại có khoản lệch + mã lạ.
  const opView = await loadAiBalanceOperatorView(op, now);
  assert.ok(!("error" in opView));
  const rowA = opView.rows.find((r) => r.orgCode === A);
  assert.ok(rowA && rowA.cashVnd === 3_300_000 && rowA.promoVnd === 200_000 && rowA.enabled, JSON.stringify(rowA));
  const reviewRefs = new Set(opView.review.map((r) => r.bankRef));
  assert.ok(reviewRefs.has(ref3) && reviewRefs.has(ref3b) && reviewRefs.has(refX) && reviewRefs.has(refO) && !reviewRefs.has(ref1) && !reviewRefs.has(refM), JSON.stringify(opView.review));
  assert.ok(opView.review.every((r) => typeof r.paymentId === "string" && r.paymentId), "mỗi khoản cần xem lại mang mã dòng để đánh dấu đã xử lý");
  assert.ok(opView.unconfirmed.some((r) => r.bankRef === refDup && r.source === "IMPORT") && opView.unconfirmed.some((r) => r.bankRef === refM && r.source === "MANUAL"), JSON.stringify(opView.unconfirmed));
  // ── M1: tiền nạp không lẫn vào «Tiền chưa khớp» của khung thu phí thuê bao (nhầm là dùng một khoản tiền hai lần).
  const billing = await loadPlatformBilling(op, now);
  assert.ok(!("error" in billing));
  assert.ok(!billing.unresolvedPayments.some((p) => p.transferCode.startsWith("ERPNAP") || p.outcome.startsWith("TOPUP")), JSON.stringify(billing.unresolvedPayments.map((p) => [p.transferCode, p.outcome])));
  assert.ok("error" in (await loadAiBalanceOperatorView(tenantA, now)), "khách không mở được màn vận hành");

  // ── Tắt cờ: tiền đã nạp giữ nguyên; không tạo phiếu mới; tiền về muộn của phiếu cũ VẪN được cộng.
  const r5 = await createAiTopupIntent(tenantA, { amountVnd: 200_000 }, now);
  assert.ok("ok" in r5);
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: A, enabled: false, reason: "Tạm tắt canary" })));
  invalidateOrgFlags();
  assert.match(errorOf(await createAiTopupIntent(tenantA, { amountVnd: 200_000 }, now)), /chưa mở/);
  await bankIn(200_000, `${r5.intent.referenceCode}`);
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await readAiBalance(A)).totalVnd, 3_700_000, "tắt cờ không làm mất tiền về muộn");

  // ── Không đọc được tài khoản nhận (chưa khai / lỗi đọc) ⇒ KHÔNG xử lý khoản nạp lượt này — `bank_ref` không bị khoá thành «giữ
  //    lại» VĨNH VIỄN; lượt sau đọc được thì cộng (review Số dư AI 08/10/2026, LOW).
  assert.ok("ok" in (await setAiBalanceEnabled(op, { orgCode: A, enabled: true, reason: "Bật lại để thử tài khoản nhận" })));
  invalidateOrgFlags();
  const r9 = await createAiTopupIntent(tenantA, { amountVnd: 150_000 }, now);
  assert.ok("ok" in r9);
  const recv = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
  assert.ok(recv, "đã khai tài khoản nhận");
  await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  const refNoRecv = await bankIn(150_000, `${r9.intent.referenceCode}`);
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal(await paymentOf(refNoRecv), undefined, "chưa đọc được tài khoản nhận ⇒ chưa ghi gì, không khoá «giữ lại»");
  await pdb.insert(schema.platformSettings).values({ key: BILLING_RECEIVER_KEY, value: recv.value });
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal((await paymentOf(refNoRecv))?.outcome, "TOPUP_CREDITED", "đọc lại được tài khoản nhận ⇒ cộng");
  assert.equal((await readAiBalance(A)).totalVnd, 3_850_000);

  // ── N1 chiều ngược (review #650): sao kê dựng sẵn nhập TRƯỚC (mã bút toán thật + 50 triệu + mã nạp «ERPNAP…»), SePay xác nhận
  //    khoản THẬT 10.000đ SAU — đường ghi SePay chỉ điền ô rỗng, không sửa số tiền / mô tả ⇒ KHÔNG tự cộng, nằm ở «chưa xác nhận».
  const r10 = await createAiTopupIntent(tenantA, { amountVnd: 100_000 }, now);
  assert.ok("ok" in r10);
  const refFake = await bankInRaw(50_000_000, `${r10.intent.referenceCode}`, "IMPORT");
  await pdb.update(schema.bankTransactions).set({ provider: "SEPAY", providerTxnId: "aib-sepay-late", account: RECEIVER_ACCOUNT, lastSeenSource: "WEBHOOK" }).where(eq(schema.bankTransactions.bankRef, refFake));
  await reconcileBillingPayments({ lookbackDays: 3 });
  assert.equal(await paymentOf(refFake), undefined, "dòng không do SePay tạo ⇒ không ghi, không cộng");
  assert.equal((await readAiBalance(A)).totalVnd, 3_850_000, "số dư không đổi");
  const opLate = await loadAiBalanceOperatorView(op, now);
  assert.ok(!("error" in opLate) && opLate.unconfirmed.some((r) => r.bankRef === refFake), "nằm ở danh sách «chưa xác nhận» của người vận hành");
}

export async function testAiBalance() {
  testPure();
  testSource();
  const pdb = await getPlatformDb();
  const savedRow = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
  const savedReceiver = savedRow ? savedRow.value : undefined;
  await cleanup(savedReceiver);
  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "AiBalance@12345" }, source: "TEST", actor: null });
  try {
    await run();
  } finally {
    await cleanup(savedReceiver);
  }
  console.log(
    "✓ Số dư AI + nạp QR: sổ cái chỉ ghi thêm (luật dấu ở TS = ở CSDL, một đường ghi) · cờ canary chỉ người vận hành bật, có nhật ký · chưa khai tài khoản nhận ⇒ không mã QR · VietQR động mang sẵn số tiền + mã ERPNAP · tiền SePay xác nhận cộng ĐÚNG một lần dù đối chiếu 10 lần · tự lành khi khách hỏi trạng thái · lệch số / trả muộn vẫn cộng (cần xem lại) · mã của phiếu đã cộng ⇒ giữ lại · dòng gõ tay / sao kê trùng / tài khoản khác không tự cộng · tiền nạp tách khỏi tiền thuê bao · dùng thử không nạp · tối đa 3 mã chờ · mã lạ không cộng cho ai · cô lập tổ chức · tặng / hoàn bấm hai lần ra một dòng, hoàn không vượt tiền thật · màn khách không lộ số nội bộ · tắt cờ không mất tiền",
  );
}
