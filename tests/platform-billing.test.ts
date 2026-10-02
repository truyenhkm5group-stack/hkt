/**
 * THU PHÍ THUÊ BAO (0187 · docs/platform/billing.md).
 *
 *  1. THUẦN — ngày giờ VN, cộng tháng kẹp cuối tháng, bảng chân lý tình trạng (ranh 7 ngày · ân hạn · khoá), cổng chỉ xem
 *     (nhà · phương thức đọc · đường miễn), báo giá (bắt đầu · gia hạn · ân hạn nối tiếp · dùng thử · nâng có trừ · hạ ·
 *     trừ quá lớn), mã chuyển khoản (ngân hàng đổi chữ / chèn ký tự), phán quyết một khoản tiền.
 *  2. VÒNG TIỀN THẬT trên một tổ chức PGlite riêng: chưa khai tài khoản nhận ⇒ không tạo mã; tạo mã; bấm lại không đẻ mã
 *     thứ hai; đổi lựa chọn ⇒ mã cũ VOID; tiền THIẾU ⇒ ghi, không gia hạn; tiền ĐỦ ⇒ PAID + trả tới + đổi gói + nhật ký
 *     (máy) trong MỘT giao dịch; đối chiếu lại không đếm đôi; tiền về mã đã huỷ / mã lạ / tiền ra ⇒ đúng phán quyết.
 *  3. CỔNG CHỈ XEM: quá hạn + hết ân hạn ⇒ lượt GHI của phiên bị từ chối `BILLING_LOCKED`, lượt ĐỌC và trang gia hạn
 *     vẫn đi; job nền SKIPPED; xác nhận tay ⇒ mở ngay.
 *  4. Người ngoài (người xem của nhà, quản trị tổ chức khác) bị từ chối mọi thao tác vận hành, không đổi một dòng.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { resolveCurrentUser, setRequestMethodSourceForTests, setRequestPathSourceForTests, signSession, type SessionUser } from "@/lib/auth/session";
import {
  addMonths,
  billingStanding,
  billingWriteDenied,
  extractTransferCodes,
  judgePayment,
  periodEndFor,
  quoteRenewal,
  transferCodeFrom,
  TRANSFER_CODE_PATTERN,
  vnDate,
  type RenewalQuote,
} from "@/lib/billing/rules";
import {
  BILLING_RECEIVER_KEY,
  createRenewalInvoice,
  loadPlatformBilling,
  loadTenantBilling,
  markInvoicePaidManually,
  previewRenewal,
  reconcileBillingPayments,
  resolveBillingPayment,
  setBillingReceiver,
  setOrgBilling,
  setPlanPrice,
  voidInvoice,
} from "@/lib/billing/service";
import { invalidateSubscriptions, orgBillingStanding } from "@/lib/billing/standing";
import { listPlans } from "@/lib/entitlements/check";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { findOrganization, getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { runJob } from "@/lib/sync/jobs";

const A = "bil-a";
const B = "bil-b";
const ORGS = [A, B] as const;
const REF = "bil-test-";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "bil-user", email: "bil@local", name: "BIL", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

function isQuote(q: RenewalQuote | { error: string }): q is RenewalQuote {
  return !("error" in q);
}

// ═══════════ 1 · THUẦN ═══════════

function testPure() {
  // Ngày Việt Nam: 16:59Z vẫn là hôm nay, 17:00Z đã là ngày mai.
  assert.equal(vnDate(new Date("2026-10-02T16:59:59Z")), "2026-10-02");
  assert.equal(vnDate(new Date("2026-10-02T17:00:00Z")), "2026-10-03");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29", "năm nhuận");
  assert.equal(addMonths("2026-11-15", 3), "2027-02-15", "qua năm");
  assert.equal(periodEndFor("2026-03-01", 1), "2026-03-31");
  assert.equal(periodEndFor("2026-10-02", 12), "2027-10-01");

  // Bảng chân lý tình trạng (trả tới 2026-10-20, ân hạn 7).
  const t = { billingEnabled: true, paidThrough: "2026-10-20", graceDays: 7 };
  const kind = (today: string) => billingStanding(t, today).kind;
  assert.equal(kind("2026-10-13"), "ACTIVE", "còn đúng 7 ngày");
  assert.equal(kind("2026-10-14"), "DUE_SOON", "còn 6 ngày");
  assert.equal(kind("2026-10-20"), "DUE_SOON", "ngày cuối cùng đã trả");
  assert.equal(kind("2026-10-21"), "OVERDUE");
  assert.equal(kind("2026-10-27"), "OVERDUE", "ngày ân hạn cuối");
  assert.equal(kind("2026-10-28"), "LOCKED");
  assert.equal(billingStanding(t, "2026-10-21").lockOn, "2026-10-28");
  assert.equal(billingStanding({ ...t, billingEnabled: false }, "2027-01-01").kind, "NOT_BILLED", "chưa bật thu phí ⇒ không bao giờ khoá");
  assert.equal(billingStanding(null, "2027-01-01").kind, "NOT_BILLED");
  assert.equal(billingStanding({ ...t, graceDays: 0 }, "2026-10-21").kind, "LOCKED", "ân hạn 0 ⇒ khoá ngay hôm sau");

  // Cổng chỉ xem.
  const base = { isHome: false, standing: "LOCKED" as const, method: "POST", path: "/orders" };
  assert.equal(billingWriteDenied(base), true);
  assert.equal(billingWriteDenied({ ...base, isHome: true }), false, "nhà không bao giờ");
  assert.equal(billingWriteDenied({ ...base, method: "GET" }), false, "đọc vẫn đi");
  assert.equal(billingWriteDenied({ ...base, method: "HEAD" }), false);
  assert.equal(billingWriteDenied({ ...base, path: "/settings/plan" }), false, "trang gia hạn được miễn");
  assert.equal(billingWriteDenied({ ...base, path: "/settings/planning" }), true, "tiền tố phải là ranh giới đường dẫn");
  assert.equal(billingWriteDenied({ ...base, method: null }), false, "ngoài request ⇒ cổng job lo");
  assert.equal(billingWriteDenied({ ...base, standing: "OVERDUE" }), false, "ân hạn vẫn ghi");

  // Báo giá.
  const starter = { key: "starter", name: "Khởi đầu", priceVnd: 499_000 };
  const growth = { key: "growth", name: "Tăng trưởng", priceVnd: 999_000 };
  const trial = { key: "trial", name: "Dùng thử", priceVnd: null };
  const today = "2026-10-02";
  const q1 = quoteRenewal({ terms: null, currentPlan: trial, target: starter, months: 1, today });
  assert.ok(isQuote(q1) && q1.kind === "START" && q1.periodStart === today && q1.periodEnd === "2026-11-01" && q1.amountVnd === 499_000, JSON.stringify(q1));
  const qTrial = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2026-10-10", graceDays: 7 }, currentPlan: trial, target: growth, months: 3, today });
  assert.ok(isQuote(qTrial) && qTrial.periodStart === "2026-10-11" && qTrial.creditVnd === 0 && qTrial.amountVnd === 2_997_000, `dùng thử: ngày thử còn lại giữ nguyên ${JSON.stringify(qTrial)}`);
  const qRenew = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2026-10-20", graceDays: 7 }, currentPlan: starter, target: starter, months: 1, today });
  assert.ok(isQuote(qRenew) && qRenew.kind === "RENEW" && qRenew.periodStart === "2026-10-21" && qRenew.periodEnd === "2026-11-20");
  const qOver = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2026-09-28", graceDays: 7 }, currentPlan: starter, target: starter, months: 1, today });
  assert.ok(isQuote(qOver) && qOver.periodStart === "2026-09-29", "ân hạn ⇒ nối tiếp, những ngày ân hạn nằm trong kỳ");
  const qLocked = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2026-09-01", graceDays: 7 }, currentPlan: starter, target: starter, months: 1, today });
  assert.ok(isQuote(qLocked) && qLocked.kind === "START" && qLocked.periodStart === today, "đã khoá ⇒ từ hôm nay, không bắt trả ngày bị khoá");
  // Nâng: trả tới 2026-10-31 ⇒ còn 30 ngày kể cả hôm nay ⇒ trừ 499.000 × 30 / 30.
  const qUp = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2026-10-31", graceDays: 7 }, currentPlan: starter, target: growth, months: 1, today });
  assert.ok(isQuote(qUp) && qUp.kind === "UPGRADE" && qUp.periodStart === today && qUp.creditVnd === 499_000 && qUp.amountVnd === 500_000, JSON.stringify(qUp));
  const qUpTooBig = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2027-09-30", graceDays: 7 }, currentPlan: starter, target: growth, months: 1, today });
  assert.ok("error" in qUpTooBig, "phần trừ ≥ tiền gói mới ⇒ bắt chọn nhiều tháng hơn");
  const qDown = quoteRenewal({ terms: { billingEnabled: true, paidThrough: "2026-10-31", graceDays: 7 }, currentPlan: growth, target: starter, months: 1, today });
  assert.ok(isQuote(qDown) && qDown.kind === "DOWNGRADE" && qDown.periodStart === "2026-11-01" && qDown.creditVnd === 0);
  assert.ok("error" in quoteRenewal({ terms: null, currentPlan: null, target: starter, months: 2, today }), "số tháng ngoài danh sách");
  assert.ok("error" in quoteRenewal({ terms: null, currentPlan: null, target: trial, months: 1, today }), "gói không bán");

  // Mã chuyển khoản.
  const code = transferCodeFrom([0, 1, 2, 3, 30, 31]);
  assert.match(code, TRANSFER_CODE_PATTERN);
  assert.deepEqual(extractTransferCodes(`ck erphd${code.slice(5).toLowerCase()} tien thue`), [code], "chữ thường");
  assert.deepEqual(extractTransferCodes(`MBVCB.123.${code.slice(0, 5)}-${code.slice(5)}.CT tu 0123`), [code], "ngân hàng chèn gạch");
  assert.deepEqual(extractTransferCodes(`${code}THANH TOAN ĐƠN`), [code], "dính chữ phía sau");
  assert.deepEqual(extractTransferCodes("ERPHD12 thiếu ký tự"), []);
  assert.equal(extractTransferCodes(`${code} và ERPHDABCDEF`).length, 2);

  assert.equal(judgePayment(100, null), "NO_INVOICE");
  assert.equal(judgePayment(100, { status: "VOID", amountVnd: 100 }), "INVOICE_NOT_OPEN");
  assert.equal(judgePayment(99, { status: "OPEN", amountVnd: 100 }), "UNDERPAID");
  assert.equal(judgePayment(150, { status: "OPEN", amountVnd: 100 }), "MATCHED", "trả thừa vẫn khớp");
}

// ═══════════ 2–4 · CSDL THẬT ═══════════

async function cleanup(savedReceiver: unknown, savedPrices: Map<string, number | null>) {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformBillingPayments).where(like(schema.platformBillingPayments.bankRef, `${REF}%`));
  await pdb.delete(schema.platformInvoices).where(inArray(schema.platformInvoices.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  await pdb.delete(schema.bankTransactions).where(like(schema.bankTransactions.bankRef, `${REF}%`));
  if (savedReceiver === undefined) await pdb.delete(schema.platformSettings).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  else await pdb.update(schema.platformSettings).set({ value: savedReceiver }).where(eq(schema.platformSettings.key, BILLING_RECEIVER_KEY));
  for (const [key, price] of savedPrices) await pdb.update(schema.platformPlans).set({ priceVnd: price }).where(eq(schema.platformPlans.key, key));
  const home = await getHomeOrganization();
  await pdb.delete(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, home.code), inArray(schema.platformAuditLog.action, ["BILLING_RECEIVER_SET", "PLAN_PRICE_SET", "BILLING_PAYMENT_RESOLVE"])));
  for (const code of ORGS) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
}

let txnSeq = 0;
async function bankIn(amount: number, description: string): Promise<string> {
  const pdb = await getPlatformDb();
  const bankRef = `${REF}${++txnSeq}`;
  await pdb.insert(schema.bankTransactions).values({ txnAt: new Date(), amount, description, bankRef });
  return bankRef;
}

async function openInvoices(code: string) {
  const pdb = await getPlatformDb();
  return pdb.select().from(schema.platformInvoices).where(and(eq(schema.platformInvoices.orgCode, code), eq(schema.platformInvoices.status, "OPEN")));
}

async function invoiceById(id: string) {
  const pdb = await getPlatformDb();
  const [row] = await pdb.select().from(schema.platformInvoices).where(eq(schema.platformInvoices.id, id));
  return row;
}

async function paymentByRef(ref: string) {
  const pdb = await getPlatformDb();
  const [row] = await pdb.select().from(schema.platformBillingPayments).where(eq(schema.platformBillingPayments.bankRef, ref));
  return row;
}

/** Một lượt request của phiên tổ chức A: phương thức + đường dẫn ⇒ người dùng hoặc lý do từ chối. */
async function asRequest(token: string, method: string, reqPath: string) {
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => reqPath);
  setRequestMethodSourceForTests(() => method);
  try {
    return await resolveCurrentUser();
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    setRequestMethodSourceForTests(null);
  }
}

