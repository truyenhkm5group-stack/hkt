/**
 * ═══════════ ĐỐI SOÁT THƯỞNG % LỢI NHUẬN: CÔNG THỨC CŨ ↔ CỔNG LỖ LŨY KẾ — CHỈ ĐỌC ═══════════
 *
 * Đặc tả: `docs/payroll-profit-gate.md` §7. Chạy qua ops `payroll-profit-gate-audit` (kết quả MÃ HOÁ —
 * có tên và tiền của từng người), hoặc tại chỗ:
 *
 *   npx tsx --tsconfig tsconfig.json scripts/payroll-profit-gate-audit.ts --from-month 2026-06 --to-month 2026-10 --opening 0 --cap 100
 *
 * Với từng tháng lịch, in cạnh nhau:
 *   · lợi nhuận tính lương, hoa hồng thông thường, lương cứng CHƯA ghi nhận (nếu máy chi phí báo);
 *   · thưởng % lợi nhuận TẠM TÍNH theo công thức cũ, từng người;
 *   · thưởng ĐỦ ĐIỀU KIỆN nếu áp cổng với số dư mở sổ GIẢ ĐỊNH (`--opening`, mặc định 0 tại tháng đầu)
 *     và lợi nhuận ĐÃ TRỪ lương cứng chưa ghi nhận;
 *   · chênh lệch = số tiền có nguy cơ bị tính thưởng sai.
 * Kèm đối chiếu ba cơ sở lợi nhuận (tính lương · danh nghĩa · dòng tiền) để thấy Payroll và Tài chính
 * đang nói hai con số khác nhau ở đâu, và bảng lương "Toàn bộ" (`?period=all`) in gì.
 *
 * PAYROLL V2 (`docs/payroll-code-ledger.md`): thêm SỔ MÃ GIẢ ĐỊNH — mọi mã bắt đầu ở 0 tại tháng đầu
 * kỳ đo, lũy kế + HWM từng mã, phân bổ lợi nhuận đủ điều kiện (giả định) của công ty xuống mã, phép
 * ĐỐI SOÁT Σ LN mã ↔ LN công ty từng tháng, và thưởng OWNER GIẢ ĐỊNH theo chủ mã đang khai
 * (`--owner-pct`, mặc định 0 = không tính) để đặt cạnh % LN cá nhân của công thức cũ.
 *
 * KHÔNG ghi gì: Postgres ép chỉ đọc (`ERP_READ_ONLY=1` đặt TRƯỚC khi nạp `@/db`, rồi hỏi lại phiên).
 * Số dư mở sổ ở đây là GIẢ ĐỊNH của phép đo, KHÔNG phải số dư đã đối soát — quy chế thật do người có
 * quyền duyệt lương khai ở Lương → Cấu hình.
 */
import "dotenv/config";
process.env.ERP_READ_ONLY = "1";

