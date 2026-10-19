/**
 * ═══════ ĐỐI SOÁT LỢI NHUẬN TÍNH LƯƠNG + DUYỆT HAI CẤP THƯỞNG % LỢI NHUẬN (Payroll V2 vận hành) ═══════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9. Phần THUẦN (`lib/payroll/profit-reconciliation.ts`) chạy ở
 * đây; phần NỐI (chặn chốt kỳ khi chưa ký · chữ ký cũ không áp · người ký không được duyệt) chạy trong
 * luồng thật của `tests/payroll-code-ledger.test.ts` qua `kySoatThang`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMonthReconciliation, profitBonusStage, reconFingerprintKey, type MonthReconInput } from "@/lib/payroll/profit-reconciliation";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import { getMonthReconciliation, loadProfitSignoffs } from "@/lib/queries/payroll-reconciliation";
import { PAYROLL_PROFIT_SIGNOFF_KEY, type ProfitReconSignoff } from "@/lib/constants/payroll-reconciliation";
import { setSettingJson } from "@/lib/settings";

const TR = 1_000_000;
const goc = (): MonthReconInput => ({
  monthKey: "2029-03",
  basis: {
    revenue: 100 * TR,
    cogs: 30 * TR,
    adsCodeWithMarketer: 20 * TR,
    adsCodeNoMarketer: 0,
    adsTestWithMarketer: 2 * TR,
    adsTestNoMarketer: 0,
    shippingPerShipment: 5 * TR,
    logisticsAdjustment: 0,
    logisticsAdjustmentUnallocated: 0,
    operatingEntered: 10 * TR,
    operatingAllocToCodes: 10 * TR,
    fixedCostAssumption: 0,
    perOrderOpsEstimate: 0,
    sharedUnallocated: 0,
    profit: 33 * TR,
    basisExclusionMeasured: 0,
    basisExclusionEstimated: 0,
  },
  engine: { cogs: 30 * TR, ads: 22 * TR, shipping: 5 * TR, returnCost: 0, operatingTotal: 10 * TR },
  orders: {
    deliveredRevenue: 100 * TR,
    deliveredRevenueWithMoney: 100 * TR,
    deliveredOrders: 200,
    deliveredOrdersWithMoney: 200,
    openOrders: 0,
    openValue: 0,
    settledValue: 120 * TR,
    returnedOrders: 30,
    cancelledOrders: 5,
    unknownCostLines: 0,
    unknownCostRevenue: 0,
    sentNoFeeOrders: 0,
  },
  costWarnings: [],
  codes: [
    { productId: "A", code: "A", hasCustomId: true, revenue: 60 * TR, profit: 20 * TR, unknownCostLines: 0, adsNoMarketer: 0, assigned: true },
    { productId: "B", code: "B", hasCustomId: true, revenue: 40 * TR, profit: 13 * TR, unknownCostLines: 0, adsNoMarketer: 0, assigned: false },
  ],
});
const Q = "period=custom&from=2029-03-01&to=2029-03-31";

function testPure() {
  /* ── Tháng sạch: mọi dòng khớp ⇒ ĐÃ ĐỐI SOÁT, độ phủ 100% ── */
  const sach = buildMonthReconciliation(goc(), Q);
  assert.equal(sach.status, "RECONCILED", "mọi dòng khớp nguồn ⇒ đã đối soát");
  assert.equal(sach.issues.length, 0);
  assert.equal(sach.coverage.revenueWithMoneyPct, 1);
  assert.equal(sach.coverage.revenueSettledPct, 1);
  assert.equal(sach.coverage.costReconciledPct, 1);
  assert.deepEqual(sach.codes, { total: 2, withCustomId: 2, profitComplete: 2, assigned: 1, withProfit: 2 });
  assert.equal(sach.classes.BY_CODE, 30 * TR + 20 * TR + 5 * TR + 10 * TR, "chi phí theo mã = giá vốn + QC gắn mã + cước + vận hành chia xuống mã");
  assert.equal(sach.classes.SHARED, 2 * TR, "QC test có người chịu là chi phí CHUNG");
  assert.equal(buildMonthReconciliation(goc(), Q).fingerprint, sach.fingerprint, "hàm thuần — cùng số ⇒ cùng dấu vân tay");

  /* ── Mỗi loại thiếu căn cứ ⇒ CHƯA ĐỐI SOÁT, và nói đúng khoản ── */
  const lech = (f: (x: MonthReconInput) => void) => {
    const x = goc();
    f(x);
    return buildMonthReconciliation(x, Q);
  };
  const thieuTien = lech((x) => {
    x.orders.deliveredRevenueWithMoney = 90 * TR;
    x.orders.deliveredOrdersWithMoney = 180;
  });
  assert.equal(thieuTien.status, "UNRECONCILED", "đơn đã giao chưa có chứng từ tiền ⇒ doanh thu chưa xác minh");
  assert.equal(thieuTien.coverage.revenueWithMoneyPct, 0.9);
  assert.ok(thieuTien.lines.find((l) => l.key === "revenue")?.note.includes("20 đơn"));
  const dangDi = lech((x) => {
    x.orders.openOrders = 12;
    x.orders.openValue = 30 * TR;
  });
  assert.ok(dangDi.issues.some((i) => i.code === "open-orders" && i.count === 12), "đơn chưa kết thúc ⇒ tháng chưa chín");
  assert.equal(dangDi.coverage.revenueSettledPct, 0.8);
  const giaVon0 = lech((x) => {
    x.orders.unknownCostLines = 7;
    x.orders.unknownCostRevenue = 3 * TR;
    x.codes[1].unknownCostLines = 7;
  });
  assert.ok(giaVon0.issues.some((i) => i.code === "cogs" && i.count === 7), "dòng hàng không có giá vốn (đang tính 0 ₫) ⇒ chưa đối soát");
  assert.equal(giaVon0.codes.profitComplete, 1, "mã có dòng thiếu giá vốn KHÔNG tính là đủ dữ liệu lợi nhuận");
  const qcKhongAi = lech((x) => {
    x.basis.adsTestNoMarketer = 1 * TR;
    x.engine.ads = 23 * TR;
  });
  assert.equal(qcKhongAi.classes.UNKNOWN_SOURCE, 1 * TR, "QC không mã, không người ⇒ chưa xác định nguồn");
  assert.ok(qcKhongAi.issues.some((i) => i.code === "ads-test-nomk"));
  const qcLech = lech((x) => {
    x.engine.ads = 25 * TR;
  });
  assert.ok(qcLech.issues.some((i) => i.code === "ads"), "tổng QC cơ sở lệch máy chi phí ⇒ chưa đối soát");
  const phiHoan = lech((x) => {
    x.engine.returnCost = 4 * TR;
  });
  assert.equal(phiHoan.classes.NOT_IN_BASIS, 4 * TR, "phí chiều hoàn có thật mà chưa vào cơ sở lương");
  assert.ok(phiHoan.issues.some((i) => i.code === "return-cost"));
  const luongCung = lech((x) => {
    x.costWarnings = [{ rule: "PAYROLL_OBLIGATION_NOT_RECOGNIZED", title: "Lương cứng chưa ghi nhận", amount: 8 * TR }];
  });
  assert.equal(luongCung.classes.NOT_IN_BASIS, 8 * TR);
  assert.ok(luongCung.issues.some((i) => i.code === "warn:PAYROLL_OBLIGATION_NOT_RECOGNIZED"));
  const khongCuoc = lech((x) => {
    x.orders.sentNoFeeOrders = 3;
  });
  assert.ok(khongCuoc.issues.some((i) => i.code === "shipping" && i.count === 3), "kiện đã gửi không có cước (tính 0 ₫)");
  const khongMaHang = lech((x) => {
    x.codes[1].hasCustomId = false;
  });
  assert.ok(khongMaHang.issues.some((i) => i.code === "code-no-custom-id" && i.count === 1));
  // Ước tính KHÔNG phải số đo: không được tính vào "đã khớp", nhưng tự nó không phải lỗi.
  const uocTinh = lech((x) => {
    x.basis.fixedCostAssumption = 5 * TR;
  });
  assert.equal(uocTinh.lines.find((l) => l.key === "fixed-assumption")?.status, "ESTIMATED");
  assert.ok((uocTinh.coverage.costReconciledPct ?? 1) < 1, "chi phí GIẢ ĐỊNH không đếm là khớp nguồn");
  assert.equal(uocTinh.status, "RECONCILED", "ước tính có nhãn, không tự là khoản chưa đối soát");
  // Số đổi ⇒ dấu vân tay đổi ⇒ chữ ký cũ không còn áp.
  assert.notEqual(dangDi.fingerprint, sach.fingerprint);
  assert.notEqual(reconFingerprintKey(dangDi.fingerprint), reconFingerprintKey(sach.fingerprint));
  // Mẫu số 0 ⇒ chưa đo được (null), không phải 0% hay 100%.
  const rong = lech((x) => {
    x.orders = { ...x.orders, deliveredRevenue: 0, deliveredRevenueWithMoney: 0, settledValue: 0, openValue: 0 };
    x.basis.revenue = 0;
  });
  assert.equal(rong.coverage.revenueWithMoneyPct, null);
  assert.equal(rong.coverage.revenueSettledPct, null);

  /* ── Năm nấc trạng thái khoản thưởng ── */
  assert.equal(profitBonusStage({ eligible: null, established: false, runStatus: null, paid: false }), "PROVISIONAL");
  assert.equal(profitBonusStage({ eligible: 0, established: true, runStatus: "CALCULATED", paid: false }), "NOT_ELIGIBLE");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "CALCULATED", paid: false }), "ELIGIBLE");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "APPROVED", paid: false }), "APPROVED");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "LOCKED", paid: false }), "APPROVED");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "PAID", paid: true }), "PAID");
  assert.equal(profitBonusStage({ eligible: 0, established: true, runStatus: "PAID", paid: true }), "NOT_ELIGIBLE", "kỳ đã trả nhưng khoản không đủ điều kiện ⇒ không có gì được trả");

  /* ── Điều kiện chốt: cần ký khi có khoản đủ điều kiện, không cần khi không có ── */
  const chan = (rc: { required: boolean; signed: boolean }) =>
    payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitRecon: { ...rc, monthKey: "2029-03", status: "UNRECONCILED", issueCount: 2 } }).some((b) => b.code === "PROFIT_RECON_NOT_SIGNED");
  assert.equal(chan({ required: true, signed: false }), true, "có thưởng đủ điều kiện, chưa ký ⇒ chặn chốt");
  assert.equal(chan({ required: true, signed: true }), false);
  assert.equal(chan({ required: false, signed: false }), false, "không có khoản đủ điều kiện ⇒ lương cứng không bị giữ vì bảng đối soát");
}

