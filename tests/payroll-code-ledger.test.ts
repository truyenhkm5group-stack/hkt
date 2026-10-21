/**
 * ═══════ SỔ LỢI NHUẬN THEO MÃ + THƯỞNG OWNER / SUPPORT (Payroll V2) ═══════
 *
 * Đặc tả: `docs/payroll-code-ledger.md`. Phép tính: `lib/payroll/code-ledger.ts`.
 *
 * Các ca chủ shop bắt buộc (19/10/2026), đánh số đúng như yêu cầu:
 *   1. lỗ trước đó, phục hồi một phần            8. đổi tỷ lệ giữa tháng
 *   2. lãi vượt phần lỗ                          9. đổi OWNER không reset sổ mã
 *   3. công ty âm, mã dương                     10. đơn nhiều mã · hoàn / chi phí sau khi khoá
 *   4. công ty dương, một mã còn lỗ             11. thiếu Ads / SKU / MKTer mapping
 *   5. một MKTer nhiều mã                       12. vượt trần · đếm hai lần
 *   6. nhiều MKTer một mã                       13. tính lại cho cùng kết quả
 *   7. OWNER mã A và SUPPORT mã B
 *
 * Phần THUẦN không cần CSDL; phần NỐI chạy qua đúng `getPayrollReport` mà `/payroll` gọi, trên tháng
 * 01–02/2029 (tiền tố `cl-`) để không đụng fixture của bộ khác.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { DEFAULT_PROFIT_GATE_CONFIG, PAYROLL_PROFIT_GATE_KEY, type ProfitGatePolicy } from "@/lib/constants/payroll-profit-gate";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import { allocateCompanyToCodes, codeBonusClaims, codeLedgerStep, describeFingerprint, splitByWeights, type CodeAssignment, type CodeSegment, type CodeState, type CodeTerms } from "@/lib/payroll/code-ledger";
import { calculatePayrollPeriodAs, transitionPayrollRunAs } from "@/lib/payroll/run-service";
import { getMonthReconciliation } from "@/lib/queries/payroll-reconciliation";
import { PAYROLL_PROFIT_SIGNOFF_KEY } from "@/lib/constants/payroll-reconciliation";
import { revokeProfitReconAs, signProfitReconAs } from "@/lib/payroll/recon-signoff";
import { getPayrollReport, monthReportPeriod, profitGateReadiness } from "@/lib/queries/payroll";
import type { PayrollSnapshot } from "@/lib/queries/payroll-period";
import { buildCodeSegmentsFor, listCodeBook, loadCodeBook, MIGRATION_0249_WHEN, segmentBounds, type CodeFacts } from "@/lib/queries/payroll-code-ledger";
import { codeAssignmentSchema, codeRowId, codeTermsSchema, endChangesFromKey, planOwnerHandover } from "@/lib/validation/payroll-code";
import type { Period } from "@/lib/search-params";
import { monthPeriodKey } from "@/lib/queries/payroll-profit-gate";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { PAYROLL_CODE_WEIGHT_CONFIRM_KEY } from "@/lib/constants/payroll-code";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";

const TR = 1_000_000;
const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const e = (iso: string) => new Date(`${iso}T23:59:59.999+07:00`);
const T_FROM = d("2029-03-01");
const T_TO = e("2029-03-31");
const seg = (weight = 1, ad: Record<string, number> = {}, rev: Record<string, number> = {}, from = T_FROM, to = T_TO, unattributed = { ad: 0, rev: 0 }): CodeSegment => ({
  from,
  to,
  weight,
  adSpendByEmployee: new Map(Object.entries(ad)),
  revenueByEmployee: new Map(Object.entries(rev)),
  unattributedAdSpend: unattributed.ad,
  unattributedRevenue: unattributed.rev,
});
let n = 0;
const owner = (productId: string, employeeId: string, pct: number, from = T_FROM, to: Date | null = null): CodeAssignment => ({ id: `as${++n}`, productId, employeeId, role: "OWNER", ownerRateBp: pct * 100, weightMethod: null, weightBp: null, from, to, policyRef: "QC-1" });
const support = (productId: string, employeeId: string, method: CodeAssignment["weightMethod"], weightPct: number | null = null, from = T_FROM, to: Date | null = null): CodeAssignment => ({
  id: `as${++n}`,
  productId,
  employeeId,
  role: "SUPPORT",
  ownerRateBp: null,
  weightMethod: method,
  weightBp: weightPct === null ? null : weightPct * 100,
  from,
  to,
  policyRef: "QC-1",
});
const terms = (productId: string | null, y: number, max: number | null = null, from = T_FROM, to: Date | null = null): CodeTerms => ({ id: `t${++n}`, productId, supportPoolBp: y * 100, maxBonusAmount: max, from, to, policyRef: "QC-1" });

function testPure() {
  const zero = new Map<string, CodeState>();

  /* ══ 1 · LỖ TRƯỚC ĐÓ, PHỤC HỒI MỘT PHẦN ══ */
  const lo = new Map<string, CodeState>([["A", { cumulative: -100 * TR, highWater: 0 }]]);
  const s1 = codeLedgerStep(lo, [{ productId: "A", code: "A", profit: 40 * TR }]);
  assert.equal(s1.rows[0].eligible, 0, "1. còn lỗ lũy kế 60tr ⇒ không có lợi nhuận đủ điều kiện");
  assert.equal(s1.rows[0].lossToRecover, 100 * TR);
  assert.deepEqual(s1.closing.get("A"), { cumulative: -60 * TR, highWater: 0 }, "1. lũy kế −60tr, HWM giữ 0");

  /* ══ 2 · LÃI VƯỢT PHẦN LỖ ══ */
  const s2 = codeLedgerStep(s1.closing, [{ productId: "A", code: "A", profit: 100 * TR }]);
  assert.equal(s2.rows[0].eligible, 40 * TR, "2. chỉ phần vượt (−60 + 100 = 40tr) đủ điều kiện");
  assert.deepEqual(s2.closing.get("A"), { cumulative: 40 * TR, highWater: 40 * TR });
  // Đã chia tới HWM 40tr rồi lỗ 30tr: phải bù lại 30tr trước, KHÔNG chia trùng phần dưới HWM.
  const s2b = codeLedgerStep(s2.closing, [{ productId: "A", code: "A", profit: -30 * TR }]);
  const s2c = codeLedgerStep(s2b.closing, [{ productId: "A", code: "A", profit: 50 * TR }]);
  assert.equal(s2c.rows[0].eligible, 20 * TR, "2. sau khi lỗ lại, chỉ phần vượt HWM cũ (60 − 40) đủ điều kiện");
  // Mã không có số tháng này giữ nguyên trạng thái.
  assert.deepEqual(codeLedgerStep(s2.closing, []).closing.get("A"), s2.closing.get("A"));

  /* ══ 3 · CÔNG TY ÂM, MÃ DƯƠNG ══ */
  const ma = codeLedgerStep(zero, [
    { productId: "A", code: "A", profit: 30 * TR },
    { productId: "B", code: "B", profit: 10 * TR },
  ]);
  const a0 = allocateCompanyToCodes(ma.rows, 0);
  assert.equal([...a0.values()].reduce((t, x) => t + x, 0), 0, "3. công ty không có lợi nhuận đủ điều kiện ⇒ không mã nào được phân bổ");
  const c3 = codeBonusClaims({ productId: "A", code: "A", eligible: 30 * TR, allocated: a0.get("A") ?? 0, segments: [seg()], assignments: [owner("A", "m1", 10)], terms: [] });
  assert.equal(c3.claims[0].demand, 0, "3. lãi của mã KHÔNG vượt qua lỗ của công ty");
  assert.equal(c3.claims[0].provisional, 3 * TR, "3. tạm tính vẫn hiện để thấy phần bị giữ");
  assert.equal(allocateCompanyToCodes(ma.rows, -5 * TR).size, 2, "lợi nhuận đủ điều kiện âm được coi như 0");
  // Cổng chưa kết luận ⇒ đề nghị là CHƯA BIẾT, không phải 0.
  assert.equal(codeBonusClaims({ productId: "A", code: "A", eligible: 30 * TR, allocated: null, segments: [seg()], assignments: [owner("A", "m1", 10)], terms: [] }).claims[0].demand, null);

  /* ══ 4 · CÔNG TY DƯƠNG, MỘT MÃ CÒN LỖ ══ */
  const m4 = codeLedgerStep(new Map([["B", { cumulative: -50 * TR, highWater: 0 }]]), [
    { productId: "A", code: "A", profit: 30 * TR },
    { productId: "B", code: "B", profit: 20 * TR },
  ]);
  const a4 = allocateCompanyToCodes(m4.rows, 100 * TR);
  assert.equal(a4.get("A"), 30 * TR, "4. mã lãi nhận đúng phần đủ điều kiện của nó");
  assert.equal(a4.get("B") ?? 0, 0, "4. mã còn lỗ lũy kế không nhận gì dù công ty lãi");
  assert.deepEqual(codeBonusClaims({ productId: "B", code: "B", eligible: 0, allocated: 0, segments: [seg()], assignments: [owner("B", "m1", 10)], terms: [] }).claims, []);
  // Quỹ công ty nhỏ hơn Σ đủ điều kiện mã ⇒ chia theo tỷ trọng, đúng từng đồng.
  const a4b = allocateCompanyToCodes(ma.rows, 7 * TR + 1);
  assert.equal([...a4b.values()].reduce((t, x) => t + x, 0), 7 * TR + 1, "Σ phân bổ = quỹ công ty khi quỹ nhỏ hơn");
  assert.ok((a4b.get("A") ?? 0) > (a4b.get("B") ?? 0) * 2.9, "tỷ trọng 3:1");

  /* ══ 5 · MỘT MKTer NHIỀU MÃ · 7 · OWNER A + SUPPORT B ══ */
  const asg = [owner("A", "m1", 10), owner("B", "m2", 10), support("B", "m1", "AD_SPEND"), support("B", "m3", "AD_SPEND")];
  const cA = codeBonusClaims({ productId: "A", code: "A", eligible: 30 * TR, allocated: 30 * TR, segments: [seg()], assignments: asg, terms: [terms(null, 6)] });
  const cB = codeBonusClaims({ productId: "B", code: "B", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { m1: 1 * TR, m3: 3 * TR })], assignments: asg, terms: [terms(null, 6)] });
  const m1 = [...cA.claims, ...cB.claims].filter((c) => c.employeeId === "m1");
  assert.deepEqual(
    m1.map((c) => `${c.code}:${c.role}`),
    ["A:OWNER", "B:SUPPORT"],
    "5/7. m1 có HAI khoản riêng: OWNER mã A, SUPPORT mã B",
  );
  assert.equal(new Set(m1.map((c) => c.key)).size, 2, "khoá không trùng ⇒ cổng không gộp hai khoản thành một");
  assert.equal(cA.claims.find((c) => c.role === "OWNER")?.demand, 3 * TR);

  /* ══ 6 · NHIỀU MKTer MỘT MÃ ══ */
  const sup = cB.claims.filter((c) => c.role === "SUPPORT");
  assert.equal(sup.reduce((t, c) => t + (c.demand ?? 0), 0), 600_000, "6. Σ SUPPORT = đúng quỹ Y% = 10tr × 6%");
  assert.equal(sup.find((c) => c.employeeId === "m1")?.demand, 150_000, "6. trọng số theo chi phí QC đối soát được 1:3");
  assert.equal(sup.find((c) => c.employeeId === "m3")?.demand, 450_000);
  // Chủ shop 21/10: X là TỔNG phần MKT của mã. OWNER không chạy QC trong đoạn ⇒ toàn bộ lợi nhuận do SUPPORT làm ra ⇒
  // SUPPORT nhận Y% (6%) trên đó, OWNER giữ (X − Y)% = 4% ⇒ 400K. Tổng vẫn đúng X% = 1tr.
  assert.equal(cB.claims.find((c) => c.role === "OWNER")?.demand, 400_000, "OWNER nhận (X − Y)% trên phần lợi nhuận do người đẩy cùng làm ra");
  assert.equal(cB.claims.reduce((t, c) => t + (c.demand ?? 0), 0), 1 * TR, "OWNER + SUPPORT = đúng X% lợi nhuận mã — không cộng thêm Y% lên trên");
  // OWNER cũng chạy QC (1 phần trên 5) ⇒ phần đó OWNER giữ trọn X%; 4 phần của SUPPORT: SUPPORT Y%, OWNER X − Y.
  const coChu = codeBonusClaims({ productId: "B", code: "B", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { o: 1, x: 4 })], assignments: [owner("B", "o", 25), support("B", "x", "AD_SPEND")], terms: [terms("B", 20)] });
  assert.deepEqual(
    coChu.claims.map((c) => [c.role, c.demand]),
    [["OWNER", 900_000], ["SUPPORT", 1_600_000]],
    "ví dụ chủ shop: X 25% · Y 20% · SUPPORT làm 80% lợi nhuận ⇒ SUPPORT 10tr×80%×20% = 1,6tr; OWNER 10tr×25% − 1,6tr = 0,9tr",
  );
  // Trọng số tay đã duyệt.
  const tay = codeBonusClaims({ productId: "B", code: "B", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [support("B", "x", "MANUAL", 70), support("B", "y", "MANUAL", 30)], terms: [terms("B", 10)] });
  assert.deepEqual(tay.claims.map((c) => c.demand), [700_000, 300_000]);
  // Doanh thu quy kết.
  const dt = codeBonusClaims({ productId: "B", code: "B", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, {}, { x: 1, y: 1 })], assignments: [support("B", "x", "ATTRIBUTED_REVENUE"), support("B", "y", "ATTRIBUTED_REVENUE")], terms: [terms("B", 10)] });
  assert.deepEqual(dt.claims.map((c) => c.demand), [500_000, 500_000]);
  // Điều khoản của mã thắng điều khoản mặc định công ty.
  const uuTien = codeBonusClaims({ productId: "B", code: "B", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [support("B", "x", "MANUAL", 100)], terms: [terms(null, 10), terms("B", 2)] });
  assert.equal(uuTien.claims[0].demand, 200_000, "điều khoản theo mã > mặc định công ty");
  // Chia theo trọng số luôn ra đúng tổng, kể cả số lẻ.
  const le = splitByWeights(100, [
    { key: "a", weight: 1 },
    { key: "b", weight: 1 },
    { key: "c", weight: 1 },
  ]);
  assert.equal([...le.values()].reduce((t, x) => t + x, 0), 100);

  /* ══ 8 · ĐỔI TỶ LỆ GIỮA THÁNG · 9 · ĐỔI OWNER KHÔNG RESET ══ */
  const giua = d("2029-03-16");
  const cuoiNua = new Date(giua.getTime() - 1);
  const hai = [owner("A", "m1", 10, T_FROM, cuoiNua), owner("A", "m2", 20, giua)];
  const bounds = segmentBounds("A", T_FROM, T_TO, hai, []);
  assert.deepEqual(
    bounds.map((b) => [b.from.toISOString(), b.to.toISOString()]),
    [
      [T_FROM.toISOString(), cuoiNua.toISOString()],
      [giua.toISOString(), T_TO.toISOString()],
    ],
    "8. tháng được cắt đúng tại mốc hiệu lực",
  );
  const c8 = codeBonusClaims({
    productId: "A",
    code: "A",
    eligible: 40 * TR,
    allocated: 40 * TR,
    segments: [seg(0.25, {}, {}, T_FROM, cuoiNua), seg(0.75, {}, {}, giua, T_TO)],
    assignments: hai,
    terms: [],
  });
  assert.deepEqual(
    c8.claims.map((c) => [c.employeeId, c.demand]),
    [
      ["m1", 1 * TR],
      ["m2", 6 * TR],
    ],
    "8/9. mỗi đoạn tính theo nghiệp vụ phát sinh trong đoạn (25% · 75%) với tỷ lệ của chính đoạn ấy",
  );
  // Sổ mã không biết gì về người: đổi OWNER không chạm lũy kế.
  assert.equal(s2b.closing.get("A")?.cumulative, 10 * TR, "9. sổ đi theo mã — không có tham số người nào");

  /* ══ 11 · THIẾU MAPPING ⇒ CHỜ ĐỐI SOÁT, KHÔNG CHIA ĐỀU ══ */
  const thieuQc = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)] });
  assert.equal(thieuQc.claims.length, 0, "11. không SUPPORT nào có chi phí QC ⇒ KHÔNG tự chia đều");
  assert.equal(thieuQc.pending.length, 2);
  assert.ok(thieuQc.pending.every((p) => p.reason.includes("PENDING_RECONCILIATION") && p.provisional === 1 * TR), "11. lý do + số đang treo");
  const thieuY = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [owner("A", "o", 10), support("A", "x", "MANUAL", 100)], terms: [] });
  assert.deepEqual(
    [thieuY.claims.length, thieuY.pending.map((p) => p.employeeId)],
    [0, ["o", "x"]],
    "11. SUPPORT chưa có điều khoản Y% ⇒ CẢ đoạn chờ — phần của OWNER là X% TRỪ phần SUPPORT, chưa biết Y thì chưa biết phần OWNER",
  );
  const tayLech = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [support("A", "x", "MANUAL", 60), support("A", "y", "MANUAL", 30)], terms: [terms(null, 10)] });
  assert.equal(tayLech.claims.length, 0, "11. trọng số tay Σ 90% ⇒ chờ, không tự chuẩn hoá");
  const tronCach = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 1 })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "MANUAL", 100)], terms: [terms(null, 10)] });
  assert.equal(tronCach.claims.length, 0, "11. hai cách tính trọng số trong cùng đoạn ⇒ chờ");
  // Mã có lợi nhuận mà chưa ai được phân công ⇒ không ai nhận, không lỗi.
  assert.deepEqual(codeBonusClaims({ productId: "Z", code: "Z", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: asg, terms: [] }), { claims: [], pending: [] });

  /* ══ 12 · VƯỢT TRẦN · ĐẾM HAI LẦN ══ */
  const tran = codeBonusClaims({ productId: "B", code: "B", eligible: 100 * TR, allocated: 100 * TR, segments: [seg(1, { m1: 1, m3: 1 })], assignments: asg, terms: [terms(null, 10, 5 * TR)] });
  assert.equal(
    tran.claims.reduce((t, c) => t + (c.demand ?? 0), 0),
    5 * TR,
    "12. Σ thưởng của mã không vượt trần theo mã",
  );
  assert.ok(tran.claims.reduce((t, c) => t + c.provisional, 0) <= 5 * TR);
  const vuot = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [owner("A", "o", 10), support("A", "x", "MANUAL", 100)], terms: [terms(null, 20)] });
  assert.equal(vuot.claims.length, 0, "12. Y% > X% ⇒ chờ — phần của người đẩy cùng không vượt được tổng phần MKT của mã (OWNER sẽ âm)");
  const haiChu = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [owner("A", "o", 10), owner("A", "p", 10)], terms: [] });
  assert.deepEqual([haiChu.claims.length, haiChu.pending.map((p) => p.employeeId)], [0, ["o", "p"]], "12. hai OWNER cùng lúc ⇒ chờ, gắn vào CẢ HAI người (khoản chờ không tên không chặn được thực nhận của ai)");
  assert.deepEqual(
    vuot.pending.map((p) => p.employeeId),
    ["o", "x"],
    "12. Y > X ⇒ chờ cho mọi người có phân công trong đoạn",
  );
  const haiDk = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [owner("A", "o", 10)], terms: [terms("A", 5), terms("A", 6)] });
  assert.equal(haiDk.pending.length, 1, "12. hai điều khoản cùng hiệu lực ⇒ ERP không chọn hộ");

  /* ══ 11 (review) · THIẾU MỘT PHẦN TRỌNG SỐ cũng là thiếu ══ */
  const motNguoi = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 10 * TR })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)] });
  assert.equal(motNguoi.claims.length, 0, "11. y chưa có chi phí QC (chiến dịch chưa ghép?) ⇒ KHÔNG dồn cả quỹ cho x");
  assert.ok(motNguoi.pending.some((p) => /y không có chi phí quảng cáo/.test(p.reason)));
  const chuaGan = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 1 * TR, y: 1 * TR }, {}, T_FROM, T_TO, { ad: 500_000, rev: 0 })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)] });
  assert.equal(chuaGan.claims.length, 0, "11. mã còn chi phí QC chưa gán cho MKTer nào ⇒ trọng số chưa đủ căn cứ");
  assert.ok(chuaGan.pending.every((p) => /CHƯA GÁN/.test(p.reason) && p.kind === "WEIGHT_PARTIAL"), "loại khoản chờ gỡ được bằng lời xác nhận");
  assert.ok(motNguoi.pending.every((p) => p.kind === "WEIGHT_PARTIAL"));
  assert.ok(thieuQc.pending.every((p) => p.kind === undefined), "không SUPPORT nào có số đo ⇒ KHÔNG gỡ được bằng lời xác nhận");
  assert.ok(tayLech.pending.every((p) => p.kind === undefined), "trọng số tay lệch ⇒ sửa phân công, không xác nhận");
  // Lời xác nhận có người duyệt (vòng review 2 + 3): áp ĐÚNG dấu vân tay số đo đã được xem.
  const vt = (pd: { pending: { fingerprint?: string }[] }) => new Set(pd.pending.map((p) => p.fingerprint).filter((f): f is string => Boolean(f)));
  assert.ok(vt(motNguoi).size === 1 && vt(chuaGan).size === 1, "khoản chờ WEIGHT_PARTIAL mang dấu vân tay số đo");
  const xn = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 10 * TR })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)], confirmedFingerprints: vt(motNguoi) });
  assert.deepEqual(
    xn.claims.map((c) => [c.employeeId, c.demand]),
    [
      ["x", 1 * TR],
      ["y", 0],
    ],
    "đã xác nhận ⇒ y nhận 0 thật, x nhận đủ quỹ — có người đứng tên",
  );
  const xn2 = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 1 * TR, y: 1 * TR }, {}, T_FROM, T_TO, { ad: 500_000, rev: 0 })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)], confirmedFingerprints: vt(chuaGan) });
  assert.equal(xn2.pending.length, 0);
  // Số đo ĐỔI sau khi xác nhận (thêm 1 ₫ chưa gán / ghép muộn chiến dịch / thêm SUPPORT) ⇒ quay lại chờ.
  const doi1 = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 1 * TR, y: 1 * TR }, {}, T_FROM, T_TO, { ad: 500_001, rev: 0 })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)], confirmedFingerprints: vt(chuaGan) });
  assert.ok(doi1.claims.length === 0 && doi1.pending.every((p) => /SỐ ĐO ĐÃ ĐỔI/.test(p.reason)), "lời xác nhận không áp cho số đo khác — nói rõ đã đổi");
  const doi2 = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 10 * TR })], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND"), support("A", "z", "AD_SPEND")], terms: [terms(null, 10)], confirmedFingerprints: vt(motNguoi) });
  assert.equal(doi2.claims.length, 0, "thêm SUPPORT sau khi xác nhận ⇒ chờ lại, z không lặng lẽ nhận 0");
  // Câu "số đo đã đổi" chỉ cho ĐÚNG đoạn từng được xác nhận; đoạn khác nhận câu trung tính.
  const doanKhac = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { x: 10 * TR }, {}, T_FROM, e("2029-03-15"))], assignments: [support("A", "x", "AD_SPEND"), support("A", "y", "AD_SPEND")], terms: [terms(null, 10)], confirmedFingerprints: vt(motNguoi) });
  assert.ok(doanKhac.pending.every((p) => !/SỐ ĐO ĐÃ ĐỔI/.test(p.reason)), "đoạn chưa ai xác nhận không bị nói là 'đã đổi'");
  // Người duyệt đọc được con số mình ký.
  const moTa = describeFingerprint([...vt(chuaGan)][0], (x) => `NV-${x}`);
  assert.ok(/NV-x 1\.000\.000/.test(moTa) && /chưa gán QC 500\.000 ₫/.test(moTa), `mô tả dấu vân tay: ${moTa}`);
  assert.equal(codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg()], assignments: [support("A", "x", "AD_SPEND")], terms: [terms(null, 10)], confirmedFingerprints: new Set(["bất kỳ"]) }).claims.length, 0, "xác nhận KHÔNG gỡ được ca không ai có số đo");
  const dtChuaGan = codeBonusClaims({ productId: "A", code: "A", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, {}, { x: 1 }, T_FROM, T_TO, { ad: 0, rev: 1 })], assignments: [support("A", "x", "ATTRIBUTED_REVENUE")], terms: [terms(null, 10)] });
  assert.equal(dtChuaGan.claims.length, 0, "11. doanh thu chưa gán ⇒ chờ");
  // Căn cứ trọng số in ra là của RIÊNG người ấy trong đoạn.
  assert.deepEqual(
    cB.claims.filter((c) => c.role === "SUPPORT").map((c) => [c.employeeId, c.basisAdSpend]),
    [
      ["m1", 1 * TR],
      ["m3", 3 * TR],
    ],
  );

  /* ══ ĐẦU VÀO (review): ô trống KHÔNG phải số 0 ══ */
  const dk = { supportPoolPercent: "5", maxBonusAmount: "", effectiveFrom: "2029-01-01", effectiveTo: "", policyRef: "QC", productId: "" };
  const okDk = codeTermsSchema.safeParse(dk);
  assert.ok(okDk.success && okDk.data.maxBonusAmount === undefined && okDk.data.productId === undefined, "trần bỏ trống = KHÔNG có trần (không phải trần 0 ₫); mã bỏ trống = mặc định công ty");
  assert.equal(codeTermsSchema.safeParse({ ...dk, maxBonusAmount: "0" }).data?.maxBonusAmount, 0, "gõ 0 thật thì là 0");
  assert.equal(codeTermsSchema.safeParse({ ...dk, maxBonusAmount: "1.000.000" }).data?.maxBonusAmount, 1_000_000, "gõ tiền kiểu Việt Nam có dấu chấm");
  assert.equal(codeTermsSchema.safeParse({ ...dk, supportPoolPercent: "" }).success, false, "Y% bỏ trống ⇒ báo lỗi, không lưu thành 0%");
  assert.equal(codeTermsSchema.safeParse({ ...dk, supportPoolPercent: "  " }).success, false);
  assert.equal(codeAssignmentSchema.safeParse({ productId: "p", employeeId: "e", role: "OWNER", ownerRatePercent: "", effectiveFrom: "2029-01-01", policyRef: "QC" }).success, false, "X% bỏ trống ⇒ báo lỗi");
  assert.equal(codeAssignmentSchema.safeParse({ productId: "p", employeeId: "e", role: "SUPPORT", weightMethod: "MANUAL", weightPercent: "", effectiveFrom: "2029-01-01", policyRef: "QC" }).success, false, "trọng số tay bỏ trống ⇒ báo lỗi");

  /* ══ KHOÁ DÒNG THEO NỘI DUNG (review): lần gửi lại sau khi duyệt mang ĐÚNG khoá đã duyệt ══ */
  const v1 = { productId: "p", employeeId: "e", role: "OWNER", ownerRateBp: 1000, effectiveFrom: d("2029-01-01"), effectiveTo: null };
  assert.equal(codeRowId("ASSIGNMENT", v1), codeRowId("ASSIGNMENT", { ...v1 }), "cùng nội dung ⇒ cùng khoá");
  const { productId: p1, ...conLai } = v1;
  assert.equal(codeRowId("ASSIGNMENT", { ...conLai, productId: p1 }), codeRowId("ASSIGNMENT", v1), "không phụ thuộc thứ tự trường");
  assert.notEqual(codeRowId("ASSIGNMENT", { ...v1, ownerRateBp: 1100 }), codeRowId("ASSIGNMENT", v1), "đổi tỷ lệ ⇒ khoá khác ⇒ phải duyệt lại");

  /* ══ BÀN GIAO OWNER (review): OWNER có hạn không được cắt quyền của OWNER không hạn ══ */
  const alice = [{ id: "alice", from: d("2029-10-01"), to: null }];
  assert.ok("error" in planOwnerHandover(alice, d("2029-11-01"), e("2029-11-15")), "Bob 01–15/11 chồng lên Alice không hạn ⇒ TỪ CHỐI, không đóng Alice");
  const bg = planOwnerHandover(alice, d("2029-11-01"), null);
  assert.ok("close" in bg && bg.close[0].id === "alice" && bg.close[0].after.getTime() === d("2029-11-01").getTime() - 1, "OWNER mới không hạn ⇒ Alice đóng ở ngày liền trước");
  assert.ok("error" in planOwnerHandover(alice, d("2029-10-01"), null), "cùng ngày bắt đầu ⇒ từ chối");
  assert.deepEqual(planOwnerHandover([], d("2029-11-01"), e("2029-11-15")), { close: [] });
  // Vòng review 2: dòng cũ KẾT THÚC TRƯỚC ngày kết thúc của dòng mới ⇒ không cắt quyền nào sau hạn của nó ⇒ cho bàn giao.
  const coHan = planOwnerHandover([{ id: "c", from: d("2029-10-01"), to: e("2029-11-10") }], d("2029-11-01"), e("2029-11-30"));
  assert.ok("close" in coHan && coHan.close.length === 1, "dòng cũ hết hạn trước dòng mới ⇒ bàn giao được");
  const tenDk = planOwnerHandover(alice, d("2029-11-01"), e("2029-11-15"), "điều khoản (mặc định công ty)");
  assert.ok("error" in tenDk && !/OWNER/.test(tenDk.error) && /điều khoản \(mặc định công ty\)/.test(tenDk.error), "câu báo của điều khoản không nói OWNER");
  // Vòng review 2 (MAJOR): tháng 9 đã khoá, Alice kết thúc 30/09 để Bob nhận từ 01/10 — đổi hiệu lực TỪ 01/10.
  assert.equal(endChangesFromKey("2026-09-30"), "2026-10-01", "kết thúc ở ngày cuối tháng khoá chỉ đổi hiệu lực từ ngày đầu tháng sau");
  assert.equal(endChangesFromKey("2026-12-31"), "2027-01-01");

  /* ══ 13 · TÍNH LẠI CHO CÙNG KẾT QUẢ ══ */
  const lan2 = codeBonusClaims({ productId: "B", code: "B", eligible: 10 * TR, allocated: 10 * TR, segments: [seg(1, { m1: 1 * TR, m3: 3 * TR })], assignments: asg, terms: [terms(null, 6)] });
  assert.deepEqual(
    lan2.claims.map((c) => [c.key, c.demand]),
    cB.claims.map((c) => [c.key, c.demand]),
    "13. hàm thuần — hai lần ra cùng kết quả",
  );
}