export async function testPlatformBilling() {
  testPure();
  const pdb = await getPlatformDb();
  const savedRow = await pdb.query.platformSettings.findFirst({ where: eq(schema.platformSettings.key, BILLING_RECEIVER_KEY) });
  const savedReceiver = savedRow ? savedRow.value : undefined;
  const savedPrices = new Map((await listPlans()).map((p) => [p.key, p.priceVnd]));
  await cleanup(savedReceiver, savedPrices);

  const home = await getHomeOrganization();
  const op = sessionUser({ id: "bil-op", email: "op@bil.local", organization: { code: home.code, name: home.name, isHome: true } });
  const homeViewer = sessionUser({ id: "bil-viewer", email: "xem@bil.local", role: "VIEWER", permissions: ["dashboard:view"], organization: op.organization });
  const otherAdmin = sessionUser({ id: "bil-khac", email: "qt@bil-b.local", permissions: ["platform:operate"], organization: { code: B, name: B, isHome: false } });
  const outsiders = [homeViewer, otherAdmin];

  for (const code of ORGS) await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Billing@12345" }, source: "TEST", actor: null });
  try {
    // Ba gói bán gieo bằng 0187.
    const plans = await listPlans();
    assert.deepEqual(
      ["starter", "growth", "pro"].map((k) => plans.find((p) => p.key === k)?.priceVnd),
      [499_000, 999_000, 1_990_000],
    );
    assert.equal(plans.find((p) => p.key === "trial")?.priceVnd, null, "Dùng thử không bán (null, không phải 0)");
    assert.equal((await orgBillingStanding({ code: A, isHome: false })).kind, "NOT_BILLED", "tổ chức có từ trước 0187 ⇒ không thu phí, không khoá");

    const adminA = await withOrganization(A, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) }));
    assert.ok(adminA);
    const tenant = sessionUser({ id: adminA.id, email: adminA.email, organization: { code: A, name: `Tổ chức ${A}`, isHome: false } });

    // ── Chưa khai tài khoản nhận ⇒ không tạo mã.
    assert.ok("error" in (await createRenewalInvoice(tenant, { planKey: "starter", months: 1 })));
    for (const u of outsiders) assert.ok("error" in (await setBillingReceiver(u, { bin: "970422", accountNumber: "0123456789", accountName: "CONG TY X", reason: "khai tài khoản" })), `${u.email} không khai được`);
    assert.ok("error" in (await setBillingReceiver(op, { bin: "970422", accountNumber: "0123456789", accountName: "CONG TY X", reason: "" })), "thiếu lý do");
    assert.ok("error" in (await setBillingReceiver(op, { bin: "999999", accountNumber: "0123456789", accountName: "CONG TY X", reason: "ngân hàng lạ" })));
    const rcv = await setBillingReceiver(op, { bin: "970422", accountNumber: "0123456789", accountName: "Công ty Nền Tảng", reason: "Tài khoản doanh thu nền tảng" });
    assert.ok("ok" in rcv, JSON.stringify(rcv));

    // ── Tạo mã; bấm lại không đẻ mã thứ hai; đổi lựa chọn ⇒ mã cũ VOID.
    assert.ok("error" in (await createRenewalInvoice(op, { planKey: "starter", months: 1 })), "nhà không trả phí");
    assert.ok("error" in (await createRenewalInvoice(tenant, { planKey: "internal", months: 1 })), "không mua được gói nội bộ");
    const c1 = await createRenewalInvoice(tenant, { planKey: "starter", months: 1 });
    assert.ok("ok" in c1, JSON.stringify(c1));
    const c1b = await createRenewalInvoice(tenant, { planKey: "starter", months: 1 });
    assert.ok("ok" in c1b && c1b.invoiceId === c1.invoiceId, "bấm lại ⇒ cùng hoá đơn");
    const c2 = await createRenewalInvoice(tenant, { planKey: "starter", months: 3 });
    assert.ok("ok" in c2 && c2.invoiceId !== c1.invoiceId);
    assert.equal((await invoiceById(c1.invoiceId)).status, "VOID");
    const open = await openInvoices(A);
    assert.equal(open.length, 1, "tối đa MỘT hoá đơn đang mở");
    const inv = open[0];
    assert.equal(inv.amountVnd, 1_497_000);
    assert.match(inv.transferCode, TRANSFER_CODE_PATTERN);
    const view = await loadTenantBilling(A);
    assert.ok(view?.openInvoice?.qrPayload?.includes("0123456789") && view.openInvoice.qrPayload.includes(inv.transferCode), "mã VietQR mang số tài khoản + nội dung");
    assert.equal(view?.offers.length, 3);

    // ── Tiền THIẾU ⇒ ghi, không gia hạn.
    const under = await bankIn(inv.amountVnd - 1_000, `CK ${inv.transferCode.toLowerCase()} thanh toan`);
    const r1 = await reconcileBillingPayments();
    assert.equal(r1.recorded, 1, JSON.stringify(r1));
    assert.equal((await paymentByRef(under)).outcome, "UNDERPAID");
    assert.equal((await invoiceById(inv.id)).status, "OPEN");
    assert.equal((await orgBillingStanding({ code: A, isHome: false }, new Date(), { fresh: true })).kind, "NOT_BILLED");
    const r1b = await reconcileBillingPayments();
    assert.equal(r1b.recorded, 0, "đối chiếu lại không ghi đôi");

    // ── Tiền ĐỦ ⇒ PAID + trả tới + đổi gói + nhật ký máy — một giao dịch.
    const full = await bankIn(inv.amountVnd, `MBVCB.99.${inv.transferCode}.CT`);
    const r2 = await reconcileBillingPayments();
    assert.equal(r2.matched, 1, JSON.stringify(r2));
    const paid = await invoiceById(inv.id);
    assert.ok(paid.status === "PAID" && paid.paidSource === "BANK" && paid.paidRef === full && paid.paidAmountVnd === inv.amountVnd);
    const sub = await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, A) });
    assert.ok(sub?.billingEnabled && sub.paidThrough === inv.periodEnd, JSON.stringify(sub));
    invalidateOrganizations();
    assert.equal((await findOrganization(A))?.plan, "starter", "gói đổi NGAY khi tiền về");
    const paidAudit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), eq(schema.platformAuditLog.action, "INVOICE_PAID")));
    assert.ok(paidAudit.length === 1 && paidAudit[0].actorEmail === null, "nhật ký: MÁY gia hạn");
    assert.equal((await orgBillingStanding({ code: A, isHome: false })).kind, "ACTIVE");
    assert.equal(r2.recorded, 1);
    assert.equal((await reconcileBillingPayments()).recorded, 0);

    // ── Tiền về mã đã huỷ / mã lạ / tiền RA mang mã.
    const toVoid = await bankIn(499_000, `thanh toan ${(await invoiceById(c1.invoiceId)).transferCode}`);
    const stray = await bankIn(499_000, "ERPHDZZZZZZ chuyen nham");
    await bankIn(-499_000, `hoan tien ${inv.transferCode}`);
    const r3 = await reconcileBillingPayments();
    assert.equal(r3.recorded, 2, "tiền RA không bao giờ là tiền thuê bao");
    assert.equal((await paymentByRef(toVoid)).outcome, "INVOICE_NOT_OPEN");
    assert.equal((await paymentByRef(stray)).outcome, "NO_INVOICE");
    const board = await loadPlatformBilling(op);
    assert.ok(!("error" in board));
    assert.equal(board.unresolvedPayments.filter((p) => p.bankRef.startsWith(REF)).length, 3, "thiếu tiền + mã huỷ + mã lạ đều nằm ở «Tiền chưa khớp»");
    assert.ok(board.mrrVnd >= 499_000 && board.orgs.find((o) => o.code === A)?.standing.kind === "ACTIVE");
    assert.ok("error" in (await loadPlatformBilling(otherAdmin)), "người ngoài không đọc được bảng thu phí");
    const strayRow = await paymentByRef(stray);
    for (const u of outsiders) assert.ok("error" in (await resolveBillingPayment(u, { paymentId: strayRow.id, reason: "đã hoàn tiền" })));
    assert.ok("ok" in (await resolveBillingPayment(op, { paymentId: strayRow.id, reason: "Đã hoàn tiền cho người chuyển nhầm" })));
    const board2 = await loadPlatformBilling(op);
    assert.ok(!("error" in board2) && board2.unresolvedPayments.filter((p) => p.bankRef.startsWith(REF)).length === 2);
    assert.ok((await paymentByRef(stray)).resolvedAt, "đánh dấu, không xoá");

    // ── Nâng gói giữa kỳ có trừ phần chưa dùng.
    assert.ok("error" in (await previewRenewal(A, "growth", 1)), "vừa trả 3 tháng gói thấp ⇒ phần trừ lớn hơn 1 tháng gói cao ⇒ bắt chọn nhiều tháng hơn");
    const up = await previewRenewal(A, "growth", 3);
    assert.ok(isQuote(up) && up.kind === "UPGRADE" && up.creditVnd > 0 && up.amountVnd === up.listAmountVnd - up.creditVnd, JSON.stringify(up));

    // ── CỔNG CHỈ XEM: lùi trả tới về 30 ngày trước, ân hạn 7 ⇒ LOCKED.
    const today = vnDate(new Date());
    const past = new Date(Date.now() - 30 * 86_400_000);
    for (const u of outsiders) assert.ok("error" in (await setOrgBilling(u, { orgCode: A, enabled: true, paidThrough: vnDate(past), graceDays: 7, reason: "khoá thử" })));
    assert.ok("error" in (await setOrgBilling(op, { orgCode: A, enabled: true, paidThrough: "", graceDays: 7, reason: "bật mà thiếu ngày" })));
    assert.ok("error" in (await setOrgBilling(op, { orgCode: A, enabled: true, paidThrough: today, graceDays: 99, reason: "ân hạn quá dài" })));
    assert.ok("error" in (await setOrgBilling(op, { orgCode: home.code, enabled: true, paidThrough: today, graceDays: 7, reason: "thu phí nhà" })), "nhà không thu phí");
    const lock = await setOrgBilling(op, { orgCode: A, enabled: true, paidThrough: vnDate(past), graceDays: 7, reason: "Kiểm chế độ chỉ xem" });
    assert.ok("ok" in lock, JSON.stringify(lock));
    assert.equal((await orgBillingStanding({ code: A, isHome: false })).kind, "LOCKED");

    const token = await signSession({ id: adminA.id, email: adminA.email, name: adminA.name, role: adminA.role, orgCode: A });
    const write = await asRequest(token, "POST", "/customers");
    assert.ok("denied" in write && write.denied === "BILLING_LOCKED", JSON.stringify(write));
    const read = await asRequest(token, "GET", "/customers");
    assert.ok("user" in read, "chỉ xem nghĩa là XEM được");
    const pay = await asRequest(token, "POST", "/settings/plan");
    assert.ok("user" in pay, "trang gia hạn ghi được khi đang khoá");
    const job = (await runJob("creative-loop", { trigger: "CRON", actor: "bil-test", org: A })) as { skipped?: string };
    assert.equal(job.skipped, "BILLING_LOCKED", JSON.stringify(job));
    // Tổ chức B (không thu phí) không bị chạm.
    assert.equal((await orgBillingStanding({ code: B, isHome: false })).kind, "NOT_BILLED");

    // Khách tạo mã khi đang khoá ⇒ kỳ tính từ HÔM NAY; người vận hành xác nhận tay ⇒ mở ngay.
    const c3 = await createRenewalInvoice(tenant, { planKey: "growth", months: 1 });
    assert.ok("ok" in c3, JSON.stringify(c3));
    const inv3 = await invoiceById(c3.invoiceId);
    assert.equal(inv3.periodStart, today, "đã khoá ⇒ không bắt trả những ngày bị khoá");
    for (const u of outsiders) assert.ok("error" in (await markInvoicePaidManually(u, { invoiceId: inv3.id, amountVnd: inv3.amountVnd, ref: "x", reason: "mở hộ khách" })));
    assert.ok("error" in (await markInvoicePaidManually(op, { invoiceId: inv3.id, amountVnd: 0, ref: "x", reason: "số tiền sai" })));
    const manual = await markInvoicePaidManually(op, { invoiceId: inv3.id, amountVnd: inv3.amountVnd, ref: "UNC-ACB-778", reason: "Khách chuyển sang ACB, đã kiểm sao kê" });
    assert.ok("ok" in manual, JSON.stringify(manual));
    assert.ok("error" in (await markInvoicePaidManually(op, { invoiceId: inv3.id, amountVnd: inv3.amountVnd, ref: "x", reason: "bấm lần hai" })), "hoá đơn đã trả không xác nhận lại");
    assert.equal((await orgBillingStanding({ code: A, isHome: false })).kind, "ACTIVE");
    invalidateOrganizations();
    assert.equal((await findOrganization(A))?.plan, "growth");
    const write2 = await asRequest(token, "POST", "/customers");
    assert.ok("user" in write2, "trả xong ⇒ ghi lại được ngay");
    const job2 = (await runJob("creative-loop", { trigger: "CRON", actor: "bil-test", org: A })) as { skipped?: string };
    assert.notEqual(job2.skipped, "BILLING_LOCKED");
    const manualAudit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), eq(schema.platformAuditLog.action, "INVOICE_PAID")));
    assert.ok(manualAudit.some((r) => r.actorEmail === op.email && r.reason === "Khách chuyển sang ACB, đã kiểm sao kê"));

    // Huỷ hoá đơn: chỉ người vận hành, chỉ hoá đơn đang mở.
    const c4 = await createRenewalInvoice(tenant, { planKey: "growth", months: 1 });
    assert.ok("ok" in c4);
    for (const u of outsiders) assert.ok("error" in (await voidInvoice(u, { invoiceId: c4.invoiceId, reason: "huỷ hộ" })));
    assert.ok("ok" in (await voidInvoice(op, { invoiceId: c4.invoiceId, reason: "Khách đổi ý" })));
    assert.ok("error" in (await voidInvoice(op, { invoiceId: c4.invoiceId, reason: "Huỷ lần hai" })));

    // Giá gói: chỉ người vận hành, không bán gói nội bộ, chặn giá vô lý; hoá đơn mới dùng giá mới.
    for (const u of outsiders) assert.ok("error" in (await setPlanPrice(u, { planKey: "starter", priceVnd: 1, reason: "giảm giá" })));
    assert.ok("error" in (await setPlanPrice(op, { planKey: "internal", priceVnd: 100_000, reason: "bán gói nội bộ" })));
    assert.ok("error" in (await setPlanPrice(op, { planKey: "starter", priceVnd: 5, reason: "giá vô lý" })));
    assert.ok("ok" in (await setPlanPrice(op, { planKey: "starter", priceVnd: 599_000, reason: "Chốt bảng giá mới" })));
    const q = await previewRenewal(A, "starter", 1);
    assert.ok(isQuote(q) && q.listAmountVnd === 599_000);

    // Tắt thu phí ⇒ không nhắc, không khoá.
    assert.ok("ok" in (await setOrgBilling(op, { orgCode: A, enabled: false, paidThrough: vnDate(past), graceDays: 7, reason: "Khách chuyển sang hợp đồng năm" })));
    assert.equal((await orgBillingStanding({ code: A, isHome: false })).kind, "NOT_BILLED");
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    setRequestMethodSourceForTests(null);
    await cleanup(savedReceiver, savedPrices);
  }
  console.log(
    "✓ Thu phí thuê bao: bảng chân lý tình trạng (7 ngày · ân hạn · khoá) + báo giá (bắt đầu · gia hạn · nối ân hạn · dùng thử · nâng có trừ · hạ) + mã chuyển khoản chịu được ngân hàng đổi chữ; vòng tiền thật: chưa khai tài khoản nhận ⇒ không tạo mã, bấm lại không đẻ mã thứ hai, đổi lựa chọn ⇒ mã cũ huỷ, tiền thiếu ghi mà không gia hạn, tiền đủ ⇒ trả tới + đổi gói + nhật ký trong một giao dịch, đối chiếu lại không đếm đôi, mã huỷ / mã lạ / tiền ra đúng phán quyết; quá hạn ⇒ ghi bị chặn, đọc + trang gia hạn vẫn đi, job dừng, xác nhận tay mở ngay; người ngoài bị từ chối mọi thao tác",
  );
}