function testSourceFences() {
  const lib = readFileSync("lib/payroll/profit-reconciliation.ts", "utf8");
  assert.ok(!/from "@\/db"|getDb|new Date\(\)/.test(lib), "phép dựng đối soát là hàm THUẦN");
  const q = readFileSync("lib/queries/payroll-reconciliation.ts", "utf8");
  assert.ok(/ORDER_OUTCOME_FAST/.test(q) && /LINE_UNIT_COST/.test(q) && /PRIMARY_ATTEMPT/.test(q) && /REVENUE_RECOGNIZED_ON_DELIVERY/.test(q), "đo trên đơn bằng CHÍNH biểu thức của cơ sở lương — không viết luật kết quả đơn thứ hai");
  assert.ok(/getRecognizedCosts/.test(q) && /getPayrollReport/.test(q), "hai vế đối chiếu là hai nguồn đã có, không tính lại lợi nhuận");
  assert.ok(!/getSettingJson\s*[<(]/.test(q), "ô settings kiểu mảng đọc THÔ (getSettingJson gộp mảng thành object)");
  const rs = readFileSync("lib/payroll/run-service.ts", "utf8");
  assert.ok(/profitReconReadiness\(report\)/.test(rs) && /signedById === actor\.id/.test(rs), "chốt kỳ đòi chữ ký cấp 1; duyệt đòi người khác người ký");
  const page = readFileSync("app/(dashboard)/payroll/page.tsx", "utf8");
  assert.ok(/profitReconReadiness\(report\)/.test(page), "màn hình gọi CÙNG hàm điều kiện với server");
}

/** Ghi chữ ký cấp 1 KHỚP số hiện tại của tháng — dùng trong luồng thật của các bộ khác. */
export async function kySoatThang(monthKey: string, signedById: string): Promise<ProfitReconSignoff> {
  const rc = await getMonthReconciliation(monthKey);
  const cu = await loadProfitSignoffs();
  const ky: ProfitReconSignoff = {
    id: `kt-${monthKey}-${signedById}-${cu.length}`,
    monthKey,
    fingerprint: rc.fingerprint,
    fingerprintKey: reconFingerprintKey(rc.fingerprint),
    status: rc.status,
    issues: rc.issues.map((i) => ({ code: i.code, label: i.label, amount: i.amount, count: i.count })),
    reason: "kiểm thử: đã đối chiếu từng dòng",
    signedById,
    signedByEmail: `${signedById}@kiem-thu`,
    signedAt: new Date("2029-12-01T00:00:00Z").toISOString(),
    revokedAt: null,
  };
  await setSettingJson(PAYROLL_PROFIT_SIGNOFF_KEY, [...cu, ky]);
  return ky;
}

export function testPayrollReconciliationPure() {
  testPure();
  testSourceFences();
  console.log("✓ đối soát lợi nhuận tính lương: từng dòng cơ sở ↔ nguồn · chi phí theo mã / chung / chưa rõ nguồn / chưa vào cơ sở · độ phủ (chưa đo được ≠ 0%) · năm nấc thưởng · chốt kỳ cần ký khi có khoản đủ điều kiện");
}