/* ═══════════════════════ ĐOẠN CỦA NHIỀU MÃ, MỘT LƯỢT ĐO (review) ═══════════════════════ */
async function testSegments() {
  const f = (revenue: number, ad: Record<string, number> = {}): CodeFacts => ({ revenue, adSpendByEmployee: new Map(Object.entries(ad)), revenueByEmployee: new Map(), unattributedAdSpend: 0, unattributedRevenue: 0 });
  const giua = d("2029-03-11");
  const sau = d("2029-03-21");
  const book = {
    assignments: [owner("A", "m1", 10, T_FROM, new Date(giua.getTime() - 1)), owner("A", "m2", 10, giua), owner("B", "m1", 10, T_FROM, new Date(sau.getTime() - 1)), owner("B", "m3", 10, sau)],
    terms: [] as CodeTerms[],
  };
  const goi: string[] = [];
  // Mảnh chung: 01–10 · 11–20 · 21–31. A: 01–10 | 11–31. B: 01–20 | 21–31.
  const doanhThu: Record<string, Record<string, number>> = {
    "2029-03-01": { A: 10, B: 30 },
    "2029-03-11": { A: 20, B: 30 },
    "2029-03-21": { A: 10, B: 40 },
  };
  const factsFor = async (p: Period) => {
    goi.push(p.fromKey ?? "");
    const r = doanhThu[p.fromKey ?? ""] ?? {};
    return new Map(Object.entries(r).map(([k, v]) => [k, f(v, { [k === "A" ? "m1" : "m3"]: v })]));
  };
  const out = await buildCodeSegmentsFor(["A", "B"], { from: T_FROM, to: T_TO }, book, new Map(), factsFor);
  assert.deepEqual(goi.sort(), ["2029-03-01", "2029-03-11", "2029-03-21"], "7. hai mã, bốn mốc ⇒ ĐÚNG ba lượt đo (mảnh chung), không phải một lượt mỗi đoạn mỗi mã");
  assert.deepEqual(
    out.get("A")?.map((s) => s.weight),
    [0.25, 0.75],
    "đoạn của A cộng các mảnh nằm trong nó (10 | 20 + 10)",
  );
  assert.deepEqual(
    out.get("B")?.map((s) => s.weight),
    [0.6, 0.4],
  );
  assert.equal(out.get("A")?.[1].adSpendByEmployee.get("m1"), 30, "căn cứ trọng số cũng được cộng theo mảnh");
  // Không mảnh nào có doanh thu ⇒ không biết phần của từng đoạn ⇒ null (người gọi đưa vào chờ), KHÔNG chia đều.
  const rongDt = await buildCodeSegmentsFor(["A"], { from: T_FROM, to: T_TO }, book, new Map(), async () => new Map());
  assert.equal(rongDt.get("A"), null, "10. không có doanh thu để chia đoạn ⇒ chờ, không 1/n");
  // Không đổi giữa tháng ⇒ dùng số của tháng, không đo thêm lượt nào.
  let them = 0;
  const motDoan = await buildCodeSegmentsFor(["Z"], { from: T_FROM, to: T_TO }, book, new Map([["Z", f(5)]]), async () => {
    them += 1;
    return new Map();
  });
  assert.deepEqual([them, motDoan.get("Z")?.length, motDoan.get("Z")?.[0].weight], [0, 1, 1]);
  // Dòng sửa tay kết thúc GIỮA ngày cuối tháng không đẻ ra đoạn ngược chiều.
  const lech = segmentBounds("A", T_FROM, T_TO, [owner("A", "m1", 10, T_FROM, new Date("2029-03-31T10:00:00+07:00"))], []);
  assert.deepEqual(lech.length, 1, "11. mốc ngoài kỳ bị bỏ");
  assert.ok(lech.every((b) => b.from.getTime() <= b.to.getTime()));
}

