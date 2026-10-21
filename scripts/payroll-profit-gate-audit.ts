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
 * PAYROLL V2 VẬN HÀNH (`docs/payroll-code-ledger.md` §9): mỗi tháng thêm BẢNG ĐỐI SOÁT (cơ sở lương ↔
 * máy chi phí + chứng từ trên đơn): độ phủ doanh thu / chi phí, nhóm chi phí theo mã · chung · chưa rõ
 * nguồn · chưa vào cơ sở, số mã đủ dữ liệu / đã phân công, và các khoản chưa đối soát. Đầu kỳ dữ liệu
 * THỰC (tháng sớm nhất có đơn / QC / chi phí) in ra để không ai mặc định số dư 0 khi chưa đối soát.
 *
 * PAYROLL V2 TRUNG TÂM ĐỐI SOÁT (`docs/payroll-code-ledger.md` §10): mỗi tháng thêm phép TÁCH COD (doanh thu
 * kế toán · phải thu chưa xác minh theo nguyên nhân / tuổi · tiền thực nhận · COD ĐVVC đang giữ); cuối kỳ in
 * truy giá vốn theo mẫu mã + nguyên nhân, ĐỀ XUẤT số dư mở sổ từ chuỗi số đo (kèm tháng thiếu căn cứ) và
 * DANH SÁCH PHÊ DUYỆT duy nhất — đúng các hàm thuần trang Trung tâm dùng. Dòng tóm tắt công khai (`tomTat`) không mang
 * tên người hay mã đơn (kho PUBLIC); chi tiết ở bản mã hoá.
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
import { getPayrollReport, listEmployees, monthReportPeriod } from "@/lib/queries/payroll";
import { poolCapLabel } from "@/lib/constants/payroll-profit-gate";
import { monthsBetween } from "@/lib/queries/payroll-profit-gate";
import { assertReadOnlySession } from "@/lib/queries/payroll-reconcile-source";
import { getMonthReconciliation, loadProfitSignoffs } from "@/lib/queries/payroll-reconciliation";
import { getProfitGateConfig } from "@/lib/queries/payroll-profit-gate";
import { listCodeBook } from "@/lib/queries/payroll-code-ledger";
import { COST_CLASS_LABEL, type CostClass } from "@/lib/payroll/profit-reconciliation";
import { buildApprovalList, buildOpeningProposal, COD_GAP_CAUSE_LABEL, personalShareWithoutCode, type CodGapCause } from "@/lib/payroll/recon-center";
import { COGS_GAP_CAUSE_LABEL, codSplit, cogsGapsByVariant, openingSeries, type CogsGapCause } from "@/lib/queries/payroll-recon-center";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { loadCodeBook } from "@/lib/queries/payroll-code-ledger";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

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
  // ─── Đầu kỳ dữ liệu thực + quy chế đã khai ───
  const db = await getDb();
  const dau = (await db.execute(sql`select
      (select to_char(min(inserted_at) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') from orders) as don,
      (select to_char(min(spend_date) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') from ad_spends) as qc,
      (select to_char(min(occurred_at) at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM') from expenses) as chi`)) as unknown as { rows?: { don: string | null; qc: string | null; chi: string | null }[] };
  const d0 = dau.rows?.[0] ?? { don: null, qc: null, chi: null };
  const somNhat = [d0.don, d0.qc, d0.chi].filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  const cfg = await getProfitGateConfig();
  console.log(`ĐẦU KỲ DỮ LIỆU THỰC: đơn ${d0.don ?? "—"} · quảng cáo ${d0.qc ?? "—"} · chi phí ${d0.chi ?? "—"} ⇒ sớm nhất ${somNhat ?? "—"}`);
  console.log(cfg.active ? `QUY CHẾ CỔNG ĐÃ KHAI v${cfg.active.version}: mở sổ ${cfg.active.openingMonth} · lũy kế ${tien(cfg.active.openingCumulative)} · mốc ${tien(cfg.active.openingHighWater)} · quỹ ${poolCapLabel(cfg.active)}${cfg.active.residualClaimant ? " · có người nhận phần còn lại" : ""}` : "QUY CHẾ CỔNG CHƯA KHAI ⇒ lũy kế công ty trên production là CHƯA BIẾT; số dưới đây dùng số dư GIẢ ĐỊNH của phép đo.");
  tomTat(`Đầu kỳ dữ liệu ${somNhat ?? "—"} · kỳ đo bắt đầu ${fromMonth}${somNhat && compareMonthKey(somNhat, fromMonth) < 0 ? " ⚠ SAU đầu kỳ dữ liệu — lỗ các tháng trước chưa vào lũy kế" : ""} · quy chế ${cfg.active ? `v${cfg.active.version} mở sổ ${cfg.active.openingMonth}` : "CHƯA KHAI"}`);
  const book = await listCodeBook();
  tomTat(`Sổ phân công: ${book.filter((x) => x.kind === "ASSIGNMENT" && x.status === "APPROVED").length} phân công · ${book.filter((x) => x.kind === "TERMS" && x.status === "APPROVED").length} điều khoản đang duyệt`);
  const tong = { dt: 0, dtTien: 0, mo: 0, cp: 0, cpKhop: 0, issues: 0, thangDu: 0, thang: 0 };
  const center = { phaiThu: 0, phaiThuDon: 0, qua30: 0, tienVe: 0, codGiu: 0, keToan: 0, chuaKy: [] as string[], trungNguon: 0 };
  const undated = new Map<string, { id: string; name: string; monthlyFixed: number }>();
  const coDoanhThu = new Set<string>();
  const lop: Record<CostClass, number> = { BY_CODE: 0, SHARED: 0, UNKNOWN_SOURCE: 0, NOT_IN_BASIS: 0 };

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
    /*
      THẬT THEO QUY CHẾ ĐÃ KHAI (chủ shop 21/10/2026: trần theo tháng + người nhận phần còn lại). Phần mô phỏng ở trên
      dùng `--cap` / `--opening` của phép đo và KHÔNG có người nhận phần còn lại — nó không phải con số bảng lương in.
      Đây là ĐÚNG kết quả `getPayrollReport` của tháng: tên + tiền từng người chỉ ở phần MÃ HOÁ, kênh tóm tắt chỉ số tổng.
    */
    const g0 = r.profitGate.result;
    const conLai = g0.residual;
    console.log(`   THẬT (quy chế đã khai): ${g0.status}${g0.established ? "" : " (chưa kết luận)"} · trần tháng ${g0.poolCapPercent === null ? "—" : `${g0.poolCapPercent}%`} · LN đủ ĐK ${tien(g0.eligibleProfit)} · quỹ ${tien(g0.poolCap)} · đã chia ${tien(g0.allocatedTotal)}${conLai ? ` · phần còn lại ${tien(conLai.amount)} · người khác ${tien(conLai.othersDemand)}${conLai.overdrawnBy > 0 ? ` · VƯỢT quỹ ${tien(conLai.overdrawnBy)}` : ""}` : ""}`);
    console.log(`     vì sao: ${g0.message}`);
    for (const l of r.lines) {
      if (!l.profitShare.claims.length) continue;
      console.log(`     THẬT ${(l.employee.shortName || l.employee.name).padEnd(14)} tạm tính ${tien(l.profitShare.provisional).padStart(13)}   đủ ĐK ${tien(l.profitShare.eligible).padStart(13)}   thực nhận được duyệt ${tien(l.salary).padStart(13)}${l.profitShare.reasons.length ? `   · ${l.profitShare.reasons.join(" | ").slice(0, 300)}` : ""}`);
    }
    tomTat(`${m} THẬT: ${g0.status} · trần ${g0.poolCapPercent ?? "—"}% · quỹ ${tien(g0.poolCap)} · đã chia ${tien(g0.allocatedTotal)}${conLai ? ` · có người nhận phần còn lại${conLai.overdrawnBy > 0 ? " · người khác VƯỢT quỹ" : ""}` : " · không có người nhận phần còn lại"}`);
    // Kênh tóm tắt là log CÔNG KHAI: phần còn lại là tiền của MỘT người ⇒ chỉ in ở phần mã hoá phía trên.

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
    // ─── V2 vận hành: bảng đối soát của tháng ───
    const rc = await getMonthReconciliation(m, { report: r });
    const ky = (await loadProfitSignoffs(m)).find((s) => s.fingerprint === rc.fingerprint) ?? null;
    const pt = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
    console.log(`   ĐỐI SOÁT ${m}: ${rc.status} · doanh thu có chứng từ tiền ${pt(rc.coverage.revenueWithMoneyPct)} · đơn đã có kết quả ${pt(rc.coverage.revenueSettledPct)} · chi phí khớp nguồn ${pt(rc.coverage.costReconciledPct)} · chữ ký cấp 1 ${ky ? `có (${ky.signedByEmail})` : "chưa"}`);
    for (const l of rc.lines) console.log(`     [${l.status.padEnd(12)}] ${l.label.padEnd(58)} cơ sở ${tien(l.basis).padStart(13)}  nguồn ${tien(l.source).padStart(13)}  chênh ${tien(l.diff).padStart(12)}`);
    console.log(`     nhóm chi phí: ${(Object.keys(COST_CLASS_LABEL) as CostClass[]).map((c) => `${COST_CLASS_LABEL[c]} ${tien(rc.classes[c])}`).join(" · ")}`);
    console.log(`     mã: ${rc.codes.total} có số · ${rc.codes.withCustomId} có mã hàng · ${rc.codes.profitComplete} đủ dữ liệu LN · ${rc.codes.assigned} đã phân công`);
    for (const i of rc.issues) console.log(`     ✗ ${i.label}${i.count !== null ? ` · ${i.count} mục` : ""}${i.amount !== null ? ` · ${tien(i.amount)}` : ""}`);
    // Tác động quyết định 20/10/2026 (phí chiều hoàn vào cơ sở lương): bỏ khoản ấy thì lợi nhuận tăng ĐÚNG
    // `returnLeg.amount` (khoá bằng tests/payroll-recon-center.test.ts), nên "trước" = "sau" + khoản ấy.
    const rl = t.returnLeg;
    console.log(`   PHÍ CHIỀU HOÀN ${m}: ${tien(rl.amount)} = gắn mã ${tien(rl.toCodes)} + chi phí chung ${tien(rl.shared)} · LN tính lương TRƯỚC ${tien(r.totalProfit + rl.amount)} → SAU ${tien(r.totalProfit)}`);
    tomTat(`${m}: phí chiều hoàn ${tien(rl.amount)} (gắn mã ${tien(rl.toCodes)} · chung ${tien(rl.shared)}) · LN tính lương trước ${tien(r.totalProfit + rl.amount)} → sau ${tien(r.totalProfit)}`);
    tomTat(`${m}: đối soát ${rc.status} (${rc.issues.length} khoản chưa) · DT có chứng từ ${pt(rc.coverage.revenueWithMoneyPct)} · đơn có kết quả ${pt(rc.coverage.revenueSettledPct)} · chi phí khớp ${pt(rc.coverage.costReconciledPct)} · mã đủ dữ liệu ${rc.codes.profitComplete}/${rc.codes.total} · đã phân công ${rc.codes.assigned}/${rc.codes.total} · chưa rõ nguồn ${tien(rc.classes.UNKNOWN_SOURCE)} · chưa vào cơ sở ${tien(rc.classes.NOT_IN_BASIS)}`);
    // ─── V2 Trung tâm: tách COD của tháng ───
    const cod = await codSplit(m);
    console.log(`   COD ${m}: doanh thu kế toán ${tien(cod.accounting.revenue)} (${cod.accounting.orders} đơn) · có chứng từ tiền ${tien(cod.withMoney.revenue)} · PHẢI THU chưa xác minh ${tien(cod.receivable.revenue)} (${cod.receivable.orders} đơn; ≤7 ngày ${cod.receivable.age.le7.orders} · 8–30 ${cod.receivable.age.d8to30.orders} · >30 ${cod.receivable.age.over30.orders} · chưa có mốc giao ${cod.receivable.age.unknown.orders}) · tiền thực nhận ${tien(cod.cashReceived)} · COD ĐVVC đang giữ ${tien(cod.codHeldByCarrier)}`);
    for (const k of Object.keys(COD_GAP_CAUSE_LABEL) as CodGapCause[]) if (cod.receivable.byCause[k].orders) console.log(`     phải thu · ${COD_GAP_CAUSE_LABEL[k]}: ${cod.receivable.byCause[k].orders} đơn · ${tien(cod.receivable.byCause[k].revenue)}`);
    tomTat(`${m}: COD kế toán ${tien(cod.accounting.revenue)} · phải thu chưa xác minh ${tien(cod.receivable.revenue)} (${cod.receivable.orders} đơn, >30 ngày ${cod.receivable.age.over30.orders}) · tiền thực nhận ${tien(cod.cashReceived)} · ĐVVC đang giữ ${tien(cod.codHeldByCarrier)}`);
    center.phaiThu += cod.receivable.revenue;
    center.phaiThuDon += cod.receivable.orders;
    center.qua30 += cod.receivable.age.over30.orders;
    center.tienVe += cod.cashReceived;
    center.codGiu += cod.codHeldByCarrier;
    center.keToan += cod.accounting.revenue;
    if ((r.profitGate.result.allocatedTotal ?? 0) > 0 && !ky) center.chuaKy.push(m);
    center.trungNguon += rc.issues.filter((i) => i.code.startsWith("warn:") && i.code !== "warn:PAYROLL_OBLIGATION_NOT_RECOGNIZED").length;
    for (const e of (await getRecognizedCosts(p)).payroll.undatedEmployees) undated.set(e.id, e);
    for (const x of r.marketers.products) if (x.revenue > 0) coDoanhThu.add(x.productId);
    const rev = rc.lines.find((l) => l.key === "revenue");
    tong.dt += rev?.source ?? 0;
    tong.thang += 1;
    if (rc.status === "RECONCILED") tong.thangDu += 1;
    tong.issues += rc.issues.length;
    for (const c of Object.keys(lop) as CostClass[]) lop[c] += rc.classes[c];
    const tr = rc.coverage;
    if (tr.revenueWithMoneyPct !== null && rev?.source) tong.dtTien += tr.revenueWithMoneyPct * rev.source;
    const open = rc.lines.find((l) => l.key === "open-orders")?.source ?? 0;
    tong.mo += open;
    const chiPhi = rc.lines.filter((l) => l.cls !== "REVENUE" && !l.key.startsWith("ads-") && l.key !== "shared-unalloc");
    tong.cp += chiPhi.reduce((t, l) => t + Math.abs(l.basis ?? l.source ?? 0), 0);
    tong.cpKhop += chiPhi.filter((l) => l.status === "MATCHED" || l.status === "EXPLAINED").reduce((t, l) => t + Math.abs(l.basis ?? l.source ?? 0), 0);
    opening = nextOpening(opening, g, true, "") ?? opening;
  }
  console.log("\n═══ ĐỐI SOÁT CẢ KỲ ═══");
  const pt2 = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");
  console.log(`   tháng đối soát đủ ${tong.thangDu}/${tong.thang} · tổng khoản chưa đối soát ${tong.issues}`);
  console.log(`   doanh thu giao thành công ${tien(tong.dt)} · có chứng từ tiền ${pt2(tong.dtTien, tong.dt)} · giá trị đơn còn chưa có kết quả ${tien(tong.mo)}`);
  console.log(`   chi phí (cơ sở + chưa vào cơ sở) ${tien(tong.cp)} · khớp nguồn / đã giải thích ${pt2(tong.cpKhop, tong.cp)}`);
  console.log(`   nhóm: ${(Object.keys(COST_CLASS_LABEL) as CostClass[]).map((c) => `${COST_CLASS_LABEL[c]} ${tien(lop[c])}`).join(" · ")}`);
  tomTat(`CẢ KỲ: đủ ${tong.thangDu}/${tong.thang} tháng · DT có chứng từ ${pt2(tong.dtTien, tong.dt)} · chi phí khớp ${pt2(tong.cpKhop, tong.cp)} · chưa rõ nguồn ${tien(lop.UNKNOWN_SOURCE)} · chưa vào cơ sở ${tien(lop.NOT_IN_BASIS)}`);
  // ─── V2 Trung tâm: giá vốn · mở sổ · danh sách phê duyệt ───
  const dauKy = monthReportPeriod(fromMonth);
  const cuoiKy = monthReportPeriod(toMonth);
  const gaps = await cogsGapsByVariant(dauKy.from as Date, cuoiKy.to as Date);
  console.log("\n═══ TRUY GIÁ VỐN (dòng đã giao, giá vốn 0) ═══");
  for (const k of Object.keys(COGS_GAP_CAUSE_LABEL) as CogsGapCause[]) {
    const nhom = gaps.filter((g) => g.cause === k);
    if (!nhom.length) continue;
    console.log(`   ${COGS_GAP_CAUSE_LABEL[k]}: ${nhom.length} mẫu mã · ${nhom.reduce((t, g) => t + g.lines, 0)} dòng · ${tien(nhom.reduce((t, g) => t + g.revenue, 0))}`);
    for (const g of nhom.slice(0, 20)) console.log(`     ${(g.code || g.productName).padEnd(16)} ${(g.sku || g.variantId || "—").padEnd(20)} ${String(g.lines).padStart(4)} dòng  ${tien(g.revenue).padStart(12)}  đơn: ${g.sampleOrderIds.join(", ")}`);
  }
  tomTat(`Giá vốn: ${gaps.length} mẫu mã · ${gaps.reduce((t, g) => t + g.lines, 0)} dòng · ${tien(gaps.reduce((t, g) => t + g.revenue, 0))} doanh thu đang tính giá vốn 0 · ${(Object.keys(COGS_GAP_CAUSE_LABEL) as CogsGapCause[]).map((k) => `${k} ${gaps.filter((g) => g.cause === k).length}`).join(" · ")}`);
  const mocMoSo = cfg.active?.openingMonth ?? fromMonth;
  const series = await openingSeries(mocMoSo);
  const deXuat = buildOpeningProposal(mocMoSo, series.dataStart, series.months);
  console.log(`\n═══ ĐỀ XUẤT SỐ DƯ MỞ SỔ tại ${mocMoSo} (${deXuat.complete ? "đủ căn cứ" : "CHƯA ĐỦ CĂN CỨ"}) ═══`);
  for (const x of deXuat.months) console.log(`   ${x.monthKey}  DT ${tien(x.revenue).padStart(13)}  CP ghi nhận (trừ lương chưa căn cứ) ${tien(x.recognizedCost).padStart(13)}  lương có căn cứ chưa ghi ${tien(x.salaryGapEvidenced).padStart(11)}  LN đo được ${tien(x.measuredProfit).padStart(13)}  ${x.gaps.length ? `thiếu: ${x.gaps.join(" · ")}` : "đủ căn cứ"}`);
  tomTat(`Mở sổ ${mocMoSo}: lũy kế ĐO ĐƯỢC ${tien(deXuat.measuredCumulative)} · đỉnh ${tien(deXuat.measuredHighWater)} · ${deXuat.months.length} tháng, ${deXuat.incompleteMonths.length} tháng thiếu căn cứ ⇒ ${deXuat.complete ? "đủ căn cứ" : "CHƯA ĐỦ CĂN CỨ — không dùng như số đã duyệt"}`);
  const sobo = await loadCodeBook(dauKy.from, cuoiKy.to);
  const owners = new Set(sobo.assignments.filter((a) => a.role === "OWNER").map((a) => a.productId));
  const duyet = buildApprovalList({
    opening: deXuat,
    gatePolicyDeclared: Boolean(cfg.active),
    undatedEmployees: [...undated.values()],
    pendingAssignments: book.filter((x) => x.kind === "ASSIGNMENT" && x.status === "PENDING").length,
    pendingTerms: book.filter((x) => x.kind === "TERMS" && x.status === "PENDING").length,
    codesWithoutOwner: [...coDoanhThu].filter((id) => !owners.has(id)).length,
    monthsNeedingSignoff: center.chuaKy,
    cogsGaps: { variants: gaps.length, lines: gaps.reduce((t, g) => t + g.lines, 0), revenue: gaps.reduce((t, g) => t + g.revenue, 0) },
    codReceivable: { orders: center.phaiThuDon, revenue: center.phaiThu, over30Orders: center.qua30 },
    duplicateSourceWarnings: center.trungNguon,
    personalShareWithoutCode: personalShareWithoutCode(
      (await listEmployees()).map((e) => ({ id: e.id, name: e.shortName || e.name, active: e.active, percentPersonal: Number(e.percentPersonal) || 0 })),
      new Set(sobo.assignments.map((a) => a.employeeId)),
      cfg.active?.residualClaimant?.employeeId ?? null,
    ),
  });
  console.log(`\n═══ DANH SÁCH PHÊ DUYỆT (${duyet.length} mục) ═══`);
  for (const [i, x] of duyet.entries()) console.log(`   ${i + 1}. [${x.kind === "DECIDE" ? "QUYẾT" : "BỔ SUNG"} · ${x.owner}] ${x.title}${x.amount !== null ? ` · ${tien(x.amount)}` : ""}\n      nguyên nhân: ${x.cause}\n      việc: ${x.action} (${x.href})`);
  tomTat(`Danh sách phê duyệt ${duyet.length} mục: ${duyet.map((x) => `${x.key}${x.count !== null ? `×${x.count}` : ""}`).join(" · ")} · COD cả kỳ: kế toán ${tien(center.keToan)} · phải thu ${tien(center.phaiThu)} · tiền thực nhận ${tien(center.tienVe)} · ĐVVC giữ ${tien(center.codGiu)}`);

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
