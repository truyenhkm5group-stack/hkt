/**
 * ═══════ ĐỐI SOÁT LỢI NHUẬN TÍNH LƯƠNG + DUYỆT HAI CẤP THƯỞNG % LỢI NHUẬN (Payroll V2 vận hành) ═══════
 *
 * Đặc tả `docs/payroll-code-ledger.md` §9. Phần THUẦN (`lib/payroll/profit-reconciliation.ts`) chạy ở
 * đây; phần NỐI (ảnh chụp mang bảng đối soát · ký trên ảnh · duyệt cần người khác · huỷ chữ ký thì không
 * duyệt / khoá được) chạy trong luồng thật của `tests/payroll-code-ledger.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMonthReconciliation, profitApprovalProblem, profitBonusStage, reconFingerprintKey, signableFingerprint, type MonthReconInput } from "@/lib/payroll/profit-reconciliation";

const TR = 1_000_000;
const goc = (): MonthReconInput => ({
  monthKey: "2029-03",
  basis: {
    revenue: 100 * TR,
    cogs: 30 * TR,
    adsCode: 20 * TR,
    adsTest: 2 * TR,
    adsCodeInPersonLines: 20 * TR,
    shippingPerShipment: 5 * TR,
    logisticsAdjustment: 0,
    logisticsAdjustmentUnallocated: 0,
    operatingEntered: 10 * TR,
    fixedCostAssumption: 0,
    perOrderOpsEstimate: 0,
    sharedUnallocated: 0,
    profit: 33 * TR,
    basisExclusionMeasured: 0,
    basisExclusionEstimated: 0,
  },
  adsRaw: { codeWithMarketer: 20 * TR, codeNoMarketer: 0, testWithMarketer: 2 * TR, testNoMarketer: 0 },
  engine: { cogs: 30 * TR, ads: 22 * TR, shipping: 5 * TR, returnCost: 0, operatingTotal: 10 * TR },
  orders: {
    deliveredRevenue: 100 * TR,
    deliveredRevenueNoProduct: 0,
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
    cogsNoProduct: 0,
    inTransitShipping: 0,
    sentOrders: 230,
    sentNoFeeOrders: 0,
  },
  costWarnings: [],
  codes: [
    { productId: "A", code: "A", hasCustomId: true, revenue: 60 * TR, profit: 20 * TR, unknownCostLines: 0, adsNoMarketer: 0, assigned: true },
    { productId: "B", code: "B", hasCustomId: true, revenue: 40 * TR, profit: 13 * TR, unknownCostLines: 0, adsNoMarketer: 0, assigned: false },
  ],
});
const Q = "period=custom&from=2029-03-01&to=2029-03-31";
const lech = (f: (x: MonthReconInput) => void) => {
  const x = goc();
  f(x);
  return buildMonthReconciliation(x, Q);
};
const dong = (rc: ReturnType<typeof buildMonthReconciliation>, k: string) => rc.lines.find((l) => l.key === k);

function testPure() {
  /* ── Tháng sạch: mọi dòng khớp ⇒ ĐÃ ĐỐI SOÁT, độ phủ 100% ── */
  const sach = buildMonthReconciliation(goc(), Q);
  assert.equal(sach.status, "RECONCILED", `mọi dòng khớp nguồn ⇒ đã đối soát (${sach.issues.map((i) => i.code).join(",")})`);
  assert.equal(sach.coverage.revenueWithMoneyPct, 1);
  assert.equal(sach.coverage.revenueSettledPct, 1);
  assert.equal(sach.coverage.costReconciledPct, 1);
  assert.deepEqual(sach.codes, { total: 2, withCustomId: 2, profitComplete: 2, assigned: 1, withProfit: 2 });
  assert.equal(sach.classes.BY_CODE, 30 * TR + 20 * TR + 5 * TR, "theo mã = giá vốn + QC gắn mã + cước");
  assert.equal(sach.classes.SHARED, 10 * TR + 2 * TR, "chung = vận hành (kể cả phần chia xuống mã theo doanh thu) + QC test có người chịu");
  assert.equal(buildMonthReconciliation(goc(), Q).fingerprint, sach.fingerprint, "hàm thuần — cùng số ⇒ cùng dấu vân tay");

  /* ── Doanh thu ── */
  const thieuTien = lech((x) => {
    x.orders.deliveredRevenueWithMoney = 90 * TR;
    x.orders.deliveredOrdersWithMoney = 180;
  });
  assert.equal(thieuTien.status, "UNRECONCILED", "đơn đã giao chưa có chứng từ tiền ⇒ doanh thu chưa xác minh");
  assert.equal(thieuTien.coverage.revenueWithMoneyPct, 0.9);
  assert.ok(dong(thieuTien, "revenue")?.note.includes("20 đơn"));
  assert.equal(thieuTien.issues.find((i) => i.code === "revenue")?.amount, 10 * TR, "số tiền của khoản = doanh thu CHƯA có chứng từ, không phải 'chênh 0 ₫'");
  const khongMa = lech((x) => {
    x.orders.deliveredRevenueNoProduct = 3 * TR;
  });
  assert.equal(dong(khongMa, "revenue-no-product")?.status, "UNRECONCILED", "dòng hàng không có mã — cơ sở bỏ qua chúng ⇒ chưa đối soát");
  assert.equal(dong(khongMa, "revenue")?.status, "MATCHED", "dòng có mã vẫn khớp — hai thứ tách riêng");
  const dangDi = lech((x) => {
    x.orders.openOrders = 12;
    x.orders.openValue = 30 * TR;
  });
  assert.ok(dangDi.issues.some((i) => i.code === "open-orders" && i.count === 12), "đơn chưa kết thúc ⇒ tháng chưa chín");
  assert.equal(dangDi.coverage.revenueSettledPct, 0.8);

  /* ── Giá vốn: chênh chỉ "đã giải thích" khi đo được phần giải thích ── */
  const giaVon0 = lech((x) => {
    x.orders.unknownCostLines = 7;
    x.orders.unknownCostRevenue = 3 * TR;
    x.codes[1].unknownCostLines = 7;
  });
  assert.ok(giaVon0.issues.some((i) => i.code === "cogs" && i.count === 7 && i.amount === 3 * TR), "dòng hàng không có giá vốn (đang tính 0 ₫) ⇒ chưa đối soát, số tiền = doanh thu của chúng");
  assert.equal(giaVon0.codes.profitComplete, 1, "mã có dòng thiếu giá vốn KHÔNG tính là đủ dữ liệu lợi nhuận");
  const dongKhongMa = lech((x) => {
    x.basis.cogs = 28 * TR;
    x.orders.cogsNoProduct = 2 * TR;
  });
  assert.equal(dong(dongKhongMa, "cogs")?.status, "EXPLAINED", "chênh = đúng giá vốn dòng không mã (máy chi phí tính, cơ sở bỏ) ⇒ đã giải thích");
  const duKhongRo = lech((x) => {
    x.basis.cogs = 32 * TR;
  });
  assert.equal(dong(duKhongRo, "cogs")?.status, "UNRECONCILED", "còn phần dư không đo được ⇒ KHÔNG được gọi là đã giải thích");
  assert.ok(dong(duKhongRo, "cogs")?.note.includes("CHƯA đối chiếu") && !dong(duKhongRo, "cogs")?.note.includes("giá báo MKT"), "không gán phần dư cho giá báo MKT (hai vế cùng dùng giá báo)");
  assert.equal(duKhongRo.issues.find((i) => i.code === "cogs")?.amount, 2 * TR, "số tiền của khoản = đúng phần dư");

  /* ── Quảng cáo: bốn ô đo thẳng + QC ngoài quy kết người ── */
  const qcKhongAi = lech((x) => {
    x.basis.adsTest = 3 * TR;
    x.adsRaw.testNoMarketer = 1 * TR;
    x.engine.ads = 23 * TR;
  });
  assert.equal(qcKhongAi.classes.UNKNOWN_SOURCE, 1 * TR, "QC không mã, không người ⇒ chưa xác định nguồn");
  assert.ok(qcKhongAi.issues.some((i) => i.code === "ads-test-nomk"));
  const maChuaGan = lech((x) => {
    x.adsRaw.codeWithMarketer = 18 * TR;
    x.adsRaw.codeNoMarketer = 2 * TR;
  });
  assert.ok(maChuaGan.issues.some((i) => i.code === "ads-code-nomk"), "QC gắn mã chưa có người ⇒ chưa đối soát (đo thẳng trên bảng chi, không qua quy kết)");
  const ngoaiQuyKet = lech((x) => {
    x.basis.adsCodeInPersonLines = 15 * TR;
  });
  assert.ok(ngoaiQuyKet.issues.some((i) => i.code === "ads-outside-attribution" && i.amount === 5 * TR), "QC của mã không đi vào dòng của MKTer nào ⇒ nói rõ 5tr 'không ai nhận'");
  const qcLech = lech((x) => {
    x.engine.ads = 25 * TR;
  });
  assert.ok(qcLech.issues.some((i) => i.code === "ads"), "tổng QC cơ sở lệch máy chi phí ⇒ chưa đối soát");
  const oLech = lech((x) => {
    x.adsRaw.codeWithMarketer = 19 * TR;
  });
  assert.ok(oLech.issues.some((i) => i.code === "ads-parts"), "bốn ô đo thẳng không cộng ra QC của cơ sở ⇒ chưa đối soát");

  /* ── Logistics ── */
  const dangDiCuoc = lech((x) => {
    x.basis.shippingPerShipment = 6 * TR;
    x.orders.inTransitShipping = 1 * TR;
  });
  assert.equal(dong(dangDiCuoc, "shipping")?.status, "EXPLAINED", "chênh cước = đúng cước kiện đang đi ⇒ đã giải thích");
  const cuocAm = lech((x) => {
    x.basis.shippingPerShipment = 4 * TR;
  });
  assert.equal(dong(cuocAm, "shipping")?.status, "UNRECONCILED", "cơ sở THẤP hơn máy chi phí — không thể là do kiện đang đi ⇒ chưa đối soát");
  const khongCuoc = lech((x) => {
    x.orders.sentNoFeeOrders = 3;
  });
  assert.ok(khongCuoc.issues.some((i) => i.code === "shipping" && i.count === 3), "kiện đã gửi không có cước (tính 0 ₫)");
  const phiHoan = lech((x) => {
    x.engine.returnCost = 4 * TR;
  });
  assert.equal(phiHoan.classes.NOT_IN_BASIS, 4 * TR, "phí chiều hoàn có thật mà chưa vào cơ sở lương");
  assert.ok(phiHoan.issues.some((i) => i.code === "return-cost"));

  /* ── Cảnh báo: chỉ "lương cứng chưa ghi nhận" là chưa vào cơ sở; trùng nguồn là khoản bị LOẠI ── */
  const canhBao = lech((x) => {
    x.costWarnings = [
      { rule: "PAYROLL_OBLIGATION_NOT_RECOGNIZED", title: "Lương cứng chưa ghi nhận", amount: 8 * TR },
      { rule: "DUPLICATE_LOGISTICS_COST_SOURCE", title: "Cước gõ tay trùng vận đơn", amount: 3 * TR },
    ];
  });
  assert.equal(canhBao.classes.NOT_IN_BASIS, 8 * TR, "khoản trùng nguồn (bị loại) KHÔNG cộng vào 'chưa vào cơ sở' — cộng là mời tính hai lần");
  assert.ok(canhBao.issues.some((i) => i.code === "warn:DUPLICATE_LOGISTICS_COST_SOURCE"), "nhưng vẫn là việc phải đối chiếu tay");

  /* ── Ước tính có nhãn, không tính là khớp ── */
  const uocTinh = lech((x) => {
    x.basis.fixedCostAssumption = 5 * TR;
  });
  assert.equal(dong(uocTinh, "fixed-assumption")?.status, "ESTIMATED");
  assert.ok((uocTinh.coverage.costReconciledPct ?? 1) < 1, "chi phí GIẢ ĐỊNH không đếm là khớp nguồn");
  assert.equal(uocTinh.classes.SHARED, 10 * TR + 5 * TR + 2 * TR, "chi phí cố định giả định là chi phí CHUNG");
  const khongMaHang = lech((x) => {
    x.codes[1].hasCustomId = false;
  });
  assert.ok(khongMaHang.issues.some((i) => i.code === "code-no-custom-id" && i.count === 1));
  assert.notEqual(dangDi.fingerprint, sach.fingerprint, "số đổi ⇒ dấu vân tay đổi");
  assert.notEqual(reconFingerprintKey(dangDi.fingerprint), reconFingerprintKey(sach.fingerprint));
  const rong = lech((x) => {
    x.orders = { ...x.orders, deliveredRevenue: 0, deliveredRevenueWithMoney: 0, settledValue: 0, openValue: 0 };
    x.basis.revenue = 0;
  });
  assert.equal(rong.coverage.revenueWithMoneyPct, null, "mẫu số 0 ⇒ chưa đo được, không phải 0% hay 100%");
  assert.equal(rong.coverage.revenueSettledPct, null);

  /* ── Năm nấc trạng thái khoản thưởng ── */
  assert.equal(profitBonusStage({ eligible: null, established: false, runStatus: null, paid: false }), "PROVISIONAL");
  assert.equal(profitBonusStage({ eligible: 0, established: true, runStatus: "CALCULATED", paid: false }), "NOT_ELIGIBLE");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "CALCULATED", paid: false }), "ELIGIBLE");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "APPROVED", paid: false }), "APPROVED");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "LOCKED", paid: false }), "APPROVED");
  assert.equal(profitBonusStage({ eligible: 5 * TR, established: true, runStatus: "PAID", paid: true }), "PAID");
  assert.equal(profitBonusStage({ eligible: 0, established: true, runStatus: "PAID", paid: true }), "NOT_ELIGIBLE", "kỳ đã trả nhưng khoản không đủ điều kiện ⇒ không có gì được trả");

  /* ── Cấp 2 ── */
  const ky = { id: "k1", monthKey: "2029-03", fingerprint: "FP", signedById: "u1", signedByEmail: "u1@x", revokedAt: null };
  const hoi = (o: Partial<Parameters<typeof profitApprovalProblem>[0]>) =>
    profitApprovalProblem({ allocatedTotal: 5 * TR, monthKey: "2029-03", snapshotFingerprint: "FP", signoffs: [ky], actorId: "u2", requireDifferentPerson: true, ...o });
  assert.equal(hoi({}), null, "chữ ký còn hiệu lực trên đúng ảnh + người khác duyệt ⇒ được");
  assert.equal(hoi({ allocatedTotal: 0, signoffs: [] }), null, "không có thưởng đủ điều kiện ⇒ không cần ký (lương cứng không bị giữ)");
  assert.match(hoi({ signoffs: [] }) ?? "", /CHƯA có chữ ký/);
  assert.match(hoi({ snapshotFingerprint: "FP2" }) ?? "", /CHƯA có chữ ký/, "chữ ký trên ảnh chụp CŨ không áp cho ảnh mới");
  assert.match(hoi({ signoffs: [{ ...ky, revokedAt: "2029-04-01" }] }) ?? "", /CHƯA có chữ ký/, "chữ ký đã huỷ không áp");
  assert.match(hoi({ actorId: "u1" }) ?? "", /MỘT NGƯỜI KHÁC/, "người ký cấp 1 không duyệt cấp 2");
  assert.equal(hoi({ actorId: "u1", requireDifferentPerson: false }), null, "bước KHOÁ chỉ cần chữ ký còn hiệu lực");
  assert.match(hoi({ snapshotFingerprint: null }) ?? "", /không mang bảng đối soát/);

  /* ── Dấu vân tay được ký gồm cả khoản thưởng đủ điều kiện ── */
  const g1 = { allocatedTotal: 5 * TR, allocations: [{ key: "a:SHOP", eligible: 3 * TR }, { key: "b:CODE:x:OWNER:0", eligible: 2 * TR }] };
  assert.equal(signableFingerprint("RC", g1), signableFingerprint("RC", { ...g1, allocations: [...g1.allocations].reverse() }), "không phụ thuộc thứ tự khoản");
  assert.notEqual(signableFingerprint("RC", g1), signableFingerprint("RC", { ...g1, allocations: [{ key: "a:SHOP", eligible: 4 * TR }, { key: "b:CODE:x:OWNER:0", eligible: 1 * TR }] }), "lợi nhuận không đổi nhưng chia thưởng khác (đổi X%) ⇒ phải ký lại");
}