/* ═══════════════════════ HÀNG RÀO MÃ NGUỒN ═══════════════════════ */
function testSourceFences() {
  const lib = readFileSync("lib/payroll/code-ledger.ts", "utf8");
  assert.ok(!/from "@\/db"|getDb|new Date\(\)/.test(lib), "phép tính sổ mã là hàm THUẦN: không đọc CSDL, không đọc đồng hồ");
  const q = readFileSync("lib/queries/payroll.ts", "utf8");
  assert.ok(/marketers\.products\.map\(\(p\) => \(\{ productId: p\.productId, code: p\.code, profit: p\.profit \}\)\)/.test(q), "lợi nhuận mã lấy từ products[].profit — MỘT nguồn, không tự tính lại");
  const act = readFileSync("lib/actions/payroll-code.ts", "utf8");
  assert.ok(/pg_advisory_xact_lock/.test(act) && /guardSecondApproval/.test(act) && /canAdministerPayroll/.test(act), "đường ghi phân công: khoá theo mã + duyệt người thứ hai + phạm vi quản trị lương");
  assert.ok(!/\.delete\(/.test(act), "không có đường xoá dòng phân công — chỉ kết thúc hoặc huỷ");
  const mig = readFileSync("drizzle/0249_product_marketer_assignments.sql", "utf8");
  assert.ok(!/INSERT INTO/i.test(mig), "migration không gieo dòng nào — không tự kích hoạt chính sách thưởng");
}

/* ═══════════════════════ LUỒNG THẬT TRÊN CSDL ═══════════════════════ */
const nv = (id: string, over: Partial<Employee> = {}): Employee => ({ id, name: `MKT ${id}`, shortName: id, department: "Marketing", aliases: [], accountIds: [], fixed: 0, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "", ...over });
const M1 = nv("cl-m1");
const M2 = nv("cl-m2");
const M4 = nv("cl-m4");
const M3 = nv("cl-m3", { percentPersonal: 30 });

async function reset(db: Db) {
  await db.delete(schema.payrollPeriods).where(sql`${schema.payrollPeriods.periodKey} like '2029-0%'`);
  await db.delete(schema.productMarketerAssignments).where(sql`${schema.productMarketerAssignments.id} like 'cl-%'`);
  await db.delete(schema.productBonusTerms).where(sql`${schema.productBonusTerms.id} like 'cl-%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'cl-%'`);
  await db.delete(schema.adSpends).where(sql`${schema.adSpends.id} like 'cl-%'`);
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'cl-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'cl-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'cl-%'`);
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like 'cl-%'`);
  await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.id} like 'cl-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'cl-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'cl-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
  await setSettingJson(PAYROLL_PROFIT_SIGNOFF_KEY, []);
  await db.delete(schema.users).where(sql`${schema.users.id} in ('cl-ky','cl-duyet')`);
  clearMemo();
}

