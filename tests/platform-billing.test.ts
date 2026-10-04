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
 *  5. MUA THÊM + HOÁ ĐƠN VAT (0192): bảng chân lý báo giá theo ngày còn lại (chưa vào kỳ · quá hạn · bước · làm tròn
 *     xuống), giá gia hạn cộng phần mua thêm và nâng / hạ so bằng TỔNG, mã số thuế ba dạng; vòng tiền thật: gói chưa khai
 *     giá ⇒ không bán, tiền đủ ⇒ cộng hạn mức NGAY mà không đổi ngày trả tới / gói, gói đích không bán phần đang có ⇒ báo
 *     lỗi chứ không đoán giá, thông tin VAT chụp vào hoá đơn, người vận hành ghi số hoá đơn đã xuất đúng một lần.
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
  billingNotice,
  TRIAL_DAYS,
  TRIAL_WARN_DAYS_LEFT,
  TRIAL_GRACE_DAYS,
  trialPaidThrough,
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
import { addonMonthlyVnd, applyAddons, parseAddonPrices, parseInvoiceInfo, quoteAddon, type AddonQuote } from "@/lib/billing/addons";
import { createAddonInvoice, markVatIssued, previewAddon, setInvoiceInfo, setOrgAddons, setPlanAddonPrices } from "@/lib/billing/service";
import { getPlanUsage, listPlans } from "@/lib/entitlements/check";
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

function isAddonQuote(q: AddonQuote | { error: string }): q is AddonQuote {
  return !("error" in q);
}

/** Đơn giá mua thêm của các gói lúc bắt đầu — trả lại nguyên trạng khi dọn. */
let savedAddonPrices = new Map<string, unknown>();

// ═══════════ 5 · MUA THÊM + VAT — THUẦN ═══════════

