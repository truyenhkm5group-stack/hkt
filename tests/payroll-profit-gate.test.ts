/**
 * ═══════ CỔNG LỖ LŨY KẾ TOÀN CÔNG TY CHO THƯỞNG % LỢI NHUẬN ═══════
 *
 * Đặc tả: `docs/payroll-profit-gate.md`. Phép tính: `lib/payroll/profit-gate.ts`.
 *
 * Tám ca chủ shop bắt buộc (19/10/2026), mỗi ca một khối, đánh số đúng như yêu cầu:
 *   1. công ty lỗ lũy kế, cá nhân lãi ⇒ thưởng lợi nhuận mới = 0
 *   2. công ty lãi tháng này nhưng vẫn lỗ lũy kế ⇒ thưởng = 0
 *   3. công ty vừa bù hết lỗ ⇒ chỉ phần vượt ngưỡng được xét
 *   4. đã thưởng kỳ trước rồi phát sinh lỗ ⇒ không chia trùng, không chia trước khi phục hồi
 *   5. hoàn/huỷ và chi phí phát sinh muộn ⇒ điều chỉnh đúng kỳ, không nhân đôi
 *   6. nhiều nhân viên ⇒ tổng thưởng không vượt quỹ
 *   7. thiếu dữ liệu chi phí ⇒ chặn tự động duyệt thưởng
 *   8. kỳ đã khoá ⇒ bất biến
 *
 * Phần THUẦN chạy không cần CSDL; phần NỐI chạy qua đúng `getPayrollReport` mà `/payroll` gọi, trên
 * dữ liệu tháng 01–02/2028 (tiền tố `pg-`) để không đụng fixture của bộ khác.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { DEFAULT_PROFIT_GATE_CONFIG, PAYROLL_PROFIT_GATE_KEY, PROFIT_GATE_LOSS_MESSAGE, isProfitLinked, isRegularVariable, poolCapLabel, poolCapPercentFor, type ProfitGatePolicy } from "@/lib/constants/payroll-profit-gate";
import { payrollFinalizeBlockers } from "@/lib/constants/payroll-readiness";
import {
  allocatePool,
  eligibleProfitOf,
  evaluateProfitGate,
  lockedMonthStep,
  nextOpening,
  type ProfitGateClaim,
  type ProfitGateInput,
  type ProfitGateOpening,
} from "@/lib/payroll/profit-gate";
import { calculatePayrollPeriodAs, transitionPayrollRunAs } from "@/lib/payroll/run-service";
import { snapshotNetPay } from "@/lib/payroll/payslip-delivery";
import { getPayrollReport, monthReportPeriod, profitGateReadiness } from "@/lib/queries/payroll";
import { buildPayrollSnapshot, type PayrollSnapshot } from "@/lib/queries/payroll-period";
import { lockedMonthFigures, monthPeriodKey, monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { PAYROLL_RECOGNITION_KEY } from "@/lib/queries/payroll-cost";
import { PAYROLL_CARRYOVER_KEY } from "@/lib/constants/payroll-carryover";
import { PAYROLL_PROFIT_SIGNOFF_KEY } from "@/lib/constants/payroll-reconciliation";

const TR = 1_000_000;
const mo = (cumulative: number, highWater: number, paidToDate = 0, established = true): ProfitGateOpening => ({
  cumulative,
  highWater,
  paidToDate,
  established,
  basis: "DECLARATION",
  reason: "khai báo trong bài kiểm",
});
const claim = (key: string, provisional: number | null, demand: number | null = provisional): ProfitGateClaim => ({ key, employeeId: key.split(":")[0], label: key, provisional, demand });
const run = (over: Partial<ProfitGateInput>) =>
  evaluateProfitGate({
    monthKey: "2028-01",
    applicable: { ok: true },
    policy: { poolCapPercent: 40 },
    opening: mo(0, 0),
    openingProblem: null,
    periodBase: 0,
    costIssues: [],
    claims: [],
    ...over,
  });

function testPure() {
  /* ══ 1 · CÔNG TY LỖ LŨY KẾ, CÁ NHÂN LÃI ⇒ THƯỞNG LỢI NHUẬN MỚI = 0 ══ */
  const c1 = run({ opening: mo(-100 * TR, 0), periodBase: -5 * TR, claims: [claim("B:PERSONAL", 3 * TR)] });
  assert.equal(c1.status, "NO_ELIGIBLE_PROFIT", "1. công ty còn lỗ ⇒ chưa đủ điều kiện");
  assert.equal(c1.allocations[0].eligible, 0, "1. lãi CÁ NHÂN 3tr không vượt qua được lỗ của CÔNG TY ⇒ thưởng 0");
  assert.equal(c1.allocations[0].withheld, 3 * TR, "1. phần tạm tính không bị xoá — nó hiện là 'chưa đủ điều kiện'");
  assert.ok(c1.allocations[0].reason?.includes(PROFIT_GATE_LOSS_MESSAGE), "1. lý do in đúng câu chủ shop yêu cầu");
  assert.equal(c1.closingCumulative, -105 * TR, "1. tháng lỗ làm lỗ lũy kế TĂNG thêm");
  assert.equal(c1.established, true);

  /* ══ 2 · LÃI THÁNG NÀY NHƯNG VẪN LỖ LŨY KẾ ⇒ 0 ══ */
  const c2 = run({ opening: mo(-100 * TR, 0), periodBase: 30 * TR, claims: [claim("A:SHOP", 10_500_000, 0), claim("B:PERSONAL", 3 * TR)] });
  assert.equal(c2.status, "NO_ELIGIBLE_PROFIT", "2. lãi 30tr < lỗ 100tr ⇒ chưa đủ điều kiện");
  assert.equal(c2.eligibleProfit, 0);
  assert.equal(c2.poolCap, 0);
  assert.deepEqual(c2.allocations.map((a) => a.eligible), [0, 0], "2. không ai được thưởng lợi nhuận");
  assert.equal(c2.closingCumulative, -70 * TR, "2. lãi tháng đi bù lỗ: còn −70tr");
  assert.ok(c2.message.includes("70.000.000"), "2. màn hình nói còn bao nhiêu phải bù");

  /* ══ 3 · VỪA BÙ HẾT LỖ ⇒ CHỈ PHẦN VƯỢT NGƯỠNG ══ */
  const E3 = eligibleProfitOf(mo(-10 * TR, 0), 15 * TR);
  assert.equal(E3, 5 * TR, "3. lỗ 10tr, lãi 15tr ⇒ chỉ 5tr đủ điều kiện");
  const c3 = run({
    opening: mo(-10 * TR, 0),
    periodBase: 15 * TR,
    claims: [claim("A:SHOP", Math.round(0.35 * 15 * TR), Math.round(0.35 * (E3 ?? 0))), claim("B:PERSONAL", 3 * TR)],
  });
  assert.equal(c3.status, "ELIGIBLE");
  assert.equal(c3.eligibleProfit, 5 * TR);
  assert.equal(c3.poolCap, 2 * TR, "3. quỹ = 40% × 5tr");
  assert.equal(c3.allocatedTotal, 2 * TR, "3. đề nghị 1,75tr + 3tr vượt quỹ ⇒ phân bổ đúng bằng quỹ");
  assert.ok((c3.allocations[0].eligible ?? 0) <= 1_750_000, "3. phần % LN toàn công ty tính trên 5tr, không trên 15tr");
  assert.ok(c3.allocations[0].reason?.includes("lợi nhuận đủ điều kiện"), "3. lý do nói rõ vì sao bị giảm");
  assert.equal(c3.closingCumulative, 15 * TR - 10 * TR - 2 * TR, "3. lũy kế cuối = −10 + 15 − 2");
  assert.equal(c3.closingHighWater, 3 * TR, "3. mốc mới = 0 + 5 − 2");

  /* ══ 4 · ĐÃ THƯỞNG RỒI LỖ ⇒ KHÔNG CHIA TRÙNG, PHẢI PHỤC HỒI TRƯỚC ══ */
  const t1 = run({ opening: mo(0, 0), periodBase: 100 * TR, claims: [claim("A:SHOP", 40 * TR)] });
  assert.equal(t1.allocatedTotal, 40 * TR);
  const o2 = nextOpening(mo(0, 0), t1, true, "");
  assert.ok(o2);
  assert.deepEqual([o2!.cumulative, o2!.highWater, o2!.paidToDate], [60 * TR, 60 * TR, 40 * TR], "4. sau tháng thưởng: lũy kế = mốc = 60tr, đã chi 40tr");
  const t2 = run({ opening: o2!, periodBase: -30 * TR, claims: [claim("A:SHOP", 0)] });
  assert.equal(t2.eligibleProfit, 0, "4. tháng lỗ ⇒ không có gì để chia");
  const o3 = nextOpening(o2!, t2, true, "")!;
  assert.equal(o3.highWater, 60 * TR, "4. mốc KHÔNG lùi khi lỗ");
  const t3 = run({ opening: o3, periodBase: 50 * TR, claims: [claim("A:SHOP", 20 * TR)] });
  assert.equal(t3.lossToRecover, 30 * TR, "4. phải lấy lại 30tr đã lỗ trước");
  assert.equal(t3.eligibleProfit, 20 * TR, "4. chỉ 20tr VƯỢT mốc cũ mới được chia — 30tr đầu không chia lại");
  assert.equal(t3.poolCap, 8 * TR);
  // Cùng chuỗi đi qua đường "tháng đã khoá" phải ra cùng số dư — hai đường dựng sổ không được lệch.
  const k2 = lockedMonthStep(lockedMonthStep(mo(0, 0), 100 * TR, 40 * TR), -30 * TR, 0);
  assert.deepEqual([k2.cumulative, k2.highWater, k2.paidToDate], [o3.cumulative, o3.highWater, o3.paidToDate], "4. dựng từ ảnh chụp = dựng từ phép tính");
  // Tháng cũ (khoá trước khi có cổng) đã chốt thưởng VƯỢT phần đủ điều kiện ⇒ phần vượt thành lỗ phải bù.
  const vuot = lockedMonthStep(mo(0, 0), 10 * TR, 15 * TR);
  assert.deepEqual([vuot.cumulative, vuot.highWater], [-5 * TR, 0], "4. trả vượt 5tr ⇒ lỗ cần bù 5tr, mốc không âm");

  /* ══ 5 · CHỨNG TỪ ĐẾN MUỘN ⇒ ĐÚNG KỲ, KHÔNG NHÂN ĐÔI ══
   *
   * Tháng 1 khoá với lợi nhuận 20tr; sau đó đơn tháng 1 hoàn về làm lợi nhuận thật của tháng 1 còn
   * 15tr. Tháng 1 đứng yên ở 20tr (ảnh chụp), và một ĐIỀU CHỈNH LŨY KẾ −5tr ghi vào tháng 2. Tổng hai
   * tháng bằng đúng tổng thật — không mất 5tr, không trừ 5tr hai lần.
   */
  const frozenJan = 20 * TR;
  const liveJan = 15 * TR;
  const ownFeb = 10 * TR;
  const sauJan = lockedMonthStep(mo(-50 * TR, 0), frozenJan, 0);
  const feb = run({ opening: sauJan, periodBase: ownFeb + (liveJan - frozenJan) });
  assert.equal(feb.closingCumulative, -50 * TR + liveJan + ownFeb, "5. lũy kế cuối tháng 2 = −50 + 15 + 10 — đúng tổng sống, không nhân đôi");
  // Ảnh chụp mang lợi nhuận RIÊNG của tháng và khoản điều chỉnh RIÊNG — tháng sau đo chênh trên phần riêng.
  const dcFeb = { id: "x", monthKey: "2028-02", aboutMonth: "2028-01", amount: -5 * TR, reason: "đơn tháng 1 hoàn muộn", approvedById: null, approvedByEmail: "kt@erp", approvedAt: "2028-02-10T00:00:00.000Z" };
  const snapFeb = { basis: "profit1", totalProfit: 0, lines: [], profitGate: { periodBase: ownFeb, lateAdjustments: [dcFeb], allocatedTotal: 0 } } as unknown as PayrollSnapshot;
  const fig = lockedMonthFigures(snapFeb);
  assert.deepEqual([fig?.base, fig?.ownBase], [5 * TR, 10 * TR], "5. sổ dùng lợi nhuận riêng + điều chỉnh đã CHỤP cùng tháng — một lần");

  /* ══ 6 · NHIỀU NHÂN VIÊN ⇒ TỔNG KHÔNG VƯỢT QUỸ, ĐÚNG TỪNG ĐỒNG ══ */
  let seed = 7;
  const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  for (let i = 0; i < 200; i += 1) {
    const n = 1 + Math.floor(rnd() * 12);
    const cs = Array.from({ length: n }, (_, k) => ({ key: `e${k}`, demand: Math.floor(rnd() * 50 * TR) }));
    const pool = Math.floor(rnd() * 80 * TR);
    const a = allocatePool(cs, pool);
    const tong = [...a.values()].reduce((t, v) => t + v, 0);
    const deNghi = cs.reduce((t, c) => t + c.demand, 0);
    assert.ok(tong <= pool, `6. tổng ${tong} không vượt quỹ ${pool}`);
    assert.equal(tong, Math.min(pool, deNghi), "6. vượt quỹ ⇒ phân bổ ĐÚNG bằng quỹ; không vượt ⇒ đủ đề nghị");
    for (const c of cs) assert.ok((a.get(c.key) ?? 0) <= c.demand, "6. không ai nhận hơn đề nghị của mình");
    assert.deepEqual([...allocatePool(cs, pool)], [...a], "6. chạy hai lần ra cùng kết quả");
  }
  const lon = allocatePool([{ key: "a", demand: 999_999_999_999 }, { key: "b", demand: 999_999_999_999 }], 1_000_000_001);
  assert.equal([...lon.values()].reduce((t, v) => t + v, 0), 1_000_000_001, "6. số lớn (vượt 2^53 khi nhân) vẫn đúng từng đồng");

  /* ══ 7 · THIẾU DỮ LIỆU CHI PHÍ ⇒ CHẶN DUYỆT THƯỞNG TỰ ĐỘNG ══ */
  const c7 = run({ opening: mo(0, 0), periodBase: 50 * TR, costIssues: ["Lợi nhuận KHÔNG trừ đồng lương nào"], claims: [claim("A:SHOP", 10 * TR), claim("C:SHOP", 0)] });
  assert.equal(c7.status, "DATA_INCOMPLETE");
  assert.equal(c7.allocations[0].eligible, null, "7. CHƯA BIẾT, không phải 0 và không phải số tạm tính");
  assert.equal(c7.allocations[1].eligible, 0, "7. khoản thật sự bằng 0 thì vẫn là 0 — không có gì để chặn");
  const chan7 = payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: { status: c7.status, established: c7.established, message: c7.message, hasProvisional: true } });
  assert.ok(chan7.some((b) => b.code === "PROFIT_GATE_DATA_INCOMPLETE"), "7. thiếu chứng từ chi phí ⇒ chặn chốt");
  assert.equal(run({ periodBase: null, claims: [claim("A:SHOP", 1)] }).status, "DATA_INCOMPLETE", "7. lợi nhuận chưa tính được ⇒ chưa kết luận");

  /* ── Chưa khai quy chế · kỳ không phải tháng · số dư mô phỏng ── */
  const chuaKhai = run({ policy: null, opening: null, periodBase: 50 * TR, claims: [claim("A:SHOP", 10 * TR)] });
  assert.equal(chuaKhai.status, "NOT_ESTABLISHED", "chưa khai quy chế ⇒ KHÔNG có đường lùi về trả như cũ");
  assert.equal(chuaKhai.allocations[0].eligible, null);
  const khongThang = run({ applicable: { ok: false, reason: "Kỳ 7 ngày" }, claims: [claim("A:SHOP", 10 * TR)] });
  assert.equal(khongThang.status, "NOT_APPLICABLE");
  const moPhong = run({ opening: mo(0, 0, 0, false), periodBase: 10 * TR, claims: [claim("A:SHOP", 3 * TR)] });
  assert.equal(moPhong.established, false, "số dư dựng từ tháng còn nháp ⇒ xem được, chưa đủ để chốt");
  const chanMoPhong = payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: { status: moPhong.status, established: false, message: moPhong.message, hasProvisional: true } });
  assert.ok(chanMoPhong.some((b) => b.code === "PROFIT_GATE_NOT_ESTABLISHED"));
  const daKetLuan = payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: { status: c2.status, established: true, message: c2.message, hasProvisional: true } });
  assert.ok(!daKetLuan.some((b) => b.code.startsWith("PROFIT_GATE")), "đã KẾT LUẬN 'chưa đủ điều kiện' là một câu trả lời — không chặn chốt");
  const khongCoGi = payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: { status: "NOT_ESTABLISHED", established: false, message: "", hasProvisional: false } });
  assert.equal(khongCoGi.length, 0, "không ai có thưởng % lợi nhuận ⇒ cổng không chặn gì");

  /* ── Phân loại: % LN cá nhân mang loại COMMISSION vẫn là thưởng lợi nhuận ── */
  assert.ok(isProfitLinked("COMMISSION", "PROFIT_PERSONAL"));
  assert.ok(!isProfitLinked("DEDUCTION", "PROFIT_PERSONAL"), "khấu trừ trên đại lượng lợi nhuận KHÔNG phải thưởng — coi là thưởng thì cổng kẹp về 0 và khoản trừ biến mất");
  assert.ok(!isProfitLinked("ADVANCE", "PROFIT_SHOP"));
  // Tạm tính 0 nhưng đề nghị / đủ điều kiện khác 0 (điều chỉnh muộn dương trên một tháng lỗ) vẫn phải qua cổng.
  const giaKetQua = run({ opening: mo(0, 0, 0, false), periodBase: 5 * TR, claims: [claim("A:SHOP", 0, 1_750_000)] });
  assert.equal(profitGateReadiness({ profitGate: { result: giaKetQua } } as unknown as Parameters<typeof profitGateReadiness>[0]).hasProvisional, true, "khoản tạm tính 0 nhưng có phần đủ điều kiện ⇒ cổng vẫn chặn khi chưa xác lập");
  assert.ok(isProfitLinked("PROFIT_SHARE", "REVENUE_PERSONAL"));
  assert.ok(!isProfitLinked("COMMISSION", "REVENUE_PERSONAL"));
  assert.ok(isRegularVariable("COMMISSION", "REVENUE_PERSONAL"), "hoa hồng doanh thu là chi phí thông thường, trừ vào cơ sở");
  assert.ok(!isRegularVariable("FIXED", null), "lương cứng đi qua nguồn ghi nhận chi phí, không trừ lần hai ở đây");

  /* ══ BẤT BIẾN TRÊN CHUỖI NGẪU NHIÊN ══ */
  for (let k = 0; k < 50; k += 1) {
    let o: ProfitGateOpening = mo(Math.round((rnd() - 0.7) * 200 * TR), 0);
    o = { ...o, highWater: Math.max(0, o.cumulative) };
    for (let t = 0; t < 24; t += 1) {
      const B = Math.round((rnd() - 0.45) * 60 * TR);
      const r = run({ opening: o, periodBase: B, claims: [claim("A:SHOP", Math.round(Math.max(B, 0) * 0.35), Math.round((eligibleProfitOf(o, B) ?? 0) * 0.35)), claim("B:PERSONAL", Math.round(rnd() * 5 * TR))] });
      assert.ok((r.allocatedTotal ?? 0) <= (r.poolCap ?? 0) && (r.poolCap ?? 0) <= (r.eligibleProfit ?? 0), "bất biến: đã chia ≤ quỹ ≤ LN đủ điều kiện");
      if (o.cumulative + B <= o.highWater) assert.equal(r.allocatedTotal, 0, "bất biến: chưa vượt mốc cao nhất ⇒ không phát sinh thưởng");
      o = nextOpening(o, r, true, "")!;
      assert.ok(o.highWater >= o.cumulative, "bất biến: mốc cao nhất luôn ≥ lũy kế");
    }
  }

  /* ── Lịch tháng ── */
  assert.equal(monthPeriodKey("2028-02"), "2028-02-01..2028-02-29", "năm nhuận");
  assert.deepEqual(monthsBetween("2027-11", "2028-02"), ["2027-11", "2027-12", "2028-01", "2028-02"], "qua mốc năm không reset");
  assert.deepEqual(monthsBetween("2028-03", "2028-02"), []);
}