/** Một đơn giao thành công, NHIỀU MÃ: mỗi phần tử là một dòng hàng của một mã. */
async function donGiao(db: Db, id: string, ngay: string, dongs: { product: "a" | "b"; revenue: number }[]) {
  const tong = dongs.reduce((t, x) => t + x.revenue, 0);
  await db.insert(schema.orders).values({ id, insertedAt: d(ngay), stage: "DELIVERED", status: 3, totalPriceAfterDiscount: tong, partnerFee: 0, returnFee: 0, cod: tong });
  for (const [i, x] of dongs.entries()) {
    await db.insert(schema.orderItems).values({ id: `${id}-i${i}`, orderId: id, variantId: `cl-var-${x.product}`, productId: `cl-prod-${x.product}`, productName: `Mã ${x.product}`, quantity: 1, lineTotal: x.revenue, unitCost: 0, isBonus: false });
  }
  await db.insert(schema.shipments).values({ id: `${id}-s`, orderId: id, vtpOrderNumber: `CL${id.replace(/\D/g, "").padStart(10, "0")}`, stage: "DELIVERED", shippingFee: 0, codAmount: tong, codCollected: tong, codStatus: "RECONCILED", deliveredAt: d(ngay) });
}

const ads = (db: Db, id: string, ngay: string, product: "a" | "b", marketerId: string, spend: number) =>
  db.insert(schema.adSpends).values({ id, platform: "facebook", campaign: `CL ${id}`, spend, spendDate: d(ngay), productId: `cl-prod-${product}`, marketerId, excluded: false });