function testAddonsPure() {
  const limits = { users: 5, pages: 10, objects: 5, records: 5000, workflows: null, aiDraftsPerDay: 20, storageMb: 1024 };
  const eff = applyAddons(limits, { users: 2, workflows: 5, storageMb: 1024 });
  assert.equal(eff.users, 7);
  assert.equal(eff.workflows, null, "gói không giới hạn vẫn là không giới hạn");
  assert.equal(eff.storageMb, 2048);
  assert.equal(eff.records, 5000, "không mua thì giữ nguyên");

  const prices = parseAddonPrices({ users: 30_000, storageMb: 20_000, pages: 5, records: "x", aiDraftsPerDay: 10_000 });
  assert.deepEqual(prices, { users: 30_000, storageMb: 20_000 }, "giá ngoài khoảng / sai kiểu / hạng mục không bán ⇒ không bán");
  assert.deepEqual(addonMonthlyVnd({ users: 2, storageMb: 2048 }, prices), { ok: true, vnd: 100_000 });
  assert.deepEqual(addonMonthlyVnd({ users: 2, objects: 1 }, prices), { ok: false, missing: ["objects"] }, "phần đang có mà gói không bán ⇒ nói ra, không đoán");

  // Báo giá: trả tới 2026-10-20, hôm nay 2026-10-11 ⇒ 10 ngày (tính cả hôm nay).
  const active = { billingEnabled: true, paidThrough: "2026-10-20", graceDays: 7 };
  const q = quoteAddon({ terms: active, planName: "Khởi đầu", kind: "users", blocks: 2, prices, today: "2026-10-11" });
  assert.ok(isAddonQuote(q), JSON.stringify(q));
  assert.equal(q.days, 10);
  assert.equal(q.units, 2);
  assert.equal(q.monthlyVnd, 60_000);
  assert.equal(q.amountVnd, 20_000);
  assert.equal(q.periodStart, "2026-10-11");
  assert.equal(q.periodEnd, "2026-10-20");
  const odd = quoteAddon({ terms: active, planName: "x", kind: "users", blocks: 1, prices: { users: 10_000 }, today: "2026-10-20" });
  assert.ok(isAddonQuote(odd) && odd.amountVnd === 333, "làm tròn XUỐNG (10.000 / 30 = 333,3)");
  const gb = quoteAddon({ terms: active, planName: "x", kind: "storageMb", blocks: 3, prices, today: "2026-10-11" });
  assert.ok(isAddonQuote(gb) && gb.units === 3 * 1024, "bước dung lượng = 1 GB");
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "objects", blocks: 1, prices, today: "2026-10-11" }), "gói không khai giá ⇒ không bán");
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "aiDraftsPerDay", blocks: 1, prices, today: "2026-10-11" }), "trần mỗi ngày không bán thêm");
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "users", blocks: 0, prices, today: "2026-10-11" }));
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "users", blocks: 101, prices, today: "2026-10-11" }));
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "users", blocks: 1.5, prices, today: "2026-10-11" }));
  assert.ok("error" in quoteAddon({ terms: null, planName: "x", kind: "users", blocks: 1, prices, today: "2026-10-11" }), "chưa vào kỳ trả phí");
  assert.ok("error" in quoteAddon({ terms: { ...active, billingEnabled: false }, planName: "x", kind: "users", blocks: 1, prices, today: "2026-10-11" }), "dùng thử chưa bật thu phí");
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "users", blocks: 1, prices, today: "2026-10-22" }), "quá hạn ⇒ gia hạn trước");
  assert.ok("error" in quoteAddon({ terms: active, planName: "x", kind: "users", blocks: 1, prices, today: "2026-11-30" }), "đã khoá");

  // Gia hạn cộng phần mua thêm; nâng / hạ so bằng TỔNG tiền tháng.
  const starter = { key: "starter", name: "Khởi đầu", priceVnd: 499_000 };
  const growth = { key: "growth", name: "Tăng trưởng", priceVnd: 999_000 };
  const r1 = quoteRenewal({ terms: active, currentPlan: starter, target: starter, months: 3, today: "2026-10-11", targetAddonMonthlyVnd: 60_000, currentAddonMonthlyVnd: 60_000 });
  assert.ok(isQuote(r1) && r1.listAmountVnd === 1_677_000 && r1.addonMonthlyVnd === 60_000 && r1.kind === "RENEW", JSON.stringify(r1));
  const r2 = quoteRenewal({ terms: active, currentPlan: starter, target: growth, months: 1, today: "2026-10-11", targetAddonMonthlyVnd: 0, currentAddonMonthlyVnd: 600_000 });
  assert.ok(isQuote(r2) && r2.kind === "DOWNGRADE", "gói + mua thêm 1.099.000 > gói cao hơn 999.000 ⇒ là HẠ, không trừ tiền");
  const r3 = quoteRenewal({ terms: active, currentPlan: starter, target: growth, months: 3, today: "2026-10-11", currentAddonMonthlyVnd: 60_000 });
  assert.ok(isQuote(r3) && r3.kind === "UPGRADE" && r3.creditVnd === Math.floor((559_000 * 10) / 30), "phần trừ tính cả phần mua thêm đang trả");

  // Thông tin xuất hoá đơn: ba dạng mã số thuế.
  const base = { companyName: "Công ty TNHH Hải Sản Làng Chài", address: "Số 1, phường Hồng Hải, Quảng Ninh", email: "KeToan@HSLC.vn" };
  for (const taxCode of ["0101234567", "0101234567-001", "001099012345", " 0101 234 567 "]) {
    const r = parseInvoiceInfo({ ...base, taxCode });
    assert.ok("ok" in r, `${taxCode}: ${JSON.stringify(r)}`);
  }
  const ok = parseInvoiceInfo({ ...base, taxCode: "0101234567" });
  assert.ok("ok" in ok && ok.info.email === "ketoan@hslc.vn", "email viết thường");
  for (const bad of [{ ...base, taxCode: "010123456" }, { ...base, taxCode: "0101234567-1" }, { ...base, taxCode: "0101234567", email: "ketoan" }, { ...base, taxCode: "0101234567", companyName: "" }, { ...base, taxCode: "0101234567", address: "HN" }]) {
    assert.ok("error" in parseInvoiceInfo(bad), JSON.stringify(bad));
  }
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

  // Dùng thử 7 ngày (chủ nền tảng chốt 04/10/2026; đăng ký 2026-10-04): ngày cuối 10/10, ân hạn 3 ⇒ chỉ xem từ 14/10.
  // Dải nhắc luôn hiện khi dùng thử; chỉ vàng khi còn ≤ TRIAL_WARN_DAYS_LEFT ngày.
  assert.equal(TRIAL_DAYS, 7);
  assert.equal(trialPaidThrough("2026-10-04"), "2026-10-10", "tính cả ngày đăng ký");
  const tr = { billingEnabled: true, paidThrough: trialPaidThrough("2026-10-04"), graceDays: TRIAL_GRACE_DAYS };
  const nt = (today: string) => billingNotice(billingStanding(tr, today), true);
  assert.deepEqual([nt("2026-10-04")?.tone, nt("2026-10-04")?.text.includes(`còn ${TRIAL_DAYS} ngày`)], ["info", true], "ngày đầu: còn đủ số ngày dùng thử, chưa vàng");
  assert.equal(TRIAL_WARN_DAYS_LEFT, 3);
  assert.equal(nt("2026-10-07")?.tone, "info", "còn 4 ngày ⇒ chưa vàng");
  assert.equal(nt("2026-10-08")?.tone, "warn", "còn 3 ngày ⇒ vàng");
  assert.ok(nt("2026-10-10")?.text.includes("còn 1 ngày"), "ngày cuối");
  assert.ok(nt("2026-10-11")?.tone === "danger" && nt("2026-10-11")?.text.includes("14/10/2026"), "ân hạn: nói ngày chuyển chỉ xem");
  assert.equal(billingStanding(tr, "2026-10-13").kind, "OVERDUE");
  assert.equal(billingStanding(tr, "2026-10-14").kind, "LOCKED");
  assert.ok(nt("2026-10-14")?.text.includes("Dữ liệu vẫn giữ nguyên") && nt("2026-10-14")?.cta === "Chọn gói");
  // Thuê bao trả tiền: chỉ nhắc khi còn ≤ 7 ngày; không thu phí ⇒ không bao giờ có dải.
  assert.equal(billingNotice(billingStanding(t, "2026-10-01"), false), null, "còn hạn dài ⇒ im lặng");
  assert.equal(billingNotice(billingStanding(t, "2026-10-15"), false)?.cta, "Gia hạn");
  assert.equal(billingNotice(billingStanding(null, "2026-10-15"), true), null, "chưa bật thu phí ⇒ không dải, kể cả gói trial");

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
  for (const [key, prices] of savedAddonPrices) await pdb.update(schema.platformPlans).set({ addonPrices: (prices ?? {}) as Record<string, unknown> }).where(eq(schema.platformPlans.key, key));
  const home = await getHomeOrganization();
  await pdb.delete(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, home.code), inArray(schema.platformAuditLog.action, ["BILLING_RECEIVER_SET", "PLAN_PRICE_SET", "BILLING_PAYMENT_RESOLVE", "ADDON_PRICE_SET"])));
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
  testAddonsPure();
  const pdb = await getPlatformDb();
  savedAddonPrices = new Map((await pdb.select({ key: schema.platformPlans.key, addonPrices: schema.platformPlans.addonPrices }).from(schema.platformPlans)).map((r) => [r.key, r.addonPrices]));
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
    assert.equal(view?.offers.length, 4, "bốn gói bán: Cơ bản (0194) + ba gói của 0187");

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

    // ── 5 · MUA THÊM giữa kỳ (A đang trả gói Khởi đầu, còn hạn ~3 tháng). 0194 gieo đơn giá — gỡ hết trước để kiểm nhánh
    // «chưa khai giá ⇒ không bán».
    assert.ok("ok" in (await setPlanAddonPrices(op, { planKey: "starter", prices: {}, reason: "Gỡ đơn giá để kiểm thử" })));
    assert.ok("error" in (await previewAddon(A, { kind: "users", blocks: 2 })), "gói chưa khai giá mua thêm ⇒ không bán");
    for (const u of outsiders) assert.ok("error" in (await setPlanAddonPrices(u, { planKey: "starter", prices: { users: 30_000 }, reason: "mở bán thêm" })));
    assert.ok("error" in (await setPlanAddonPrices(op, { planKey: "starter", prices: { users: 500 }, reason: "giá vô lý" })));
    assert.ok("error" in (await setPlanAddonPrices(op, { planKey: "starter", prices: { aiDraftsPerDay: 10_000 }, reason: "hạng mục không bán" })));
    assert.ok("error" in (await setPlanAddonPrices(op, { planKey: "internal", prices: { users: 30_000 }, reason: "bán gói nội bộ" })));
    assert.ok("ok" in (await setPlanAddonPrices(op, { planKey: "starter", prices: { users: 30_000, storageMb: 20_000, pages: null }, reason: "Mở bán thêm cho gói Khởi đầu" })));
    assert.deepEqual(parseAddonPrices((await listPlans()).find((p) => p.key === "starter")?.addonPrices), { users: 30_000, storageMb: 20_000 });

    const subBefore = await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, A) });
    const aq = await previewAddon(A, { kind: "users", blocks: 2 });
    assert.ok(isAddonQuote(aq), JSON.stringify(aq));
    assert.equal(aq.periodEnd, subBefore?.paidThrough, "tính tới đúng ngày đã trả tới");
    assert.equal(aq.amountVnd, Math.floor((60_000 * aq.days) / 30));
    const usersLimitBefore = (await getPlanUsage(A)).rows.find((r) => r.kind === "users")?.limit;
    assert.equal(usersLimitBefore, 5);

    // Thông tin xuất hoá đơn: chưa khai mà đòi VAT ⇒ từ chối; MST sai ⇒ từ chối.
    assert.ok("error" in (await createAddonInvoice(tenant, { kind: "users", blocks: 2, vat: true })), "chưa khai thông tin xuất hoá đơn");
    assert.ok("error" in (await setInvoiceInfo(tenant, { info: { companyName: "Công ty A", taxCode: "123", address: "Số 1 Hà Nội", email: "a@a.vn" } })));
    assert.ok("error" in (await setInvoiceInfo(op, { info: { companyName: "Công ty A", taxCode: "0101234567", address: "Số 1 Hà Nội", email: "a@a.vn" } })), "nhà không có hoá đơn thuê bao");
    assert.ok("ok" in (await setInvoiceInfo(tenant, { info: { companyName: "Công ty A", taxCode: "0101234567", address: "Số 1 Hà Nội", email: "ketoan@a.vn" } })));

    const ad1 = await createAddonInvoice(tenant, { kind: "users", blocks: 2, vat: true });
    assert.ok("ok" in ad1, JSON.stringify(ad1));
    const ad1b = await createAddonInvoice(tenant, { kind: "users", blocks: 2, vat: true });
    assert.ok("ok" in ad1b && ad1b.invoiceId === ad1.invoiceId, "bấm lại ⇒ cùng hoá đơn");
    const adInv = await invoiceById(ad1.invoiceId);
    assert.ok(adInv.kind === "ADDON" && adInv.months === 0 && adInv.addonKind === "users" && adInv.addonUnits === 2 && adInv.amountVnd === aq.amountVnd, JSON.stringify(adInv));
    assert.equal((adInv.invoiceInfo as { taxCode?: string } | null)?.taxCode, "0101234567", "thông tin VAT CHỤP vào hoá đơn");
    await bankIn(adInv.amountVnd, `IBFT ${adInv.transferCode}`);
    const rAdd = await reconcileBillingPayments();
    assert.equal(rAdd.matched, 1, JSON.stringify(rAdd));
    const subAfter = await pdb.query.platformSubscriptions.findFirst({ where: eq(schema.platformSubscriptions.orgCode, A) });
    assert.deepEqual(subAfter?.addons, { users: 2 });
    assert.equal(subAfter?.paidThrough, subBefore?.paidThrough, "mua thêm KHÔNG đổi ngày trả tới");
    invalidateOrganizations();
    assert.equal((await findOrganization(A))?.plan, "starter", "mua thêm KHÔNG đổi gói");
    const usage = await getPlanUsage(A);
    assert.equal(usage.rows.find((r) => r.kind === "users")?.limit, 7, "hạn mức tăng NGAY: 5 + 2");
    assert.deepEqual(usage.plan?.addons, { users: 2 });

    // Gia hạn cộng phần mua thêm theo giá của gói ĐÍCH; gói đích không bán ⇒ báo lỗi, không đoán.
    const ren = await previewRenewal(A, "starter", 1);
    assert.ok(isQuote(ren) && ren.listAmountVnd === 499_000 + 60_000 && ren.addonMonthlyVnd === 60_000, JSON.stringify(ren));
    const toGrowthPriced = await previewRenewal(A, "growth", 3);
    assert.ok(isQuote(toGrowthPriced) && toGrowthPriced.addonMonthlyVnd === 2 * 69_000, "gói đích CÓ bán ⇒ tính theo đơn giá của gói đích (0194: 69.000 / người)");
    assert.ok("ok" in (await setPlanAddonPrices(op, { planKey: "growth", prices: {}, reason: "Gỡ đơn giá để kiểm thử" })));
    const toGrowth = await previewRenewal(A, "growth", 3);
    assert.ok("error" in toGrowth && toGrowth.error.includes("người dùng"), JSON.stringify(toGrowth));
    const tb = await loadTenantBilling(A);
    assert.ok(tb && tb.addonMonthlyVnd === 60_000 && tb.addons[0]?.units === 2 && tb.addonBlockedReason === null && tb.addonOffers.length === 2 && tb.invoiceInfo?.taxCode === "0101234567", JSON.stringify(tb?.addons));

    // VAT: người vận hành thấy khoản chờ xuất, ghi số hoá đơn đúng một lần.
    const vb = await loadPlatformBilling(op);
    assert.ok(!("error" in vb) && vb.vatPending.some((i) => i.id === adInv.id), "khoản đã thu có yêu cầu VAT nằm ở «Cần xuất hoá đơn VAT»");
    assert.ok(!("error" in vb) && vb.orgs.find((o) => o.code === A)?.addonMonthlyVnd === 60_000);
    for (const u of outsiders) assert.ok("error" in (await markVatIssued(u, { invoiceId: adInv.id, vatRef: "1C26TAA-1" })));
    assert.ok("error" in (await markVatIssued(op, { invoiceId: adInv.id, vatRef: "" })));
    assert.ok("error" in (await markVatIssued(op, { invoiceId: inv.id, vatRef: "1C26TAA-9" })), "khoản không yêu cầu VAT");
    assert.ok("ok" in (await markVatIssued(op, { invoiceId: adInv.id, vatRef: "1C26TAA-0000123" })));
    const again = await markVatIssued(op, { invoiceId: adInv.id, vatRef: "1C26TAA-0000999" });
    assert.ok("ok" in again && (await invoiceById(adInv.id)).vatRef === "1C26TAA-0000123", "ghi lần hai không đè số đã ghi");
    const vb2 = await loadPlatformBilling(op);
    assert.ok(!("error" in vb2) && !vb2.vatPending.some((i) => i.id === adInv.id));

    // Người vận hành sửa phần đã mua (tặng / bớt) — hiệu lực ngay; về 0 thì gia hạn sang gói khác lại được.
    for (const u of outsiders) assert.ok("error" in (await setOrgAddons(u, { orgCode: A, blocks: { users: 5 }, reason: "tặng thêm" })));
    assert.ok("error" in (await setOrgAddons(op, { orgCode: A, blocks: { users: -1 }, reason: "số âm" })));
    assert.ok("ok" in (await setOrgAddons(op, { orgCode: A, blocks: { users: 3 }, reason: "Tặng thêm 1 người dùng tháng đầu" })));
    assert.equal((await getPlanUsage(A)).rows.find((r) => r.kind === "users")?.limit, 8);
    assert.ok("ok" in (await setOrgAddons(op, { orgCode: A, blocks: { users: 0 }, reason: "Khách xin bớt từ kỳ sau" })));
    assert.equal((await getPlanUsage(A)).rows.find((r) => r.kind === "users")?.limit, 5);
    assert.ok(isQuote(await previewRenewal(A, "growth", 3)), "hết phần mua thêm ⇒ đổi gói lại được");
    const addonAudit = await pdb.select().from(schema.platformAuditLog).where(and(eq(schema.platformAuditLog.targetOrgCode, A), inArray(schema.platformAuditLog.action, ["ORG_ADDONS_SET", "INVOICE_INFO_SET", "INVOICE_VAT_ISSUED"])));
    assert.equal(addonAudit.length, 4, "hai lượt sửa phần mua thêm + khai thông tin hoá đơn + ghi hoá đơn VAT đều vào nhật ký");

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
    "✓ Thu phí thuê bao: mua thêm giữa kỳ (theo ngày còn lại, làm tròn xuống, cộng hạn mức ngay mà không đổi ngày trả tới / gói, gia hạn tính phần mua thêm theo giá gói đích, gói đích không bán ⇒ báo lỗi) + thông tin VAT chụp vào hoá đơn và ghi số hoá đơn đã xuất đúng một lần; bảng chân lý tình trạng (7 ngày · ân hạn · khoá) + báo giá (bắt đầu · gia hạn · nối ân hạn · dùng thử · nâng có trừ · hạ) + mã chuyển khoản chịu được ngân hàng đổi chữ; vòng tiền thật: chưa khai tài khoản nhận ⇒ không tạo mã, bấm lại không đẻ mã thứ hai, đổi lựa chọn ⇒ mã cũ huỷ, tiền thiếu ghi mà không gia hạn, tiền đủ ⇒ trả tới + đổi gói + nhật ký trong một giao dịch, đối chiếu lại không đếm đôi, mã huỷ / mã lạ / tiền ra đúng phán quyết; quá hạn ⇒ ghi bị chặn, đọc + trang gia hạn vẫn đi, job dừng, xác nhận tay mở ngay; người ngoài bị từ chối mọi thao tác",
  );
}