function testSourceFences() {
  const lib = readFileSync("lib/payroll/profit-reconciliation.ts", "utf8");
  assert.ok(!/from "@\/db"|getDb|new Date\(\)/.test(lib), "phép dựng đối soát là hàm THUẦN");
  const q = readFileSync("lib/queries/payroll-reconciliation.ts", "utf8");
  assert.ok(/ORDER_OUTCOME_FAST/.test(q) && /LINE_UNIT_COST/.test(q) && /PRIMARY_ATTEMPT/.test(q) && /REVENUE_RECOGNIZED_ON_DELIVERY/.test(q), "đo trên đơn bằng CHÍNH biểu thức của cơ sở lương — không viết luật kết quả đơn thứ hai");
  assert.ok(/getRecognizedCosts/.test(q) && /getPayrollReport/.test(q), "hai vế đối chiếu là hai nguồn đã có, không tính lại lợi nhuận");
  assert.ok(!/getSettingJson\s*[<(]/.test(q), "ô settings kiểu mảng đọc THÔ (getSettingJson gộp mảng thành object)");
  const rs = readFileSync("lib/payroll/run-service.ts", "utf8");
  assert.ok(/snapshot\.profitRecon = /.test(rs) && /signableFingerprint\(rc\.fingerprint, report\.profitGate\.result\)/.test(rs), "ảnh chụp kỳ mang bảng đối soát, dấu vân tay gồm cả khoản thưởng");
  assert.ok(/allocatedTotal \?\? 0\) > 0\) \{\n\s+return \{ error: `Không dựng được bảng đối soát/.test(rs), "lỗi dựng bảng chỉ chặn khi tháng có thưởng đủ điều kiện — không giữ lương cứng");
  assert.ok(/profitApprovalProblem\(/.test(rs) && /action === "APPROVE" \|\| action === "LOCK"/.test(rs), "duyệt VÀ khoá đều kiểm chữ ký còn hiệu lực");
  const svc = readFileSync("lib/payroll/recon-signoff.ts", "utf8");
  assert.ok(/snapshot\?\.profitRecon/.test(svc) && !/getMonthReconciliation/.test(svc), "chữ ký ký trên ẢNH CHỤP, không đo lại số sống");
}

export function testPayrollReconciliationPure() {
  testPure();
  testSourceFences();
  console.log("✓ đối soát lợi nhuận tính lương: từng dòng cơ sở ↔ nguồn · 'đã giải thích' chỉ khi đo được phần giải thích · QC bốn ô đo thẳng + QC ngoài quy kết · chi phí theo mã / chung / chưa rõ nguồn / chưa vào cơ sở · độ phủ (chưa đo được ≠ 0%) · năm nấc thưởng · cấp 2 cần chữ ký còn hiệu lực trên đúng ảnh + người khác");
}