const asgRow = (id: string, product: "a" | "b", employeeId: string, role: "OWNER" | "SUPPORT", o: { x?: number; method?: string; w?: number; from: string; to?: string }) => ({
  id,
  productId: `cl-prod-${product}`,
  employeeId,
  role,
  ownerRateBp: role === "OWNER" ? (o.x ?? 0) * 100 : null,
  weightMethod: role === "SUPPORT" ? (o.method ?? "AD_SPEND") : null,
  weightBp: role === "SUPPORT" && o.method === "MANUAL" ? (o.w ?? 0) * 100 : null,
  effectiveFrom: d(o.from),
  effectiveTo: o.to ? e(o.to) : null,
  policyRef: "QC-KIEM-THU",
  status: "APPROVED",
  // Dòng ĐÃ DUYỆT mang mốc duyệt — CSDL chặn APPROVED không mốc (0250).
  approvedAt: d("2028-12-01"),
});

async function testFlow(db: Db) {
  const ghiNhanTruoc = await getSettingJson<unknown>(PAYROLL_RECOGNITION_KEY, null);
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  await reset(db);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [M1, M2, M4] });
  for (const k of ["a", "b"] as const) {
    await db.insert(schema.products).values({ id: `cl-prod-${k}`, name: `Mã sổ ${k}`, customId: `CL-${k.toUpperCase()}` });
    await db.insert(schema.productVariants).values({ id: `cl-var-${k}`, productId: `cl-prod-${k}`, sku: `CL-${k}`, detail: "mặc định" });
  }
  await db.insert(schema.stockReceipts).values({ id: "cl-rc", kind: "RECEIPT", receivedAt: d("2028-12-20") });
  for (const k of ["a", "b"]) await db.insert(schema.stockReceiptItems).values({ id: `cl-ri-${k}`, receiptId: "cl-rc", variantId: `cl-var-${k}`, quantity: 100, unitCost: 100_000 });

  // Tháng 1: ĐƠN NHIỀU MÃ (A 30tr + B 10tr) — lợi nhuận đi theo DÒNG HÀNG. QC: M1 2tr và M2 1tr, M4 3tr trên A.
  await donGiao(db, "cl-o1", "2029-01-10", [
    { product: "a", revenue: 30 * TR },
    { product: "b", revenue: 10 * TR },
  ]);
  await ads(db, "cl-ad-1", "2029-01-10", "a", M1.id, 2 * TR);
  await ads(db, "cl-ad-2", "2029-01-10", "a", M2.id, 1 * TR);
  await ads(db, "cl-ad-3", "2029-01-10", "a", M4.id, 3 * TR);
  // Tháng 2: A lỗ (QC 20tr, doanh thu 2tr); B lãi lớn, chia hai nửa tháng (20tr · 60tr) quanh mốc đổi OWNER.
  await donGiao(db, "cl-o2", "2029-02-05", [{ product: "b", revenue: 20 * TR }]);
  await donGiao(db, "cl-o3", "2029-02-20", [
    { product: "b", revenue: 60 * TR },
    { product: "a", revenue: 2 * TR },
  ]);
  await ads(db, "cl-ad-4", "2029-02-10", "a", M1.id, 20 * TR);

  // Phân công: A — OWNER M1 10%, SUPPORT M2 + M4 theo chi phí QC. B — OWNER M2 10% tới 14/02, rồi M1 20% từ 15/02.
  // Mặc định công ty: Y = 5%.
  await db.insert(schema.productMarketerAssignments).values([
    asgRow("cl-as-1", "a", M1.id, "OWNER", { x: 10, from: "2029-01-01" }),
    asgRow("cl-as-2", "a", M2.id, "SUPPORT", { from: "2029-01-01" }),
    asgRow("cl-as-3", "a", M4.id, "SUPPORT", { from: "2029-01-01" }),
    asgRow("cl-as-4", "b", M2.id, "OWNER", { x: 10, from: "2029-01-01", to: "2029-02-14" }),
    asgRow("cl-as-5", "b", M1.id, "OWNER", { x: 20, from: "2029-02-15" }),
  ]);
  await db.insert(schema.productBonusTerms).values({ id: "cl-t-1", productId: null, supportPoolBp: 500, maxBonusAmount: null, effectiveFrom: d("2029-01-01"), effectiveTo: null, policyRef: "QC-KIEM-THU", status: "APPROVED", approvedAt: d("2028-12-01") });
  clearMemo();
  const T1 = monthReportPeriod("2029-01");
  const T2 = monthReportPeriod("2029-02");

  /* ── Chưa khai quy chế ⇒ sổ mã có, nhưng thưởng chưa kết luận ── */
  const r0 = await getPayrollReport(T1, "profit1");
  const base1 = r0.profitGate.ownBase ?? 0;
  assert.ok(base1 > 0, "chuẩn bị: tháng 1 công ty lãi");
  // Sổ mã mở ở tháng mở sổ của QUY CHẾ — chưa khai thì không có mốc 0 nào để cộng dồn.
  assert.equal(r0.profitGate.codeLedger.rows, null, "chưa khai quy chế ⇒ lũy kế của mã CHƯA BIẾT");
  assert.equal(r0.profitGate.codeLedger.claims.length, 0);
  assert.equal(r0.profitGate.codeLedger.pending.length, 4, "mọi phân công hiệu lực trong tháng 1 (4 dòng — dòng từ 15/02 không thuộc kỳ) đều CHỜ, không lặng lẽ biến mất");
  assert.equal(r0.lines.find((l) => l.employee.id === M1.id)?.salary, null, "chưa kết luận ⇒ thực nhận được duyệt CHƯA BIẾT");
  assert.ok(
    payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: profitGateReadiness(r0) }).some((b) => b.code === "PROFIT_CODE_PENDING"),
    "và chặn duyệt kỳ",
  );

  /* ── Khai quy chế: công ty lỗ lũy kế bằng nửa lợi nhuận tháng 1 ⇒ còn một nửa đủ điều kiện ── */
  const quyChe: ProfitGatePolicy = {
    version: 1,
    openingMonth: "2029-01",
    openingCumulative: -Math.floor(base1 / 2),
    openingHighWater: 0,
    openingPaidBonus: 0,
    poolCapPercent: 40,
    regulationRef: "Quy chế thưởng kiểm thử V2",
    reason: "Biên bản đối soát trong bài kiểm",
    approvedById: null,
    approvedByEmail: "kiem-thu@erp",
    approvedAt: new Date("2028-12-31T00:00:00Z").toISOString(),
  };
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe] });
  clearMemo();

  const r1 = await getPayrollReport(T1, "profit1");
  const g1 = r1.profitGate.result;
  const L1 = r1.profitGate.codeLedger;
  const pa = r1.marketers.products.find((p) => p.productId === "cl-prod-a")!;
  const pb = r1.marketers.products.find((p) => p.productId === "cl-prod-b")!;
  assert.equal(g1.status, "ELIGIBLE");
  const E1 = g1.eligibleProfit ?? 0;
  assert.equal(E1, base1 - Math.floor(base1 / 2));

  /* ══ 10 · ĐƠN NHIỀU MÃ: lợi nhuận theo dòng, khớp lợi nhuận công ty ══ */
  assert.ok(pa.revenue === 30 * TR && pb.revenue === 10 * TR, "10. doanh thu tách đúng theo dòng hàng của đơn nhiều mã");
  const rowA = L1.rows?.find((r) => r.productId === "cl-prod-a");
  const rowB = L1.rows?.find((r) => r.productId === "cl-prod-b");
  assert.equal(rowA?.profit, pa.profit, "lợi nhuận mã = products[].profit, tính MỘT lần");
  assert.equal(rowA?.openingCumulative, 0, "mọi mã bắt đầu ở 0 tại tháng mở sổ");
  const t = r1.marketers.totals;
  assert.equal(
    r1.marketers.products.reduce((s, p) => s + p.profit, 0) - t.testSpend - t.sharedUnallocated - t.logisticsAdjustmentUnallocated,
    t.profit,
    "ĐỐI SOÁT: Σ lợi nhuận mã − QC test − chi phí chung không chia − điều chỉnh vận chuyển không chia = lợi nhuận công ty",
  );

  /* ══ Phân bổ quỹ công ty xuống mã ══ */
  const sumElig = (rowA?.eligible ?? 0) + (rowB?.eligible ?? 0);
  const allocA = L1.allocated?.["cl-prod-a"] ?? 0;
  const allocB = L1.allocated?.["cl-prod-b"] ?? 0;
  assert.equal(allocA + allocB, Math.min(sumElig, E1), "Σ phân bổ xuống mã = min(Σ đủ điều kiện mã, đủ điều kiện công ty), đúng từng đồng");

  /* ══ 5 · 6 · 7 trên dữ liệu thật ══ */
  const kh = (emp: string, code: string, role: string) => L1.claims.find((c) => c.employeeId === emp && c.productId === code && c.role === role);
  // Tháng 1 mã A: QC đối soát được M1 (OWNER) 2tr · M2 1tr · M4 3tr ⇒ SUPPORT làm ra 4/6 lợi nhuận mã.
  const supA = L1.claims.filter((c) => c.productId === "cl-prod-a" && c.role === "SUPPORT");
  const phanSupA = Math.floor((allocA * 500 * 4) / (10_000 * 6));
  assert.equal(supA.reduce((s, c) => s + (c.demand ?? 0), 0), phanSupA, "6. Σ SupportBonus = phân bổ × Y% × phần SUPPORT làm ra");
  assert.equal(kh(M1.id, "cl-prod-a", "OWNER")?.demand, Math.floor((allocA * 1000) / 10_000) - phanSupA, "OwnerBonus = phân bổ × X% − Σ SupportBonus");
  const m2a = kh(M2.id, "cl-prod-a", "SUPPORT")?.demand ?? 0;
  const m4a = kh(M4.id, "cl-prod-a", "SUPPORT")?.demand ?? 0;
  assert.ok(Math.abs(m4a - 3 * m2a) <= 1, "6. trọng số theo chi phí QC đối soát được (1tr : 3tr)");
  assert.ok(kh(M2.id, "cl-prod-b", "OWNER") && kh(M2.id, "cl-prod-a", "SUPPORT"), "7. M2 vừa OWNER mã B vừa SUPPORT mã A");

  /* ══ 12 · cổng chung: Σ được duyệt ≤ quỹ công ty ══ */
  assert.ok((g1.allocatedTotal ?? 0) <= (g1.poolCap ?? 0), "12. tổng thưởng ≤ quỹ = lợi nhuận đủ điều kiện × % quy chế");
  const l1 = r1.lines.find((l) => l.employee.id === M1.id)!;
  assert.equal(l1.salary, l1.profitShare.eligible, "M1 không lương cứng ⇒ thực nhận được duyệt = phần đủ điều kiện");
  assert.equal(l1.provisionalSalary, l1.profitShare.provisional, "tạm tính gồm khoản theo mã (thành phần mới), không đếm hai lần");
  assert.equal(
    l1.codeBonusProvisional,
    L1.claims.filter((c) => c.employeeId === M1.id).reduce((s, c) => s + c.provisional, 0),
    "phần theo mã đứng RIÊNG để phiếu lương in thành một dòng (các dòng cộng ra đúng thực nhận)",
  );
  assert.equal((l1.provisionalSalary ?? 0) - l1.codeBonusProvisional, 0, "trừ phần theo mã ra là đúng công thức cũ (M1 không có khoản nào khác)");

  /* ══ 5 (review) · KỲ KHÔNG PHẢI THÁNG LỊCH: thưởng theo mã CHƯA BIẾT, không phải 0 ══ */
  const tuan = { key: "custom" as const, from: d("2029-01-05"), to: e("2029-01-11"), fromKey: "2029-01-05", toKey: "2029-01-11", label: "tuần" };
  const rTuan = await getPayrollReport(tuan, "profit1");
  assert.ok(rTuan.profitGate.codeLedger.pending.some((p) => p.employeeId === M1.id && /THÁNG LỊCH/.test(p.reason)), "kỳ tuần ⇒ khoản theo mã đứng ở chờ, có lý do");
  assert.equal(rTuan.lines.find((l) => l.employee.id === M1.id)?.salary, null, "và thực nhận của người có phân công là CHƯA BIẾT — không in số thiếu khoản thưởng");
  // Kỳ "Toàn bộ" (`?period=all`, không mốc): đọc sổ không lọc ngày — từng chết vì mốc giả năm 275760.
  const rAll = await getPayrollReport({ key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null }, "profit1");
  assert.ok(rAll.profitGate.codeLedger.pending.some((p) => p.employeeId === M1.id), "period=all ⇒ khoản theo mã CHƯA XÉT, có lý do");
  assert.equal(rAll.profitGate.codeLedger.assignmentCount, 5, "đọc đủ mọi phân công khi kỳ không có mốc");
  const chan1 = payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: r1.totalSalary, costWarnings: r1.marketers.costWarnings, lines: [], profitGate: profitGateReadiness(r1) });
  assert.ok(!chan1.some((b) => b.code === "PROFIT_CODE_PENDING"), "đủ căn cứ ⇒ không chặn");

  /* ══ 13 · tính lại cho cùng kết quả ══ */
  clearMemo();
  const r1b = await getPayrollReport(T1, "profit1");
  assert.deepEqual(
    r1b.profitGate.codeLedger.claims.map((c) => [c.key, c.demand]),
    L1.claims.map((c) => [c.key, c.demand]),
    "13. tính lại ra đúng cùng khoản, cùng số",
  );

  /* ══ 12 · ĐẾM HAI LẦN: người đang hưởng % LN cá nhân mà được giao thêm mã ⇒ chờ, chặn chốt ══ */
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [M1, M2, M4, M3] });
  await db.insert(schema.productMarketerAssignments).values(asgRow("cl-as-9", "b", M3.id, "SUPPORT", { method: "MANUAL", w: 100, from: "2029-01-01", to: "2029-01-31" }));
  clearMemo();
  const r1c = await getPayrollReport(T1, "profit1");
  assert.ok(r1c.profitGate.codeLedger.pending.some((p) => p.employeeId === M3.id && /hai lần/.test(p.reason)), "12. % LN cá nhân + thưởng theo mã ⇒ chờ chủ shop chọn");
  assert.equal(r1c.lines.find((l) => l.employee.id === M3.id)?.salary, null, "12. thực nhận được duyệt của người ấy CHƯA KẾT LUẬN");
  assert.ok(
    payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: profitGateReadiness(r1c) }).some((b) => b.code === "PROFIT_CODE_PENDING"),
    "12. khoản chờ đối soát CHẶN duyệt kỳ",
  );
  await db.delete(schema.productMarketerAssignments).where(eq(schema.productMarketerAssignments.id, "cl-as-9"));
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [M1, M2, M4] });
  clearMemo();

  /* ══ LỐI XÁC NHẬN TRỌNG SỐ — LUỒNG THẬT qua settings + getPayrollReport (review vòng 5) ══ */
  // 500k QC trên mã A CHƯA GÁN cho MKTer nào ⇒ hai SUPPORT theo chi phí QC đứng ở chờ loại WEIGHT_PARTIAL.
  await db.insert(schema.adSpends).values({ id: "cl-ad-chuagan", platform: "facebook", campaign: "CL chưa gán", spend: 500_000, spendDate: d("2029-01-12"), productId: "cl-prod-a", marketerId: null, excluded: false });
  clearMemo();
  const rCho = await getPayrollReport(T1, "profit1");
  const choA = rCho.profitGate.codeLedger.pending.filter((p) => p.productId === "cl-prod-a" && p.kind === "WEIGHT_PARTIAL");
  assert.deepEqual(
    choA.map((p) => p.employeeId).sort(),
    [M1.id, M2.id, M4.id].sort(),
    "chuẩn bị: QC chưa gán trên A ⇒ hai SUPPORT VÀ OWNER chờ (phần OWNER = X% trừ phần SUPPORT), mang dấu vân tay",
  );
  assert.equal(choA.find((p) => p.employeeId === M1.id)?.provisional, null, "phần OWNER chưa tính được ⇒ không in một số tạm");
  assert.ok(!rCho.profitGate.codeLedger.claims.some((c) => c.productId === "cl-prod-a"));
  const vtA = [...new Set(choA.map((p) => p.fingerprint as string))];
  await setSettingJson(PAYROLL_CODE_WEIGHT_CONFIRM_KEY, [
    { id: "cl-xn-1", contentId: "cl-xn", monthKey: "2029-01", productId: "cl-prod-a", fingerprints: vtA, reason: "kiểm thử: QC chưa gán là chiến dịch thử, không thuộc SUPPORT nào", requestedById: null, requestedByEmail: "kiem-thu@erp", approvedById: null, approvedByEmail: "duyet@erp", confirmedAt: "2029-02-01T00:00:00.000Z", revokedAt: null },
  ]);
  clearMemo();
  const rXn = await getPayrollReport(T1, "profit1");
  assert.equal(rXn.profitGate.codeLedger.confirmations.length, 1, "lời xác nhận ĐỌC LẠI được từ settings (mảng không bị gộp thành object)");
  assert.ok(!rXn.profitGate.codeLedger.pending.some((p) => p.productId === "cl-prod-a" && p.kind === "WEIGHT_PARTIAL"), "đã xác nhận đúng số đo ⇒ hết chờ");
  assert.equal(rXn.profitGate.codeLedger.claims.filter((c) => c.productId === "cl-prod-a" && c.role === "SUPPORT").length, 2, "hai khoản SUPPORT có lại");
  assert.ok(rXn.profitGate.codeLedger.claims.some((c) => c.productId === "cl-prod-a" && c.role === "OWNER"), "khoản OWNER có lại cùng lời xác nhận");
  // Số đo đổi SAU khi xác nhận (thêm 1 ₫ chưa gán) ⇒ quay lại chờ, nói rõ.
  await db.insert(schema.adSpends).values({ id: "cl-ad-chuagan-2", platform: "facebook", campaign: "CL chưa gán 2", spend: 1, spendDate: d("2029-01-13"), productId: "cl-prod-a", marketerId: null, excluded: false });
  clearMemo();
  const rDoi = await getPayrollReport(T1, "profit1");
  assert.ok(rDoi.profitGate.codeLedger.pending.some((p) => p.productId === "cl-prod-a" && /SỐ ĐO ĐÃ ĐỔI/.test(p.reason)), "thêm 1 ₫ chưa gán ⇒ lời xác nhận cũ không áp");
  // Lời xác nhận đã huỷ ⇒ không áp.
  await db.delete(schema.adSpends).where(eq(schema.adSpends.id, "cl-ad-chuagan-2"));
  await setSettingJson(PAYROLL_CODE_WEIGHT_CONFIRM_KEY, [
    { id: "cl-xn-1", contentId: "cl-xn", monthKey: "2029-01", productId: "cl-prod-a", fingerprints: vtA, reason: "kiểm thử", requestedById: null, requestedByEmail: "kiem-thu@erp", approvedById: null, approvedByEmail: "duyet@erp", confirmedAt: "2029-02-01T00:00:00.000Z", revokedAt: "2029-02-02T00:00:00.000Z" },
  ]);
  clearMemo();
  assert.ok((await getPayrollReport(T1, "profit1")).profitGate.codeLedger.pending.some((p) => p.productId === "cl-prod-a" && p.kind === "WEIGHT_PARTIAL"), "lời xác nhận đã huỷ ⇒ chờ lại");
  await db.delete(schema.adSpends).where(eq(schema.adSpends.id, "cl-ad-chuagan"));
  await setSettingJson(PAYROLL_CODE_WEIGHT_CONFIRM_KEY, []);
  clearMemo();

  /* ══ ĐỐI SOÁT THÁNG 1 trên dữ liệu thật của bài kiểm (Payroll V2 vận hành) ══ */
  const rcJan = await getMonthReconciliation("2029-01");
  const dongRc = (k: string) => rcJan.lines.find((l) => l.key === k);
  assert.equal(dongRc("revenue")?.basis, dongRc("revenue")?.source, "doanh thu cơ sở lương = doanh thu đo lại bằng CHÍNH ORDER_OUTCOME (40tr, đơn nhiều mã)");
  assert.equal(dongRc("revenue")?.status, "MATCHED", "mọi đơn đã giao đều có COD thực thu");
  assert.equal(dongRc("ads")?.status, "MATCHED", "tổng QC cơ sở = tổng QC máy chi phí");
  assert.equal(dongRc("ads-code-mk")?.source, 6 * TR, "6tr QC tháng 1 đều gắn mã A và có MKTer (đo thẳng trên bảng chi)");
  assert.equal(dongRc("ads-parts")?.status, "MATCHED", "bốn ô QC cộng lại đúng QC của cơ sở");
  assert.equal(dongRc("ads-outside-attribution")?.status, "MATCHED", "mọi đồng QC của mã nằm trong dòng của một MKTer");
  assert.equal(dongRc("cogs")?.status, "MATCHED", "mọi dòng hàng có giá vốn (phiếu nhập 100k)");
  assert.equal(dongRc("open-orders")?.status, "MATCHED", "mọi đơn tháng 1 đã có kết quả");
  assert.deepEqual([rcJan.codes.total, rcJan.codes.assigned], [2, 2], "2 mã có số, cả 2 đã phân công");

  /* ══ DUYỆT HAI CẤP: tháng 1 có thưởng đủ điều kiện ⇒ ký trên ẢNH CHỤP, duyệt bởi người khác ══ */
  const actor = { id: null, email: "kiem-thu@erp" };
  const p = schema.payrollPeriods;
  const anhKy = async () => ((await db.select({ snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, monthPeriodKey("2029-01")), eq(p.basis, "profit1"))))[0]?.snapshot ?? null) as PayrollSnapshot | null;
  const tinhKy = async () => calculatePayrollPeriodAs(actor, { from: "2029-01-01", to: "2029-01-31", basis: "profit1", note: "kiểm thử sổ mã" });
  const soat = async () => assert.ok("ok" in (await transitionPayrollRunAs(actor, { periodKey: monthPeriodKey("2029-01"), basis: "profit1", action: "SUBMIT_REVIEW", reason: "" })));
  const duyetBoi = (id: string) => transitionPayrollRunAs({ id, email: `${id}@t.local` }, { periodKey: monthPeriodKey("2029-01"), basis: "profit1", action: "APPROVE", reason: "" });
  for (const id of ["cl-ky", "cl-duyet"]) await db.insert(schema.users).values({ id, email: `${id}@t.local`, name: id, role: "ADMIN", passwordHash: "x", active: true }).onConflictDoNothing();
  // Tính kỳ KHÔNG bị chặn bởi đối soát (lương cứng không bị giữ): ảnh chụp mang bảng đối soát.
  const tinh = await tinhKy();
  assert.ok("ok" in tinh, `tính được kỳ tháng 1: ${"error" in tinh ? tinh.error : ""}`);
  const anh0 = await anhKy();
  assert.ok(anh0?.profitRecon?.fingerprint, "ảnh chụp mang bảng đối soát của tháng");
  assert.ok((anh0?.profitGate?.allocatedTotal ?? 0) > 0, "chuẩn bị: tháng 1 có thưởng đủ điều kiện");
  await soat();
  assert.match(("error" in (await duyetBoi("cl-duyet")) ? ((await duyetBoi("cl-duyet")) as { error: string }).error : ""), /CHƯA có chữ ký/, "chưa ký cấp 1 ⇒ không duyệt được");
  const kyActor = { id: "cl-ky", email: "cl-ky@t.local" };
  const saiMa = await signProfitReconAs(kyActor, { monthKey: "2029-01", fingerprintKey: "rc-sai", reason: "kiểm thử: đã đối chiếu từng dòng", acknowledgeIssues: true });
  assert.ok("error" in saiMa && /tính lại/.test(saiMa.error), "ký với mã ảnh chụp khác ⇒ từ chối (trang cũ)");
  if (anh0?.profitRecon?.status === "UNRECONCILED") {
    const chuaXem = await signProfitReconAs(kyActor, { monthKey: "2029-01", fingerprintKey: anh0.profitRecon.fingerprintKey, reason: "kiểm thử: đã đối chiếu từng dòng", acknowledgeIssues: false });
    assert.ok("error" in chuaXem && /đánh dấu đã xem/.test(chuaXem.error), "còn khoản chưa đối soát mà không đánh dấu đã xem ⇒ từ chối");
  }
  const ky1 = await signProfitReconAs(kyActor, { monthKey: "2029-01", fingerprintKey: anh0?.profitRecon?.fingerprintKey ?? "", reason: "kiểm thử: đã đối chiếu từng dòng", acknowledgeIssues: true });
  assert.ok("ok" in ky1 && ky1.created, `cấp 1 ký được trên ảnh chụp: ${"error" in ky1 ? ky1.error : ""}`);
  const tuDuyet = await duyetBoi("cl-ky");
  assert.ok("error" in tuDuyet && /MỘT NGƯỜI KHÁC/.test(tuDuyet.error), "người ký cấp 1 KHÔNG được duyệt cấp 2");
  // Huỷ chữ ký ⇒ duyệt bị chặn (review vòng 1: huỷ từng không có tác dụng sau khi đã tính).
  assert.ok("ok" in (await revokeProfitReconAs(kyActor, { id: "ok" in ky1 ? ky1.id : "", reason: "kiểm thử: phát hiện sai, huỷ" })));
  const sauHuy = await duyetBoi("cl-duyet");
  assert.ok("error" in sauHuy && /CHƯA có chữ ký/.test(sauHuy.error), "chữ ký đã huỷ ⇒ không duyệt được");
  // Ký lại; số đổi rồi TÍNH LẠI ⇒ ảnh mới ⇒ chữ ký cũ không áp.
  const ky2 = await signProfitReconAs(kyActor, { monthKey: "2029-01", fingerprintKey: anh0?.profitRecon?.fingerprintKey ?? "", reason: "kiểm thử: ký lại sau khi sửa", acknowledgeIssues: true });
  assert.ok("ok" in ky2 && ky2.created);
  await db.insert(schema.adSpends).values({ id: "cl-ad-tam", platform: "facebook", campaign: "CL tạm", spend: 1, spendDate: d("2029-01-20"), productId: null, marketerId: null, excluded: false });
  clearMemo();
  assert.ok("ok" in (await tinhKy()));
  assert.notEqual((await anhKy())?.profitRecon?.fingerprint, anh0?.profitRecon?.fingerprint, "chuẩn bị: 1 ₫ QC không ai nhận đổi bảng đối soát");
  await soat();
  const anhMoi = await duyetBoi("cl-duyet");
  assert.ok("error" in anhMoi && /CHƯA có chữ ký/.test(anhMoi.error), "ảnh chụp mới ⇒ chữ ký trên ảnh cũ không áp");
  await db.delete(schema.adSpends).where(eq(schema.adSpends.id, "cl-ad-tam"));
  clearMemo();
  assert.ok("ok" in (await tinhKy()));
  assert.equal((await anhKy())?.profitRecon?.fingerprint, anh0?.profitRecon?.fingerprint, "số trở lại như lúc ký ⇒ cùng dấu vân tay (bảng tất định)");
  await soat();
  const duyet = await duyetBoi("cl-duyet");
  assert.ok("ok" in duyet, `một người KHÁC duyệt được trên ảnh đã ký: ${"error" in duyet ? duyet.error : ""}`);
  // Huỷ chữ ký SAU khi duyệt ⇒ không khoá được.
  assert.ok("ok" in (await revokeProfitReconAs(kyActor, { id: "ok" in ky2 ? ky2.id : "", reason: "kiểm thử: huỷ sau khi duyệt" })));
  const khoa = await transitionPayrollRunAs({ id: "cl-duyet", email: "cl-duyet@t.local" }, { periodKey: monthPeriodKey("2029-01"), basis: "profit1", action: "LOCK", reason: "" });
  assert.ok("error" in khoa && /CHƯA có chữ ký/.test(khoa.error), "chữ ký bị huỷ sau khi duyệt ⇒ KHÔNG khoá / không sinh lệnh chuyển");
  const now = new Date();
  await db.update(p).set({ status: "LOCKED", approvedAt: now, lockedAt: now }).where(and(eq(p.periodKey, monthPeriodKey("2029-01")), eq(p.basis, "profit1")));
  const [kh1] = await db.select({ snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, monthPeriodKey("2029-01")), eq(p.basis, "profit1")));
  const snap1 = kh1.snapshot as PayrollSnapshot;
  assert.equal(snap1.profitGate?.codes?.find((c) => c.productId === "cl-prod-a")?.profit, pa.profit, "ảnh chụp giữ lợi nhuận từng mã của tháng 1");

  /* ══ 10 · CHI PHÍ / HOÀN CỦA THÁNG 1 PHÁT SINH SAU KHI KHOÁ ══ */
  await db.insert(schema.expenses).values({ id: "cl-exp-muon", category: "OTHER", description: "Chi phí tháng 1 nhập muộn", amount: 4 * TR, occurredAt: d("2029-01-25") });
  clearMemo();

  const r2 = await getPayrollReport(T2, "profit1");
  const L2 = r2.profitGate.codeLedger;
  const b2 = L2.rows?.find((r) => r.productId === "cl-prod-b");
  const a2 = L2.rows?.find((r) => r.productId === "cl-prod-a");
  assert.equal(b2?.openingCumulative, snap1.profitGate?.codes?.find((c) => c.productId === "cl-prod-b")?.profit, "9/10. lũy kế đầu tháng 2 của mã B = số ĐÃ CHỤP tháng 1 — đổi OWNER không reset, chi phí muộn không viết lại tháng đã khoá");
  assert.ok((a2?.profit ?? 0) < 0, "chuẩn bị: mã A lỗ tháng 2");
  assert.equal(a2?.eligible, 0, "4. mã A còn lỗ ⇒ không đủ điều kiện");
  assert.ok(!L2.claims.some((c) => c.productId === "cl-prod-a"), "4. không ai nhận thưởng mã A tháng 2");

  /* ══ 8 · 9 · ĐỔI OWNER + ĐỔI TỶ LỆ GIỮA THÁNG ══ */
  const ownersB = L2.claims.filter((c) => c.productId === "cl-prod-b" && c.role === "OWNER");
  assert.deepEqual(
    ownersB.map((c) => c.employeeId),
    [M2.id, M1.id],
    "9. hai OWNER nối tiếp, mỗi người một đoạn",
  );
  assert.equal(r2.profitGate.result.status, "ELIGIBLE", "chuẩn bị: tháng 2 công ty đủ điều kiện (mã B lãi lớn hơn mã A lỗ)");
  assert.equal(r2.profitGate.result.established, true, "tháng 1 đã khoá ⇒ số dư đủ căn cứ");
  const allocB2 = L2.allocated?.["cl-prod-b"] ?? 0;
  assert.ok(allocB2 > 0, "chuẩn bị: mã B được phân bổ");
  assert.equal(ownersB[0].demand, Math.floor((Math.floor(allocB2 * 0.25) * 1000) / 10_000), "8. đoạn 1 (25% doanh thu giao thành công) × X 10%");
  assert.equal(ownersB[1].demand, Math.floor((Math.floor(allocB2 * 0.75) * 2000) / 10_000), "8. đoạn 2 (75%) × X 20%");
  // Mã lỗ không kéo quỹ của mã lãi: phần công ty phân xuống chỉ đi vào mã có phần đủ điều kiện.
  assert.equal(L2.allocated?.["cl-prod-a"] ?? 0, 0);

  /* ══ LƯỢC ĐỒ CŨ (sổ MIGRATION_SERVE_COMPAT, tag 0249_product_marketer_assignments): chưa có hai bảng ⇒ sổ rỗng, bảng lương vẫn chạy ══ */
  const journal249 = (JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] }).entries.find((x) => x.tag.endsWith("_product_marketer_assignments"));
  assert.equal(MIGRATION_0249_WHEN, journal249?.when, `MIGRATION_0249_WHEN phải là mốc \`when\` của migration product_marketer_assignments trong sổ (tìm thấy: ${journal249?.tag ?? "không có"} — đánh số lại thì sửa cả hằng số lẫn tag trong MIGRATION_SERVE_COMPAT)`);
  await db.execute(sql`alter table "product_marketer_assignments" rename to "pma_tam_cl"`);
  await db.execute(sql`alter table "product_bonus_terms" rename to "pbt_tam_cl"`);
  const dongSo = await db.execute(sql`select hash, created_at from "drizzle"."__drizzle_migrations" where created_at = ${MIGRATION_0249_WHEN}`);
  const so = ((dongSo as unknown as { rows?: { hash: string; created_at: string | number }[] }).rows ?? []) as { hash: string; created_at: string | number }[];
  try {
    clearMemo();
    // Bảng thiếu mà sổ migration nói 0249 ĐÃ áp ⇒ KHÔNG đọc thành rỗng (phân công có thể đã tồn tại).
    await assert.rejects(loadCodeBook(T1.from, T1.to), "bảng mất sau khi 0249 đã áp ⇒ ném, không in thực nhận thiếu khoản thưởng");
    await db.execute(sql`delete from "drizzle"."__drizzle_migrations" where created_at = ${MIGRATION_0249_WHEN}`);
    assert.deepEqual(await loadCodeBook(T1.from, T1.to), { assignments: [], terms: [] }, "0249 chưa áp ⇒ chưa ai được phân công — không ném lỗi");
    assert.deepEqual(await listCodeBook(), []);
    const rCu = await getPayrollReport(T2, "profit1");
    assert.deepEqual([rCu.profitGate.codeLedger.claims.length, rCu.profitGate.codeLedger.pending.length], [0, 0], "bảng lương chạy y như trước V2");
  } finally {
    for (const r of so) await db.execute(sql`insert into "drizzle"."__drizzle_migrations" (hash, created_at) values (${r.hash}, ${r.created_at})`);
    await db.execute(sql`alter table "pma_tam_cl" rename to "product_marketer_assignments"`);
    await db.execute(sql`alter table "pbt_tam_cl" rename to "product_bonus_terms"`);
  }
  assert.equal(so.length, 1, "chuẩn bị: sổ migration của CSDL kiểm thử có dòng 0249");

  await reset(db);
  await setSettingJson(PAYROLL_RECOGNITION_KEY, ghiNhanTruoc);
  clearMemo();
}

export async function testPayrollCodeLedger(db: Db) {
  testPure();
  await testSegments();
  testSourceFences();
  await testFlow(db);
  console.log("✓ sổ lợi nhuận theo mã + thưởng OWNER / SUPPORT (13 ca)");
}