import { compareMonthKey, monthKeyOf } from "@/lib/constants/payroll-carryover";
import { eligibleProfitOf, evaluateProfitGate, nextOpening, type ProfitGateClaim, type ProfitGateOpening } from "@/lib/payroll/profit-gate";
import { allocateCompanyToCodes, codeLedgerStep, type CodeState } from "@/lib/payroll/code-ledger";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import { getPayrollReport, monthReportPeriod } from "@/lib/queries/payroll";
import { monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { assertReadOnlySession } from "@/lib/queries/payroll-reconcile-source";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const tien = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v).toLocaleString("vi-VN")}`);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const ro = await assertReadOnlySession();
  console.log(`CHỈ ĐỌC ĐÃ XÁC MINH: transaction_read_only=${ro.transactionReadOnly} · default_transaction_read_only=${ro.defaultReadOnly}`);
  const fromMonth = arg("from-month", "2026-06");
  const toMonth = arg("to-month", monthKeyOf(new Date()));
  const opening0 = Number(arg("opening", "0"));
  const cap = Number(arg("cap", "100"));
  const ownerPct = Number(arg("owner-pct", "0"));
  if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth) || compareMonthKey(fromMonth, toMonth) > 0) throw new Error("Tháng không hợp lệ");
  if (!Number.isFinite(opening0) || !Number.isFinite(cap) || cap <= 0 || cap > 100) throw new Error("--opening / --cap không hợp lệ");
  tomTat(`Kỳ đo ${fromMonth} → ${toMonth} · số dư mở sổ GIẢ ĐỊNH ${tien(opening0)} · quỹ tối đa ${cap}%`);

  let opening: ProfitGateOpening = { cumulative: opening0, highWater: Math.max(0, opening0), paidToDate: 0, established: true, basis: "DECLARATION", reason: "giả định của phép đo" };
  const perEmp = new Map<string, { name: string; provisional: number; eligible: number }>();
  let tongTamTinh = 0;
  let tongDuDieuKien = 0;
  let codeState = new Map<string, CodeState>();
  const ownerV2 = new Map<string, { name: string; legacyPersonal: number; ownerBonus: number }>();
  console.log("\n═══ THEO THÁNG ═══");
  for (const m of monthsBetween(fromMonth, toMonth)) {
    const p = monthReportPeriod(m);
    const [r, cash] = await Promise.all([getPayrollReport(p, "profit1"), getCashProfitReport(p).catch(() => null)]);
    const salaryGap = r.marketers.costWarnings.find((w) => w.rule === "PAYROLL_OBLIGATION_NOT_RECOGNIZED")?.amount ?? 0;
    const ownBase = r.profitGate.ownBase;
    const base = ownBase === null ? null : ownBase - salaryGap;
    const E = eligibleProfitOf(opening, base);
    const claims: ProfitGateClaim[] = r.profitGate.result.allocations.map((a) => {
      const line = r.lines.find((l) => l.employee.id === a.employeeId);
      const shop = a.key.endsWith(":SHOP") && line ? Math.round(Math.max(E ?? 0, 0) * (line.employee.percentTotal / 100)) : null;
      return { key: a.key, employeeId: a.employeeId, label: a.label, provisional: a.provisional, demand: shop ?? a.provisional };
    });
    const g = evaluateProfitGate({ monthKey: m, applicable: { ok: true }, policy: { poolCapPercent: cap }, opening, openingProblem: null, periodBase: base, costIssues: [], claims });
    console.log(`\n── Tháng ${m} · trạng thái thật trên production: ${r.profitGate.result.status}`);
    console.log(`   LN tính lương (trước thưởng)     ${tien(r.totalProfit).padStart(16)}`);
    console.log(`   − hoa hồng thông thường          ${tien(r.profitGate.regularVariable).padStart(16)}`);
    console.log(`   − lương cứng CHƯA ghi nhận        ${tien(salaryGap).padStart(16)}`);
    console.log(`   = LN đem xét cổng                 ${tien(base).padStart(16)}`);
    console.log(`   Lũy kế đầu tháng (giả định)       ${tien(opening.cumulative).padStart(16)}   mốc ${tien(opening.highWater)}`);
    console.log(`   LN đủ điều kiện · quỹ ${cap}%       ${tien(g.eligibleProfit).padStart(16)} · ${tien(g.poolCap)}`);
    console.log(`   Đối chiếu: LN danh nghĩa ${tien(r.nominalTotal)} · dòng tiền ${tien(cash?.net ?? null)}`);
    for (const a of g.allocations) {
      console.log(`     ${a.label.padEnd(40)} tạm tính ${tien(a.provisional).padStart(13)}   đủ ĐK ${tien(a.eligible).padStart(13)}   chênh ${tien((a.provisional ?? 0) - (a.eligible ?? 0)).padStart(13)}`);
      const e = perEmp.get(a.employeeId) ?? { name: a.label.split(" · ")[0], provisional: 0, eligible: 0 };
      e.provisional += a.provisional ?? 0;
      e.eligible += a.eligible ?? 0;
      perEmp.set(a.employeeId, e);
    }
    const tt = g.provisionalTotal ?? 0;
    const dk = g.allocatedTotal ?? 0;
    tongTamTinh += tt;
    tongDuDieuKien += dk;
    tomTat(`${m}: trạng thái ${r.profitGate.result.status} · giả định cổng ${g.status} · ${g.allocations.filter((a) => (a.provisional ?? 0) > (a.eligible ?? 0)).length} khoản bị giữ lại`);

    // ─── V2: sổ mã giả định + đối soát ───
    const t = r.marketers.totals;
    const sumCodes = r.marketers.products.reduce((s, x) => s + x.profit, 0);
    const gap = t.profit - (sumCodes - t.testSpend - t.sharedUnallocated - t.logisticsAdjustmentUnallocated);
    const step = codeLedgerStep(codeState, r.marketers.products.map((x) => ({ productId: x.productId, code: x.code, profit: x.profit })));
    const alloc = allocateCompanyToCodes(step.rows, g.eligibleProfit ?? 0);
    codeState = step.closing;
    console.log(`   ĐỐI SOÁT mã: Σ LN ${r.marketers.products.length} mã ${tien(sumCodes)} − QC test ${tien(t.testSpend)} − chung không chia ${tien(t.sharedUnallocated)} − vận chuyển không chia ${tien(t.logisticsAdjustmentUnallocated)} ⇒ chênh với LN công ty ${tien(gap)}${gap === 0 ? " (khớp)" : " ⚠ CHƯA GIẢI THÍCH"}`);
    console.log(`   Mã không có mã hàng (custom_id rỗng): ${r.marketers.products.filter((x) => !x.code).length} · LN không phân bổ cho ai ${tien(r.marketers.unattributedProfit)}`);
    const top = step.rows.filter((x) => x.eligible > 0 || x.profit !== 0).sort((a, b) => b.profit - a.profit);
    for (const x of top.slice(0, 15)) {
      console.log(`     mã ${(x.code || x.productId).padEnd(14)} LN ${tien(x.profit).padStart(13)}   lũy kế ${tien(x.cumulative).padStart(13)}   đủ ĐK ${tien(x.eligible).padStart(12)}   phân bổ ${tien(alloc.get(x.productId) ?? 0).padStart(12)}`);
    }
    if (top.length > 15) console.log(`     … và ${top.length - 15} mã khác`);
    tomTat(`${m}: ${step.rows.filter((x) => x.eligible > 0).length}/${step.rows.length} mã có LN đủ điều kiện (giả định) · phân bổ ${tien([...alloc.values()].reduce((s, x) => s + x, 0))} · chênh đối soát ${tien(gap)}`);
    for (const pr of r.marketers.products) {
      if (!pr.ownerId) continue;
      const line = r.lines.find((l) => l.employee.id === pr.ownerId);
      const o = ownerV2.get(pr.ownerId) ?? { name: line ? line.employee.shortName || line.employee.name : pr.ownerName, legacyPersonal: 0, ownerBonus: 0 };
      o.ownerBonus += Math.floor(((alloc.get(pr.productId) ?? 0) * Math.round(ownerPct * 100)) / 10_000);
      ownerV2.set(pr.ownerId, o);
    }
    for (const l of r.lines) {
      const o = ownerV2.get(l.employee.id);
      if (o) o.legacyPersonal += l.bonusPersonal ?? 0;
    }
    opening = nextOpening(opening, g, true, "") ?? opening;
  }
  console.log("\n═══ THEO NHÂN VIÊN (cộng các tháng) ═══");
  for (const [id, e] of perEmp) console.log(`   ${e.name.padEnd(20)} ${id}   tạm tính ${tien(e.provisional).padStart(13)}   đủ ĐK ${tien(e.eligible).padStart(13)}   có nguy cơ tính sai ${tien(e.provisional - e.eligible).padStart(13)}`);
  console.log(`\nTỔNG thưởng % LN tạm tính ${tien(tongTamTinh)} · đủ điều kiện ${tien(tongDuDieuKien)} · CÓ NGUY CƠ TÍNH SAI ${tien(tongTamTinh - tongDuDieuKien)}`);
  console.log(`Lũy kế cuối kỳ đo (giả định): ${tien(opening.cumulative)} · mốc cao nhất ${tien(opening.highWater)}`);
  console.log(`\n═══ V2 · THƯỞNG OWNER GIẢ ĐỊNH theo chủ mã đang khai (X = ${ownerPct}%) ↔ % LN cá nhân cũ ═══`);
  for (const [id, o] of ownerV2) console.log(`   ${o.name.padEnd(20)} ${id}   % LN cá nhân cũ ${tien(o.legacyPersonal).padStart(13)}   OWNER V2 ${tien(o.ownerBonus).padStart(13)}`);
  tomTat(`V2: ${ownerV2.size} chủ mã · OWNER V2 (X=${ownerPct}%) tổng ${tien([...ownerV2.values()].reduce((s, o) => s + o.ownerBonus, 0))}`);

  const all = await getPayrollReport({ key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null }, "profit1");
  console.log("\n═══ BẢNG LƯƠNG “TOÀN BỘ” (?period=all) ═══");
  console.log(`   LN tính lương toàn thời gian ${tien(all.totalProfit)} · cổng: ${all.profitGate.result.status}`);
  for (const l of all.lines) console.log(`   ${(l.employee.shortName || l.employee.name).padEnd(20)} LN cá nhân ${tien(l.personalProfit).padStart(13)}   thưởng LN tạm tính ${tien(l.profitShare.provisional).padStart(13)}   đủ ĐK ${tien(l.profitShare.eligible).padStart(6)}`);
  tomTat(`Xong · ${perEmp.size} nhân sự có thưởng % lợi nhuận · chi tiết tiền trong bản mã`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