/* ═══════════════════════ HÀNG RÀO MÃ NGUỒN ═══════════════════════ */
function testSourceFences() {
  const pol = readFileSync("lib/actions/payroll-policy.ts", "utf8");
  for (const m of ["Lịch trần có hai mốc trùng tháng", "Mốc trần không được trước tháng mở sổ", "Khai quỹ thưởng tối đa (một con số) hoặc lịch trần theo tháng", "Người nhận phần còn lại không có trong danh sách nhân sự"]) {
    assert.ok(pol.includes(m), `khai quy chế phải chặn: ${m}`);
  }
  const doc = (p: string) => readFileSync(p, "utf8");
  // P&L của khách SaaS là pháp nhân khác: cổng chỉ đọc CSDL của tổ chức đang xem qua `getDb()`.
  for (const f of ["lib/payroll/profit-gate.ts", "lib/queries/payroll-profit-gate.ts", "lib/constants/payroll-profit-gate.ts"]) {
    const s = doc(f);
    assert.ok(!/from "@\/lib\/(platform|org|saas)\//.test(s), `${f} không được đọc dữ liệu nền tảng / tổ chức khác`);
    assert.ok(!/getHomeDb|homeDb|forOrg\(/.test(s), `${f} không được mở CSDL của tổ chức khác`);
  }
  // Quyết toán tự động không được tự tính lại thưởng trên lợi nhuận sống.
  const st = doc("lib/payroll/settlement.ts");
  assert.ok(!/pct\(live\.totalProfit|pct\(live\.personalProfit/.test(st), "settlement.ts không được truy lĩnh / truy thu thưởng % lợi nhuận tự động");
  // Mọi đường ra tiền đọc số ĐƯỢC DUYỆT.
  assert.ok(doc("lib/payroll/payslip-delivery.ts").includes("if (line.profitShare) return line.salary;"), "phiếu lương & chuyển khoản đọc số đã qua cổng");
  assert.ok(doc("lib/payroll/run-service.ts").includes("profitGate: profitGateReadiness(report)"), "chốt kỳ đi qua cổng");
  // Điều chỉnh lũy kế: tháng chứng từ bắt buộc, sớm hơn tháng ghi, đã khoá; tháng ghi chưa khoá; ghi sổ dưới khoá tên.
  const act = doc("lib/actions/payroll-policy.ts");
  assert.ok(act.includes("if (d.aboutMonth >= d.monthKey)") && act.includes("CHƯA khoá — bản tính của chính tháng ấy đã gồm chứng từ này"), "điều chỉnh chỉ cho chứng từ của tháng ĐÃ KHOÁ, sớm hơn tháng ghi");
  assert.ok(act.includes("kỳ đã khoá là bất biến. Ghi điều chỉnh vào tháng đang mở."), "không ghi vào tháng đã khoá");
  assert.ok(act.includes("pg_advisory_xact_lock(hashtext('erp:payroll-profit-gate'))") && (act.match(/await ghiSoCong\(/g) ?? []).length === 2, "cả hai đường ghi sổ quy chế đi qua khoá tên");
  assert.ok(!/setSettingJson\(PAYROLL_PROFIT_GATE_KEY/.test(act), "không đường nào ghi thẳng ô quy chế ngoài khoá");
  // Phiếu người lao động TỰ XÁC NHẬN (/my-payslip) in cùng số thực nhận với lệnh chuyển — không in `netPay` tạm tính.
  const phieu = doc("components/payroll/payslip-breakdown.tsx");
  assert.ok(phieu.includes("<NetRow value={line.profitShare ? line.salary : engine.netPay} />"), "/my-payslip: thực nhận máy chung đọc số được duyệt");
  assert.equal((phieu.match(/<ProfitGateRows share=\{line\.profitShare\} \/>/g) ?? []).length, 2, "/my-payslip: cả hai đường tính in dòng 'chưa đủ điều kiện'");
  assert.ok(doc("app/(dashboard)/payroll/page.tsx").includes("profitGate: profitGateReadiness(report)"), "màn hình hỏi CÙNG một cổng với server");
}

/* ═══════════════════════ LUỒNG THẬT TRÊN CSDL ═══════════════════════ */
const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const A: Employee = { id: "pg-a", name: "Nhân sự A", shortName: "A", department: "Marketing", aliases: [], accountIds: [], fixed: 0, percentTotal: 35, percentPersonal: 0, percentRevenue: 0, active: true, note: "" };
const B: Employee = { id: "pg-b", name: "Nhân sự B", shortName: "B", department: "Marketing", aliases: [], accountIds: [], fixed: 0, percentTotal: 0, percentPersonal: 30, percentRevenue: 0, active: true, note: "" };

async function reset(db: Db) {
  await db.delete(schema.payrollPeriods).where(sql`${schema.payrollPeriods.periodKey} like '2028-0%'`);
  await db.delete(schema.expenses).where(sql`${schema.expenses.id} like 'pg-%'`);
  await db.delete(schema.adSpends).where(sql`${schema.adSpends.id} like 'pg-%'`);
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'pg-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'pg-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'pg-%'`);
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like 'pg-%'`);
  await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.id} like 'pg-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'pg-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'pg-%'`);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [] });
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, DEFAULT_PROFIT_GATE_CONFIG);
  await setSettingJson(PAYROLL_PROFIT_SIGNOFF_KEY, []);
  await db.delete(schema.users).where(sql`${schema.users.id} = 'pg-nguoi'`);
  clearMemo();
}

async function donGiao(db: Db, id: string, ngay: string, doanhThu: number) {
  await db.insert(schema.orders).values({ id, insertedAt: d(ngay), stage: "DELIVERED", status: 3, totalPriceAfterDiscount: doanhThu, partnerFee: 0, returnFee: 0, cod: doanhThu });
  await db.insert(schema.orderItems).values({ id: `${id}-i`, orderId: id, variantId: "pg-var", productId: "pg-prod", productName: "Mã cổng lợi nhuận", quantity: 2, lineTotal: doanhThu, unitCost: 0, isBonus: false });
  await db.insert(schema.shipments).values({
    id: `${id}-s`,
    orderId: id,
    vtpOrderNumber: `PG${id.replace(/\D/g, "").padStart(10, "0")}`,
    stage: "DELIVERED",
    shippingFee: 0,
    codAmount: doanhThu,
    codCollected: doanhThu,
    codStatus: "RECONCILED",
    deliveredAt: d(ngay),
  });
}

const dong = (r: Awaited<ReturnType<typeof getPayrollReport>>, id: string) => r.lines.find((l) => l.employee.id === id)!;

async function testFlow(db: Db) {
  // Không phụ thuộc thứ tự chạy: tự đặt nguồn ghi nhận lương mặc định, trả lại khi xong.
  const ghiNhanTruoc = await getSettingJson<unknown>(PAYROLL_RECOGNITION_KEY, null);
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  await reset(db);
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [A, B] });
  await db.insert(schema.products).values({ id: "pg-prod", name: "Mã cổng lợi nhuận" });
  await db.insert(schema.productVariants).values({ id: "pg-var", productId: "pg-prod", sku: "PG-VAR", detail: "mặc định" });
  await db.insert(schema.stockReceipts).values({ id: "pg-rc", kind: "RECEIPT", receivedAt: d("2027-12-20") });
  await db.insert(schema.stockReceiptItems).values({ id: "pg-ri", receiptId: "pg-rc", variantId: "pg-var", quantity: 100, unitCost: 100_000 });
  // Tháng 1: một đơn giao thành công 20tr; B chạy quảng cáo 2tr trên chính mã ấy ⇒ B LÃI cá nhân.
  await donGiao(db, "pg-o1", "2028-01-10", 20 * TR);
  await db.insert(schema.adSpends).values({ id: "pg-ads-1", platform: "facebook", campaign: "PG tháng 1", spend: 2 * TR, spendDate: d("2028-01-10"), productId: "pg-prod", marketerId: B.id, excluded: false });
  // Tháng 2: một đơn lớn — đủ để bù hết lỗ lũy kế khai báo.
  await donGiao(db, "pg-o2", "2028-02-10", 160 * TR);
  clearMemo();
  const T1 = monthReportPeriod("2028-01");
  const T2 = monthReportPeriod("2028-02");

  /* ── Chưa khai quy chế ⇒ chưa đủ điều kiện, chặn chốt, KHÔNG trả như cũ ── */
  const r0 = await getPayrollReport(T1, "profit1");
  assert.equal(r0.profitGate.result.status, "NOT_ESTABLISHED", "chưa khai quy chế ⇒ chưa xác lập");
  assert.ok(dong(r0, A.id).profitShare.provisional! > 0, "chuẩn bị: A có thưởng % LN toàn công ty tạm tính");
  assert.ok(dong(r0, B.id).personalProfit! > 0, "chuẩn bị: B LÃI cá nhân");
  assert.equal(dong(r0, A.id).profitShare.eligible, null, "chưa khai ⇒ đủ điều kiện là CHƯA BIẾT");
  assert.equal(dong(r0, A.id).salary, null, "và thực nhận được duyệt cũng CHƯA BIẾT — không in số tạm tính như thể đã duyệt");
  assert.equal(dong(r0, A.id).provisionalSalary, dong(r0, A.id).bonusTotal, "tạm tính vẫn giữ đúng công thức cũ để đối chiếu");
  assert.ok(profitGateReadiness(r0).hasProvisional);

  /* ── Khai quy chế: lỗ lũy kế 100tr, quỹ 40% ── */
  const quyChe: ProfitGatePolicy = {
    version: 1,
    openingMonth: "2028-01",
    openingCumulative: -100 * TR,
    openingHighWater: 0,
    openingPaidBonus: 0,
    poolCapPercent: 40,
    regulationRef: "Quy chế thưởng kiểm thử",
    reason: "Biên bản đối soát trong bài kiểm",
    approvedById: null,
    approvedByEmail: "kiem-thu@erp",
    approvedAt: new Date("2027-12-31T00:00:00Z").toISOString(),
  };
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe] });
  clearMemo();

  /* ══ 1 + 2 (nối) · THÁNG 1 LÃI NHƯNG CÔNG TY CÒN LỖ LŨY KẾ ⇒ 0 ══ */
  const r1 = await getPayrollReport(T1, "profit1");
  const g1 = r1.profitGate.result;
  assert.ok((r1.profitGate.ownBase ?? 0) > 0 && (r1.profitGate.ownBase ?? 0) < 100 * TR, "chuẩn bị: tháng 1 lãi nhưng không đủ bù 100tr");
  assert.equal(g1.status, "NO_ELIGIBLE_PROFIT");
  assert.equal(g1.established, true, "tháng mở sổ ⇒ số dư là KHAI BÁO, đủ căn cứ");
  assert.equal(dong(r1, A.id).profitShare.eligible, 0, "1. A: thưởng % LN toàn công ty = 0");
  assert.equal(dong(r1, B.id).profitShare.eligible, 0, "1. B: lãi CÁ NHÂN không vượt qua được lỗ của công ty ⇒ 0");
  assert.equal(dong(r1, B.id).profitShare.withheld, dong(r1, B.id).bonusPersonal, "1. toàn bộ tạm tính của B là 'chưa đủ điều kiện'");
  assert.ok(dong(r1, B.id).profitShare.reasons.some((x) => x.includes(PROFIT_GATE_LOSS_MESSAGE)));
  assert.equal(dong(r1, A.id).salary, 0, "thực nhận được duyệt = 0 (A không có lương cứng)");
  assert.equal(r1.totalSalary, 0);
  const chan1 = payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: r1.totalSalary, costWarnings: r1.marketers.costWarnings, lines: [], profitGate: profitGateReadiness(r1) });
  assert.ok(!chan1.some((b) => b.code.startsWith("PROFIT_GATE")), "đã kết luận ⇒ cổng không chặn chốt");

  /* ── Tháng KHÔNG có LN đủ điều kiện + % LN cá nhân CHƯA BIẾT (sổ lỗ chưa có số dư đầu) ⇒ thực nhận vẫn tính được ── */
  await setSettingJson(PAYROLL_CARRYOVER_KEY, { enabled: true, startMonth: "2027-11", startNote: "kiểm thử: sổ lỗ mở trước tháng đo, tháng trước chưa có dòng" });
  clearMemo();
  const r1cb = await getPayrollReport(T1, "profit1");
  assert.equal(dong(r1cb, B.id).bonusPersonal, null, "chuẩn bị: % LN cá nhân của B CHƯA BIẾT (sổ lỗ chưa có số dư đầu)");
  assert.equal(r1cb.profitGate.result.status, "NO_ELIGIBLE_PROFIT", "không có LN đủ điều kiện ⇒ kết luận chắc chắn, không chặn vì một số tạm tính chưa biết");
  assert.equal(dong(r1cb, B.id).profitShare.eligible, 0, "thưởng đủ điều kiện của B = 0");
  assert.equal(dong(r1cb, B.id).salary, (dong(r1cb, B.id).fixed ?? 0) + dong(r1cb, B.id).bonusRevenue + 0, "thực nhận = lương cứng + hoa hồng doanh thu + 0 — không phải «—»");
  assert.equal(dong(r1cb, A.id).salary, 0, "A (chỉ % toàn shop, 0% cá nhân) cũng tính được");
  await setSettingJson(PAYROLL_CARRYOVER_KEY, { enabled: false, startMonth: null, startNote: "" });
  clearMemo();

  /* ── Tháng 2 khi tháng 1 CHƯA KHOÁ ⇒ mô phỏng, chưa đủ căn cứ chốt ── */
  const r2nhap = await getPayrollReport(T2, "profit1");
  assert.deepEqual(r2nhap.profitGate.simulatedMonths, ["2028-01"], "tháng 1 còn nháp ⇒ được MÔ PHỎNG và nói ra");
  assert.equal(r2nhap.profitGate.result.established, false);
  for (const l of r2nhap.lines) {
    if (l.profitShare.claims.some((c) => c.provisional !== 0 || c.eligible !== 0)) assert.equal(l.salary, null, "số dư MÔ PHỎNG ⇒ thực nhận được duyệt là CHƯA KẾT LUẬN, không in số mô phỏng như số đã duyệt");
  }
  assert.ok(payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: 1, costWarnings: [], lines: [], profitGate: profitGateReadiness(r2nhap) }).some((b) => b.code === "PROFIT_GATE_NOT_ESTABLISHED"));

  /* ══ KHOÁ THÁNG 1 bằng đúng đường chốt kỳ ══ */
  const actor = { id: null, email: "kiem-thu@erp" };
  const tinh = await calculatePayrollPeriodAs(actor, { from: "2028-01-01", to: "2028-01-31", basis: "profit1", note: "kiểm thử cổng" });
  assert.ok("ok" in tinh, `tính được kỳ tháng 1: ${"error" in tinh ? tinh.error : ""}`);
  const p = schema.payrollPeriods;
  const now = new Date();
  await db.update(p).set({ status: "LOCKED", approvedAt: now, lockedAt: now }).where(and(eq(p.periodKey, monthPeriodKey("2028-01")), eq(p.basis, "profit1")));
  const [kh1] = await db.select({ snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, monthPeriodKey("2028-01")), eq(p.basis, "profit1")));
  const snap1 = kh1.snapshot as PayrollSnapshot;
  assert.equal(snap1.profitGate?.periodBase, r1.profitGate.ownBase, "ảnh chụp giữ lợi nhuận đem xét của tháng 1");
  assert.equal(snap1.profitGate?.allocatedTotal, 0);
  assert.equal(snapshotNetPay(snap1.lines.find((l) => l.employeeId === B.id)!), 0, "phiếu lương & chuyển khoản đọc số ĐƯỢC DUYỆT (0), không đọc số tạm tính");
  assert.equal(buildPayrollSnapshot(r1, T1, monthPeriodKey("2028-01")).lines.find((l) => l.employeeId === B.id)?.profitShare?.withheld, dong(r1, B.id).bonusPersonal);

  /* ══ 8 · KỲ ĐÃ KHOÁ BẤT BIẾN ══ */
  const tinhLai = await calculatePayrollPeriodAs(actor, { from: "2028-01-01", to: "2028-01-31", basis: "profit1", note: "thử tính lại" });
  assert.ok("error" in tinhLai && /KHOÁ/.test(tinhLai.error), "8. kỳ đã khoá không tính lại được");

  /* ══ 5 (nối) · CHI PHÍ THÁNG 1 NHẬP MUỘN SAU KHI KHOÁ ══ */
  await db.insert(schema.expenses).values({ id: "pg-exp-muon", category: "OTHER", description: "Chi phí tháng 1 nhập muộn", amount: 3 * TR, occurredAt: d("2028-01-20") });
  // Đổi giá vốn sau khi khoá (một lô nhập giá khác) — loại thay đổi mà "tính lại tháng cũ" sẽ biến thành lãi/lỗ ảo.
  await db.insert(schema.stockReceipts).values({ id: "pg-rc-2", kind: "RECEIPT", receivedAt: d("2028-02-20") });
  await db.insert(schema.stockReceiptItems).values({ id: "pg-ri-2", receiptId: "pg-rc-2", variantId: "pg-var", quantity: 10, unitCost: 900_000 });
  clearMemo();
  const r2tho = await getPayrollReport(T2, "profit1");
  assert.equal(r2tho.profitGate.result.openingBasis, "LOCKED_MONTHS", "tháng 1 đã khoá ⇒ số dư đầu tháng 2 dựng từ ảnh chụp");
  assert.equal(r2tho.profitGate.result.established, true);
  assert.equal(r2tho.profitGate.result.openingCumulative, -100 * TR + (snap1.profitGate?.periodBase ?? 0), "5/8. lũy kế đầu tháng 2 dùng số ĐÃ CHỤP của tháng 1 — chi phí muộn và lô giá mới KHÔNG tự viết lại tháng đã khoá");
  assert.equal(r2tho.profitGate.lateAdjustments.length, 0, "5. ERP KHÔNG tự đo lại tháng đã khoá (giá vốn / giá báo MKT / giả định hôm nay khác lúc khoá)");
  // Kế toán ghi ĐIỀU CHỈNH LŨY KẾ tường minh cho chi phí muộn của tháng 1, vào tháng 2 còn mở.
  const dc1 = { id: "pg-dc-1", monthKey: "2028-02", aboutMonth: "2028-01", amount: -3 * TR, reason: "chi phí tháng 1 nhập muộn sau ngày khoá", approvedById: null, approvedByEmail: "ke-toan@erp", approvedAt: "2028-02-21T00:00:00.000Z" };
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe], adjustments: [dc1] });
  clearMemo();
  const r2 = await getPayrollReport(T2, "profit1");
  const g2 = r2.profitGate.result;
  assert.deepEqual(r2.profitGate.lateAdjustments.map((a) => a.id), ["pg-dc-1"], "5. điều chỉnh tường minh của tháng 2 đi vào ĐÚNG tháng 2");
  assert.equal(g2.periodBase, (r2.profitGate.ownBase ?? 0) - 3 * TR, "5. lợi nhuận đem xét tháng 2 = của riêng tháng 2 + điều chỉnh, một lần");
  // Review vòng 6: có điều chỉnh về tháng 1 đang chờ ở tháng 2 (còn mở) ⇒ KHÔNG mở khoá tháng 1 được — tính lại
  // tháng 1 sẽ gồm chính chứng từ ấy, cộng với điều chỉnh là đếm hai lần.
  const moKhoa1 = await transitionPayrollRunAs({ id: "pg-nguoi", email: "chu@erp" }, { periodKey: monthPeriodKey("2028-01"), basis: "profit1", action: "UNLOCK", reason: "thử mở khoá khi còn điều chỉnh chờ" });
  assert.ok("error" in moKhoa1 && /ngược dấu/.test(moKhoa1.error), "5. còn điều chỉnh chờ về tháng 1 ⇒ phải ghi dòng ngược dấu trước khi mở khoá tháng 1");

  /* ══ 3 (nối) · THÁNG 2 BÙ HẾT LỖ ⇒ CHỈ PHẦN VƯỢT ══ */
  assert.equal(g2.status, "ELIGIBLE", "chuẩn bị: tháng 2 đủ bù lỗ");
  const E2 = Math.max(0, (g2.periodBase ?? 0) - (g2.lossToRecover ?? 0));
  assert.equal(g2.eligibleProfit, E2);
  assert.ok(E2 < (g2.periodBase ?? 0), "3. phần bù lỗ KHÔNG được chia");
  const a2 = dong(r2, A.id).profitShare.claims[0];
  assert.equal(a2.demand, Math.round(E2 * 0.35), "3. 35% tính trên LN ĐỦ ĐIỀU KIỆN, không trên LN tháng");
  assert.ok((a2.provisional ?? 0) > (a2.demand ?? 0), "3. tạm tính (LN tháng × 35%) lớn hơn đề nghị");

  /* ══ 6 (nối) · TỔNG KHÔNG VƯỢT QUỸ ══ */
  const tong = r2.lines.reduce((t, l) => t + (l.profitShare.eligible ?? 0), 0);
  assert.equal(g2.poolCap, Math.floor(E2 * 0.4));
  assert.ok(tong <= (g2.poolCap ?? 0), "6. tổng thưởng của mọi người ≤ quỹ");
  assert.equal(tong, g2.allocatedTotal);
  for (const l of r2.lines) assert.equal(l.salary, (l.provisionalSalary ?? 0) - (l.profitShare.provisional ?? 0) + (l.profitShare.eligible ?? 0), "thực nhận được duyệt = tạm tính − thưởng LN tạm tính + phần đủ điều kiện");

  /* ══ PHẦN CÒN LẠI (chủ shop 21/10/2026) trên luồng thật: A nhận phần còn lại, trần tháng 2 = 30% ══ */
  const quyCheConLai: ProfitGatePolicy = { ...quyChe, version: 2, poolCapSchedule: [{ fromMonth: "2028-02", percent: 30 }], residualClaimant: { employeeId: A.id } };
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyCheConLai, history: [quyChe, quyCheConLai], adjustments: [dc1] });
  clearMemo();
  const rCl = await getPayrollReport(T2, "profit1");
  const gCl = rCl.profitGate.result;
  assert.deepEqual([gCl.poolCapPercent, gCl.poolCap], [30, Math.floor(E2 * 0.3)], "tháng 2 dùng trần CỦA THÁNG 2 trong lịch");
  const khac = rCl.lines.filter((l) => l.employee.id !== A.id).reduce((t, l) => t + (l.profitShare.demand ?? 0), 0);
  assert.ok(khac <= (gCl.poolCap ?? 0), "chuẩn bị: phần người khác dưới quỹ");
  assert.equal(dong(rCl, A.id).profitShare.eligible, (gCl.poolCap ?? 0) - khac, "A nhận ĐÚNG quỹ − phần người khác");
  assert.equal(gCl.allocatedTotal, gCl.poolCap, "tổng chia = đúng quỹ");
  assert.ok(dong(rCl, A.id).profitShare.claims.some((c) => c.key === `${A.id}:SHOP` && c.eligible === 0), "35% riêng của A hiện, không trả riêng");
  for (const l of rCl.lines) assert.equal(l.salary, (l.provisionalSalary ?? 0) - (l.profitShare.provisional ?? 0) + (l.profitShare.eligible ?? 0), "công thức thực nhận không đổi — phần còn lại đi qua đúng đường cũ");
  const anhCl = buildPayrollSnapshot(rCl, T2, monthPeriodKey("2028-02"));
  assert.deepEqual([anhCl.profitGate?.poolCapPercent, anhCl.profitGate?.residual?.employeeId, anhCl.profitGate?.residual?.othersDemand], [30, A.id, khac], "ảnh chụp kỳ ghi trần của tháng + người nhận + phần người khác ⇒ kỳ đã khoá tự giải thích");
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe], adjustments: [dc1] });
  clearMemo();

  /* ══ 7 (nối) · THIẾU DỮ LIỆU CHI PHÍ ⇒ CHẶN ══
   * Khai lương cứng cho A mà bảng Chi phí không có khoản lương nào ⇒ máy chi phí bật cảnh báo mức
   * `high` ⇒ cổng không kết luận.
   */
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [{ ...A, fixed: 5 * TR }, B] });
  clearMemo();
  const r7 = await getPayrollReport(T2, "profit1");
  assert.equal(r7.profitGate.result.status, "DATA_INCOMPLETE", "7. lợi nhuận chưa trừ lương ⇒ không xét thưởng");
  assert.equal(dong(r7, A.id).profitShare.eligible, null);
  assert.ok(payrollFinalizeBlockers({ bounded: true, basisEligible: true, basisWhy: "", basisLabel: "", totalSalary: r7.totalSalary, costWarnings: [], lines: [], profitGate: profitGateReadiness(r7) }).some((b) => b.code === "PROFIT_GATE_DATA_INCOMPLETE"), "7. chặn duyệt");

  /* ── Kỳ không phải tháng ⇒ chỉ tạm tính ── */
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [A, B] });
  clearMemo();
  const tuan = await getPayrollReport({ ...T2, from: d("2028-02-08"), fromKey: "2028-02-08", to: new Date("2028-02-14T23:59:59+07:00"), toKey: "2028-02-14", label: "7 ngày" }, "profit1");
  assert.equal(tuan.profitGate.result.status, "NOT_APPLICABLE");
  assert.ok((dong(tuan, A.id).profitShare.provisional ?? 0) > 0, "chuẩn bị: tuần chứa đơn 10/02 có thưởng tạm tính");
  assert.equal(dong(tuan, A.id).salary, null, "kỳ 7 ngày có thưởng % LN ⇒ thực nhận chưa kết luận");

  /* ══ 5 + 8 (nối, tiếp) · KHOÁ THÁNG 2: ĐIỀU CHỈNH ĐƯỢC CHỤP, ĐẾM ĐÚNG MỘT LẦN, KHÔNG MỞ KHOÁ NGƯỢC CHUỖI ══ */
  const tinh2 = await calculatePayrollPeriodAs(actor, { from: "2028-02-01", to: "2028-02-29", basis: "profit1", note: "kiểm thử cổng" });
  assert.ok("ok" in tinh2, `tính được kỳ tháng 2: ${"error" in tinh2 ? tinh2.error : ""}`);
  // Review vòng 5: điều chỉnh ghi SAU lần tính (lúc soát) mà không tính lại thì duyệt / khoá bị CHẶN — nếu
  // không, ảnh chụp không có nó, và khi tháng khoá rồi sổ thôi đọc cấu hình: khoản ấy biến mất im lặng.
  const dcMuon = { ...dc1, id: "pg-dc-luc-soat", amount: -1 * TR, reason: "phát hiện lúc soát kỳ tháng 2" };
  // Người duyệt là tài khoản THẬT: nếu chặn này mất thì lượt duyệt ĐI QUA được, và bài kiểm đỏ vì đúng lý do.
  await db.insert(schema.users).values({ id: "pg-nguoi", email: "pg-nguoi@t.local", name: "Chủ shop kiểm thử", role: "ADMIN", passwordHash: "x", active: true }).onConflictDoNothing();
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe], adjustments: [dc1, dcMuon] });
  const soat = await transitionPayrollRunAs(actor, { periodKey: monthPeriodKey("2028-02"), basis: "profit1", action: "SUBMIT_REVIEW", reason: "" });
  assert.ok("ok" in soat, `chuyển soát được: ${"error" in soat ? soat.error : ""}`);
  const duyet = await transitionPayrollRunAs({ id: "pg-nguoi", email: "chu@erp" }, { periodKey: monthPeriodKey("2028-02"), basis: "profit1", action: "APPROVE", reason: "" });
  assert.ok("error" in duyet && /Tính lại/.test(duyet.error), "review vòng 5: điều chỉnh ghi sau lần tính ⇒ không duyệt được cho tới khi tính lại");
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe], adjustments: [dc1] });
  await db.update(p).set({ status: "LOCKED", approvedAt: now, lockedAt: now }).where(and(eq(p.periodKey, monthPeriodKey("2028-02")), eq(p.basis, "profit1")));
  const [kh2] = await db.select({ snapshot: p.snapshot }).from(p).where(and(eq(p.periodKey, monthPeriodKey("2028-02")), eq(p.basis, "profit1")));
  const snap2 = kh2.snapshot as PayrollSnapshot;
  assert.deepEqual(snap2.profitGate?.lateAdjustments.map((a) => a.id), ["pg-dc-1"], "ảnh chụp tháng 2 mang nguyên văn điều chỉnh đã ghi");
  // Một dòng ghi NHẦM vào tháng đã khoá (qua sổ cấu hình) không được viết lại tháng ấy.
  const dcNham = { ...dc1, id: "pg-dc-nham", amount: 50 * TR, reason: "ghi nhầm vào tháng đã khoá" };
  await setSettingJson(PAYROLL_PROFIT_GATE_KEY, { active: quyChe, history: [quyChe], adjustments: [dc1, dcNham] });
  clearMemo();
  const T3 = monthReportPeriod("2028-03");
  const r3 = await getPayrollReport(T3, "profit1");
  const dongNhat = (x: typeof r3) =>
    assert.equal(
      x.profitGate.result.openingCumulative,
      -100 * TR + (snap1.profitGate?.periodBase ?? 0) + (snap2.profitGate?.periodBase ?? 0) - 3 * TR - (snap2.profitGate?.allocatedTotal ?? 0),
      "5. lũy kế đầu tháng 3 = −100tr + LN đã chụp tháng 1 + LN đã chụp tháng 2 + điều chỉnh −3tr (MỘT lần) − thưởng đã chia — đúng từng đồng",
    );
  dongNhat(r3);
  assert.equal(r3.profitGate.lateAdjustments.length, 0, "tháng 3 không có điều chỉnh nào — dòng ghi nhầm vào tháng 2 đã khoá bị bỏ qua");
  // Mở khoá ngược chuỗi bị chặn: tháng 2 đã khoá thì không mở khoá tháng 1.
  const moKhoa = await transitionPayrollRunAs({ id: "pg-nguoi", email: "chu@erp" }, { periodKey: monthPeriodKey("2028-01"), basis: "profit1", action: "UNLOCK", reason: "thử mở khoá ngược chuỗi" });
  assert.ok("error" in moKhoa && /mở khoá kỳ mới nhất trước/.test(moKhoa.error), "8. lũy kế là một chuỗi — mở khoá phải đi từ tháng khoá mới nhất trở về");
  // Đổi giá vốn / giả định / nguồn ghi nhận / hồ sơ nhân sự HÔM NAY: lũy kế của tháng đã khoá đứng yên.
  await db.insert(schema.expenses).values({ id: "pg-luong-1", category: "SALARY", description: "Lương tháng 1 ghi muộn", amount: 4 * TR, occurredAt: d("2028-01-28") });
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [{ ...A, fixed: 6 * TR }, { ...B, percentRevenue: 5 }] });
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "PAYROLL" });
  clearMemo();
  dongNhat(await getPayrollReport(T3, "profit1"));
  await setSettingJson(PAYROLL_RECOGNITION_KEY, { mode: "LEGACY_EXPENSES" });
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [A, B] });
  clearMemo();
  const r3b = await getPayrollReport(T3, "profit1");

  // Dòng quyết toán tự động của tháng trước ghi vào tháng 3 là CHI PHÍ thù lao của tháng 3.
  await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [A, B] });
  await db.insert(schema.payrollAdjustments).values({ id: "pg-adj-qt", employeeId: B.id, periodKey: monthPeriodKey("2028-03"), kind: "ADJUSTMENT", label: "Quyết toán tháng 02/2028 — truy lĩnh", amount: 400_000, reason: "tỷ lệ đã chốt", reference: "AUTO_SETTLEMENT:2028-02-01..2028-02-29" });
  clearMemo();
  const r3d = await getPayrollReport(T3, "profit1");
  assert.equal((r3d.profitGate.regularVariable ?? 0) - (r3b.profitGate.regularVariable ?? 0), 400_000, "dòng quyết toán tự động (do máy tạo) trừ vào cơ sở của tháng ghi nó");
  // Một dòng TẠM ỨNG mang cùng mã tham chiếu không phải hoa hồng thông thường (mã là ô chữ gõ được).
  await db.insert(schema.payrollAdjustments).values({ id: "pg-adj-ung", employeeId: B.id, periodKey: monthPeriodKey("2028-03"), kind: "ADVANCE", label: "Tạm ứng", amount: 1_000_000, reason: "gõ nhầm mã", reference: "AUTO_SETTLEMENT:2028-02-01..2028-02-29" });
  clearMemo();
  assert.equal((await getPayrollReport(T3, "profit1")).profitGate.regularVariable, r3d.profitGate.regularVariable, "review vòng 3: tạm ứng mang mã quyết toán KHÔNG thành hoa hồng thông thường");
  await db.delete(schema.payrollAdjustments).where(sql`${schema.payrollAdjustments.id} in ('pg-adj-qt', 'pg-adj-ung')`);

  await reset(db);
  await setSettingJson(PAYROLL_RECOGNITION_KEY, ghiNhanTruoc ?? { mode: "LEGACY_EXPENSES" });
}

/**
 * CHỦ SHOP 21/10/2026: quỹ = 35% LN đủ điều kiện (tới 10/2026) · 40% (từ 11/2026); một người nhận PHẦN CÒN LẠI
 * sau khi trừ phần của mọi người khác — tổng chia không vượt quỹ, phần còn lại không âm.
 */
function testResidualPure() {
  const lich = { poolCapPercent: null, poolCapSchedule: [{ fromMonth: "2026-11", percent: 40 }, { fromMonth: "2026-06", percent: 35 }] };
  assert.deepEqual(["2026-05", "2026-06", "2026-10", "2026-11", "2027-03"].map((m) => poolCapPercentFor(lich, m)), [null, 35, 35, 40, 40], "trần theo tháng; trước mốc đầu không có trần chung ⇒ CHƯA XÁC LẬP, không áp ngược");
  assert.equal(poolCapPercentFor({ poolCapPercent: 25, poolCapSchedule: [{ fromMonth: "2026-11", percent: 40 }] }, "2026-10"), 25, "trước mốc đầu dùng trần chung");
  assert.equal(poolCapPercentFor({ poolCapPercent: 25 }, "2026-10"), 25, "phiên bản cũ không có lịch: như trước");
  assert.equal(poolCapLabel(lich), "35% từ 2026-06 · 40% từ 2026-11");

  const nguoiNhan = { residualClaimant: { employeeId: "q" } };
  const cl = [claim("q:SHOP", 35 * TR), claim("q:code:X001", 2 * TR), claim("t:code:Q004", 5 * TR), claim("t:SHOP", 5 * TR), claim("h:code:Q006", 6 * TR)];
  const t10 = run({ monthKey: "2026-10", policy: { ...lich, ...nguoiNhan }, periodBase: 100 * TR, claims: cl });
  const nhan = (r: typeof t10, emp: string) => r.allocations.filter((a) => a.employeeId === emp).reduce((x, a) => x + (a.eligible ?? 0), 0);
  assert.deepEqual([t10.poolCapPercent, t10.poolCap], [35, 35 * TR], "tháng 10: quỹ 35% của 100tr");
  assert.deepEqual([nhan(t10, "t"), nhan(t10, "h"), nhan(t10, "q")], [10 * TR, 6 * TR, 19 * TR], "người khác nhận đủ phần mình; người nhận phần còn lại = 35tr − 16tr");
  assert.equal(t10.allocatedTotal, 35 * TR, "tổng chia đúng bằng quỹ");
  assert.deepEqual(t10.residual, { employeeId: "q", poolCap: 35 * TR, othersDemand: 16 * TR, amount: 19 * TR, overdrawnBy: 0, mergedKeys: ["q:SHOP", "q:code:X001"] });
  for (const k of ["q:SHOP", "q:code:X001"]) {
    const a = t10.allocations.find((x) => x.key === k)!;
    assert.ok(a.eligible === 0 && a.provisional! > 0 && /Gộp trong PHẦN CÒN LẠI/.test(a.reason ?? ""), `${k}: khoản riêng HIỆN với số tạm, không trả riêng, nói rõ vì sao`);
  }
  // Bảng lương cộng theo người: tạm tính − Σ tạm tính của các khoản + Σ đủ điều kiện ⇒ đúng phần còn lại.
  const q = t10.allocations.filter((a) => a.employeeId === "q");
  assert.equal(q.reduce((x, a) => x + (a.provisional ?? 0), 0), 37 * TR, "tạm tính theo công thức cũ vẫn để đối chiếu");
  const t11 = run({ monthKey: "2026-11", policy: { ...lich, ...nguoiNhan }, periodBase: 100 * TR, claims: cl });
  assert.deepEqual([t11.poolCap, nhan(t11, "q")], [40 * TR, 24 * TR], "từ tháng 11: quỹ 40% ⇒ phần còn lại 24tr");

  // Người khác đòi VƯỢT quỹ ⇒ phần còn lại 0 (không âm), người khác chia tỷ lệ cho vừa quỹ, nói rõ số vượt.
  const vuot = run({ monthKey: "2026-10", policy: { ...lich, ...nguoiNhan }, periodBase: 100 * TR, claims: [claim("q:SHOP", 35 * TR), claim("t:SHOP", 30 * TR), claim("h:code:Q006", 20 * TR)] });
  assert.equal(nhan(vuot, "q"), 0, "phần còn lại không bao giờ âm");
  assert.equal(vuot.allocations.find((a) => a.key === "q:RESIDUAL")?.demand, 0, "cả con số ĐỀ NGHỊ in trên phiếu cũng không âm (không chỉ tiền được chia)");
  assert.equal(vuot.allocatedTotal, 35 * TR, "người khác chia tỷ lệ cho vừa quỹ");
  assert.equal(vuot.residual?.overdrawnBy, 15 * TR);
  assert.match(vuot.allocations.find((a) => a.key === "q:RESIDUAL")?.reason ?? "", /vượt quỹ/, "nêu số vượt trên dòng phần còn lại");

  // Tháng trước mốc đầu, không trần chung ⇒ CẦN QUYẾT ĐỊNH, không chia.
  const truoc = run({ monthKey: "2026-05", policy: { ...lich, ...nguoiNhan }, periodBase: 100 * TR, claims: cl });
  assert.equal(truoc.status, "NOT_ESTABLISHED");
  assert.match(truoc.message, /CẦN QUYẾT ĐỊNH/);
  assert.ok(truoc.allocations.every((a) => a.eligible === null), "chưa có trần ⇒ đủ điều kiện CHƯA BIẾT");

  // Không có người nhận phần còn lại ⇒ y như trước.
  const khong = run({ monthKey: "2026-10", policy: lich, periodBase: 100 * TR, claims: cl });
  assert.equal(khong.residual, null);
  assert.equal(khong.allocations.length, cl.length, "không đẻ dòng phần còn lại");
}

/** Tháng KHÔNG có LN đủ điều kiện: một khoản tạm tính chưa biết không được chặn kết luận «0». */
function testCertainZeroPure() {
  const chuaBiet = [claim("a:SHOP", 3 * TR), claim("b:PERSONAL", null)];
  const lo = run({ periodBase: -5 * TR, claims: chuaBiet });
  assert.equal(lo.status, "NO_ELIGIBLE_PROFIT", "LN tháng ≤ 0 ⇒ kết luận chắc chắn, dù một số tạm tính chưa biết");
  assert.deepEqual(lo.allocations.map((a) => a.eligible), [0, 0], "mọi khoản đủ điều kiện = 0");
  assert.deepEqual(lo.allocations.map((a) => a.withheld), [3 * TR, null], "phần bị giữ của khoản chưa biết là CHƯA BIẾT, không phải 0");
  assert.equal(lo.provisionalTotal, null, "tổng tạm tính vẫn CHƯA BIẾT");
  const bu = run({ opening: mo(-10 * TR, 0), periodBase: 4 * TR, claims: chuaBiet });
  assert.equal(bu.status, "NO_ELIGIBLE_PROFIT", "lãi tháng chưa bù hết lỗ lũy kế ⇒ E = 0 ⇒ cũng kết luận được");
  const lai = run({ periodBase: 5 * TR, claims: chuaBiet });
  assert.equal(lai.status, "DATA_INCOMPLETE", "CÓ quỹ để chia mà một khoản chưa biết ⇒ vẫn chặn (không đoán phần của ai)");
}

export async function testPayrollProfitGate(db: Db) {
  testPure();
  testCertainZeroPure();
  testResidualPure();
  testSourceFences();
  await testFlow(db);
  console.log("  ✓ Cổng lỗ lũy kế toàn công ty: lỗ ⇒ 0 thưởng LN · chỉ chia phần vượt mốc cao nhất · không chia trùng · chứng từ muộn vào kỳ sau một lần · tổng ≤ quỹ · thiếu chi phí ⇒ chặn · kỳ khoá bất biến · trần theo tháng (35% → 40%, không áp ngược) · người nhận PHẦN CÒN LẠI = quỹ − người khác, không âm, ghi vào ảnh chụp");
}
