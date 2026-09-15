/**
 * ═══════ MÁY TÍNH LƯƠNG CHUNG — 30 TÌNH HUỐNG BẮT BUỘC ═══════
 *
 * Bộ này khoá PHÉP TÍNH của `lib/payroll/engine.ts` và phép PHÂN ĐOẠN của
 * `lib/payroll/policy-resolve.ts`. Cả hai là hàm THUẦN nên bài kiểm chạy bằng số viết tay, không
 * cần CSDL — chạy được trên máy người viết, đỏ ngay tại chỗ thay vì đợi tới CI.
 *
 * Nguyên tắc khi sửa bộ này: **không bao giờ sửa giá trị kỳ vọng để cho xanh**. Chúng là luật trả
 * tiền cho người thật (AGENTS.md mục 0).
 */
import assert from "node:assert/strict";
import {
  applyRounding,
  carryForwardAllowed,
  defaultProrate,
  payrollInput,
  PAYROLL_INPUTS,
  type PolicyComponent,
} from "@/lib/constants/payroll-components";
import { calculateComponent, calculatePayrollItem, type SegmentInput } from "@/lib/payroll/engine";
import { resolveSegments, type EmploymentRow, type PolicyAssignmentRow, type PolicyVersionRow } from "@/lib/payroll/policy-resolve";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59.999+07:00`);

/** Một thành phần với mặc định an toàn — bài kiểm chỉ ghi đè cái nó quan tâm. */
function comp(over: Partial<PolicyComponent> & Pick<PolicyComponent, "code" | "kind" | "calc">): PolicyComponent {
  return {
    label: over.code,
    prorate: defaultProrate(over.kind),
    rounding: "ROUND",
    minAmount: null,
    maxAmount: null,
    carryForward: false,
    sortOrder: 100,
    note: "",
    ...over,
  };
}

const emp = (over: Partial<EmploymentRow> = {}): EmploymentRow => ({
  id: "e1",
  employeeId: "NV1",
  departmentId: "d1",
  departmentName: "Kho",
  positionId: null,
  positionName: "",
  managerUserId: null,
  employmentType: "FULL_TIME",
  workMode: "ONSITE",
  status: "ACTIVE",
  standardWorkDays: null,
  effectiveFrom: d("2026-01-01"),
  effectiveTo: null,
  ...over,
});

const assign = (over: Partial<PolicyAssignmentRow> = {}): PolicyAssignmentRow => ({
  id: "a1",
  employeeId: "NV1",
  policyId: "P1",
  policyCode: "FIXED_BASE",
  policyName: "Lương cứng",
  effectiveFrom: d("2026-01-01"),
  effectiveTo: null,
  ...over,
});

const ver = (over: Partial<PolicyVersionRow> = {}): PolicyVersionRow => ({
  id: "v1",
  policyId: "P1",
  version: 1,
  effectiveFrom: d("2026-01-01"),
  effectiveTo: null,
  status: "ACTIVE",
  ...over,
});

/** Dựng đầu vào một đoạn từ kết quả phân đoạn. */
function segIn(
  segments: ReturnType<typeof resolveSegments>,
  components: PolicyComponent[],
  basis: Record<string, number | null> = {},
): SegmentInput[] {
  return segments.map((segment) => ({ segment, components, basis }));
}

const THANG_9 = { from: d("2026-09-01"), to: dEnd("2026-09-30") };

export function testPayrollEngine() {
  // ─────────── SỔ ĐĂNG KÝ ĐẦU VÀO ───────────

  // Mỗi đại lượng phải khai đủ nguồn thật; khoá không được trùng (AGENTS.md mục 37).
  const keys = PAYROLL_INPUTS.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, "khoá đầu vào không được trùng");
  for (const spec of PAYROLL_INPUTS) {
    assert.ok(spec.source.length > 40, `đại lượng ${spec.key} phải khai nguồn thật, không phải một câu trống`);
    assert.ok(["MEASURED", "MANUAL"].includes(spec.availability), `${spec.key} phải khai mức sẵn có`);
  }
  // Chấm công / KPI / sản lượng KHÔNG được khai là MEASURED khi ERP chưa có bảng nào giữ chúng.
  for (const k of ["WORK_DAYS", "WORK_HOURS", "SHIFTS", "PIECES", "KPI_PERCENT"]) {
    assert.equal(payrollInput(k)?.availability, "MANUAL", `${k} phải là MANUAL — ERP chưa đo được ở mức người`);
  }
  // Bù lỗ chỉ có nghĩa trên đại lượng CÓ THỂ ÂM.
  assert.ok(carryForwardAllowed({ type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 }));
  assert.ok(!carryForwardAllowed({ type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 1 }), "doanh thu không bao giờ âm nên không có lỗ mang sang");
  assert.ok(!carryForwardAllowed({ type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 30_000 }));

  // ─────────── 1. TOÀN THỜI GIAN, LƯƠNG CỨNG, TRỌN KỲ ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    assert.equal(segs.length, 1, "không có gì đổi trong tháng ⇒ một đoạn");
    assert.equal(segs[0].days, 30);
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "An",
      segments: segIn(segs, [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 12_000_000 } })]),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.netPay, 12_000_000, "trọn tháng ⇒ đúng khoản tháng, không dư không thiếu");
    assert.equal(r.problems.length, 0);
  }

  // ─────────── 2. VÀO LÀM GIỮA KỲ ───────────
  {
    const segs = resolveSegments({
      ...THANG_9,
      employments: [emp({ effectiveFrom: d("2026-09-16") })],
      policyAssignments: [assign({ effectiveFrom: d("2026-09-16") })],
      policyVersions: [ver()],
    });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "An",
      segments: segIn(segs, [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 12_000_000 } })]),
      adjustments: [],
      carryOpening: {},
    });
    // 16→30 là 15 ngày trên 30 ngày của tháng 9.
    assert.equal(r.netPay, 6_000_000, "vào làm giữa tháng ⇒ nửa tháng lương");
  }

  // ─────────── 3. NGHỈ GIỮA KỲ ───────────
  {
    const segs = resolveSegments({
      ...THANG_9,
      employments: [emp({ effectiveTo: dEnd("2026-09-10"), status: "ACTIVE" })],
      policyAssignments: [assign({ effectiveTo: dEnd("2026-09-10") })],
      policyVersions: [ver()],
    });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "An",
      segments: segIn(segs, [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 30_000_000 } })]),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.netPay, 10_000_000, "10/30 ngày ⇒ một phần ba khoản tháng");
    // Phần còn lại của kỳ vẫn HIỆN RA là một đoạn không làm việc, không bị nuốt.
    assert.ok(r.segments.some((s) => !s.working), "đoạn sau khi nghỉ vẫn phải hiện ra");
  }

  // ─────────── 4. BÁN THỜI GIAN THEO GIỜ ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp({ employmentType: "PART_TIME" })], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "Bình",
      segments: segIn(segs, [comp({ code: "HOURLY", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 35_000 } })], { WORK_HOURS: 96 }),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.netPay, 96 * 35_000);
  }

  // ─────────── 5. LÀM TỪ XA, TOÀN THỜI GIAN, LƯƠNG CỨNG ───────────
  {
    /*
      LÀM TỪ XA KHÔNG PHẢI MỘT CÔNG THỨC LƯƠNG. Bài kiểm này khoá đúng điều đó: cùng chính sách,
      cùng thành phần, chỉ đổi `workMode` — số tiền PHẢI y hệt. Ngày nào ai đó thêm một nhánh
      `if (workMode === 'REMOTE')` vào máy tính, bài này đỏ.
    */
    const base = [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 15_000_000 } })];
    const tien = (mode: EmploymentRow["workMode"]) => {
      const segs = resolveSegments({ ...THANG_9, employments: [emp({ workMode: mode })], policyAssignments: [assign()], policyVersions: [ver()] });
      return calculatePayrollItem({ employeeId: "NV1", employeeName: "C", segments: segIn(segs, base), adjustments: [], carryOpening: {} }).netPay;
    };
    assert.equal(tien("REMOTE"), tien("ONSITE"), "từ xa và tại chỗ cùng chính sách ⇒ cùng số tiền");
    assert.equal(tien("HYBRID"), 15_000_000);
  }

  // ─────────── 6. LƯƠNG CỨNG + KPI ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "D",
      segments: segIn(
        segs,
        [
          comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 8_000_000 } }),
          // KPI: 3 triệu × % hoàn thành. `PER_UNIT` với đơn giá = 30.000đ cho mỗi 1% ⇒ 100% = 3 triệu.
          comp({ code: "KPI", kind: "KPI", calc: { type: "PER_UNIT", basisKey: "KPI_PERCENT", unitRate: 30_000 } }),
        ],
        { KPI_PERCENT: 80 },
      ),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.netPay, 8_000_000 + 2_400_000);
  }

  // ─────────── 7. LƯƠNG CỨNG + HOA HỒNG DOANH THU ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "E",
      segments: segIn(
        segs,
        [
          comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 6_000_000 } }),
          comp({ code: "COMM", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 2 } }),
        ],
        { REVENUE_PERSONAL: 350_000_000 },
      ),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.netPay, 6_000_000 + 7_000_000);
  }

  // ─────────── 8. KHOÁN SẢN PHẨM ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp({ employmentType: "CONTRACTOR" })], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "F",
      segments: segIn(segs, [comp({ code: "PIECE", kind: "PIECE_RATE", calc: { type: "PER_UNIT", basisKey: "PIECES", unitRate: 12_500 } })], { PIECES: 412 }),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r.netPay, 412 * 12_500);
  }

  // ─────────── 9 & 10. MARKETING: LỢI NHUẬN DƯƠNG / ÂM ───────────
  {
    const c = comp({ code: "PROFIT", kind: "PROFIT_SHARE", calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 } });
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const duong = calculatePayrollItem({ employeeId: "M", employeeName: "MKT", segments: segIn(segs, [c], { PROFIT_PERSONAL: 75_000_000 }), adjustments: [], carryOpening: {} });
    assert.equal(duong.netPay, 7_500_000);
    const am = calculatePayrollItem({ employeeId: "M", employeeName: "MKT", segments: segIn(segs, [c], { PROFIT_PERSONAL: -10_000_000 }), adjustments: [], carryOpening: {} });
    assert.equal(am.netPay, 0, "lỗ KHÔNG biến thành một khoản phải trả âm");
  }

  // ─────────── 11, 12, 13. BÙ LỖ LŨY KẾ ───────────
  {
    const c = comp({ code: "PROFIT", kind: "PROFIT_SHARE", carryForward: true, calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 } });
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const chay = (opening: number | null, profit: number) =>
      calculatePayrollItem({
        employeeId: "M",
        employeeName: "MKT",
        segments: segIn(segs, [c], { PROFIT_PERSONAL: profit }),
        adjustments: [],
        carryOpening: { PROFIT: opening },
      });

    // 11. Tháng lỗ 10 triệu: không thưởng, và số âm ĐƯỢC GIỮ để chuyển sang kỳ sau.
    const t8 = chay(0, -10_000_000);
    assert.equal(t8.netPay, 0);
    assert.equal(t8.components[0].carry?.closingBalance, -10_000_000, "lỗ phải được giữ, không bị max() nuốt");

    // 13. Bù hết, còn dư: 30tr − 10tr = 20tr ⇒ 10% = 2 triệu (đúng ví dụ chủ shop đưa).
    const t9 = chay(-10_000_000, 30_000_000);
    assert.equal(t9.components[0].carry?.commissionBase, 20_000_000);
    assert.equal(t9.netPay, 2_000_000);
    assert.equal(t9.components[0].carry?.closingBalance, 0, "bù hết thì sổ về 0");

    // 12. Bù chưa hết: −10tr + 7tr = −3tr ⇒ thưởng 0, mang −3tr sang tháng sau.
    const t9b = chay(-10_000_000, 7_000_000);
    assert.equal(t9b.netPay, 0);
    assert.equal(t9b.components[0].carry?.closingBalance, -3_000_000);

    // Số dư CHƯA XÁC LẬP không được đọc thành 0.
    const chuaBiet = chay(null, 30_000_000);
    assert.equal(chuaBiet.netPay, null, "chưa xác lập số dư ⇒ CHƯA BIẾT, không phải 3 triệu");
    assert.equal(chuaBiet.missing.length, 1);
  }

  // ─────────── 18 & 19. ĐỔI PHÒNG BAN / ĐỔI CHÍNH SÁCH GIỮA KỲ ───────────
  {
    // Đổi phòng ban KHÔNG đổi cách trả tiền — cùng chính sách thì cùng số tiền.
    const doiPhong = resolveSegments({
      ...THANG_9,
      employments: [
        emp({ id: "e1", departmentName: "Kho", effectiveTo: dEnd("2026-09-14") }),
        emp({ id: "e2", departmentName: "Vận đơn", effectiveFrom: d("2026-09-15") }),
      ],
      policyAssignments: [assign()],
      policyVersions: [ver()],
    });
    assert.equal(doiPhong.length, 2, "đổi phòng ban cắt kỳ thành hai đoạn");
    const r1 = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "G",
      segments: segIn(doiPhong, [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 9_000_000 } })]),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r1.netPay, 9_000_000, "đổi phòng ban giữa kỳ vẫn đúng một tháng lương, không hụt vì làm tròn");

    // Đổi CHÍNH SÁCH giữa kỳ: 01–14 chính sách A, 15–30 chính sách B. KHÔNG được lấy B tính cả tháng.
    const doiCS = resolveSegments({
      ...THANG_9,
      employments: [emp()],
      policyAssignments: [
        assign({ id: "a1", policyId: "PA", policyCode: "A", effectiveTo: dEnd("2026-09-14") }),
        assign({ id: "a2", policyId: "PB", policyCode: "B", effectiveFrom: d("2026-09-15") }),
      ],
      policyVersions: [ver({ id: "vA", policyId: "PA" }), ver({ id: "vB", policyId: "PB" })],
    });
    assert.equal(doiCS.length, 2);
    const A = comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 6_000_000 } });
    const B = comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 12_000_000 } });
    const r2 = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "H",
      segments: doiCS.map((segment) => ({ segment, components: segment.policyCode === "A" ? [A] : [B], basis: {} })),
      adjustments: [],
      carryOpening: {},
    });
    // 14/30 × 6tr = 2.800.000 · 16/30 × 12tr = 6.400.000
    assert.equal(r2.netPay, 2_800_000 + 6_400_000, "mỗi đoạn tính theo chính sách CỦA ĐOẠN ẤY");
    assert.notEqual(r2.netPay, 12_000_000, "không được lấy chính sách mới tính cả tháng");
  }

  // ─────────── 25. PHIÊN BẢN CŨ GIỮ NGUYÊN KẾT QUẢ LỊCH SỬ ───────────
  {
    /*
      Chính sách đổi tỷ lệ từ 01/09. Kỳ THÁNG 8 phải vẫn đọc bản 1 — đây là điều kiện để "đổi tỷ lệ
      tháng này không viết lại tháng trước" có nghĩa.
    */
    const versions = [
      ver({ id: "v1", version: 1, effectiveFrom: d("2026-01-01"), effectiveTo: dEnd("2026-08-31") }),
      ver({ id: "v2", version: 2, effectiveFrom: d("2026-09-01") }),
    ];
    const t8 = resolveSegments({ from: d("2026-08-01"), to: dEnd("2026-08-31"), employments: [emp()], policyAssignments: [assign()], policyVersions: versions });
    assert.equal(t8.length, 1);
    assert.equal(t8[0].policyVersion, 1, "kỳ tháng 8 phải đọc bản 1");
    const t9 = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: versions });
    assert.equal(t9[0].policyVersion, 2, "kỳ tháng 9 đọc bản 2");
    // Bản NHÁP không bao giờ được dùng để trả tiền.
    const nhap = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver({ status: "DRAFT" })] });
    assert.equal(nhap[0].policyVersionId, null, "bản nháp không phủ được đoạn nào");
  }

  // ─────────── 26. NHIỀU THÀNH PHẦN TRÊN MỘT NGƯỜI ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "I",
      segments: segIn(
        segs,
        [
          comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 7_000_000 } }),
          comp({ code: "PHUCAP", kind: "ALLOWANCE", calc: { type: "FIXED_AMOUNT", amount: 1_000_000 } }),
          comp({ code: "COMM", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 1 } }),
          comp({ code: "KPI", kind: "KPI", calc: { type: "THRESHOLD_BONUS", basisKey: "KPI_PERCENT", threshold: 90, amount: 2_000_000 } }),
        ],
        { REVENUE_PERSONAL: 100_000_000, KPI_PERCENT: 95 },
      ),
      adjustments: [
        { id: "adv1", kind: "ADVANCE", label: "Tạm ứng 10/09", amount: 3_000_000, reason: "Ứng trước" },
        { id: "bon1", kind: "BONUS", label: "Thưởng nóng", amount: 500_000, reason: "Chốt đơn lớn" },
      ],
      carryOpening: {},
    });
    assert.equal(r.grossEarnings, 7_000_000 + 1_000_000 + 1_000_000 + 2_000_000 + 500_000);
    assert.equal(r.totalDeductions, 3_000_000, "tạm ứng là khoản TRỪ, và số dương ở đầu vào vẫn ra khoản trừ");
    assert.equal(r.netPay, r.grossEarnings! - 3_000_000);
    // Ngưỡng chưa đạt thì bằng 0, không phải "chưa biết".
    const chuaDat = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "I",
      segments: segIn(segs, [comp({ code: "KPI", kind: "KPI", calc: { type: "THRESHOLD_BONUS", basisKey: "KPI_PERCENT", threshold: 90, amount: 2_000_000 } })], { KPI_PERCENT: 60 }),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(chuaDat.netPay, 0);
  }

  // ─────────── 27. BẬC / NGƯỠNG ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const bac = comp({
      code: "TIER",
      kind: "COMMISSION",
      calc: { type: "TIERED_RATE", basisKey: "REVENUE_PERSONAL", tiers: [{ from: 0, ratePercent: 1 }, { from: 100_000_000, ratePercent: 2 }, { from: 300_000_000, ratePercent: 3 }] },
    });
    const tien = (rev: number) =>
      calculatePayrollItem({ employeeId: "X", employeeName: "X", segments: segIn(segs, [bac], { REVENUE_PERSONAL: rev }), adjustments: [], carryOpening: {} }).netPay;
    assert.equal(tien(50_000_000), 500_000, "chưa qua bậc 2 ⇒ 1%");
    // 100tr×1% + 100tr×2% = 1tr + 2tr
    assert.equal(tien(200_000_000), 3_000_000, "bậc áp cho PHẦN VƯỢT, không cho toàn bộ");
    // 100tr×1% + 200tr×2% + 100tr×3% = 1 + 4 + 3
    assert.equal(tien(400_000_000), 8_000_000);
    // Vượt ngưỡng một đồng không được làm tiền nhảy bậc.
    assert.ok(Math.abs((tien(100_000_001) ?? 0) - (tien(100_000_000) ?? 0)) < 10, "qua ngưỡng phải liên tục, không nhảy bậc");
  }

  // ─────────── 28. TRẦN VÀ SÀN ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const tran = calculatePayrollItem({
      employeeId: "X",
      employeeName: "X",
      segments: segIn(segs, [comp({ code: "C", kind: "COMMISSION", maxAmount: 5_000_000, calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 10 } })], { REVENUE_PERSONAL: 200_000_000 }),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(tran.netPay, 5_000_000);
    assert.equal(tran.components[0].cappedBy, "MAX", "chạm trần phải nói ra, không âm thầm cắt");
    const san = calculatePayrollItem({
      employeeId: "X",
      employeeName: "X",
      segments: segIn(segs, [comp({ code: "C", kind: "COMMISSION", minAmount: 1_000_000, calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 1 } })], { REVENUE_PERSONAL: 10_000_000 }),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(san.netPay, 1_000_000);
    assert.equal(san.components[0].cappedBy, "MIN");
  }

  // ─────────── 29. LÀM TRÒN ───────────
  {
    assert.equal(applyRounding(1_234_567.8, "ROUND"), 1_234_568);
    assert.equal(applyRounding(1_234_567.8, "FLOOR"), 1_234_567);
    assert.equal(applyRounding(1_234_567.2, "CEIL"), 1_234_568);
    assert.equal(applyRounding(1_234_567, "ROUND_1000"), 1_235_000);
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "X",
      employeeName: "X",
      segments: segIn(segs, [comp({ code: "C", kind: "COMMISSION", rounding: "ROUND_1000", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 1.7 } })], { REVENUE_PERSONAL: 12_345_678 }),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal((r.netPay ?? 0) % 1000, 0, "làm tròn nghìn phải ra số tròn nghìn");
    // TRẦN áp TRƯỚC làm tròn — một cái trần vượt được không phải là trần.
    const tran = calculateComponent(comp({ code: "C", kind: "BONUS", rounding: "ROUND_1000", maxAmount: 1_500_500, calc: { type: "FIXED_AMOUNT", amount: 9_000_000 } }), {
      segment: segs[0],
      basis: {},
      carryOpening: null,
    });
    assert.ok((tran.result.amount ?? 0) <= 1_501_000, "làm tròn sau trần không được vượt quá một bước làm tròn");
  }

  // ─────────── 30. THIẾU CHÍNH SÁCH ⇒ BÁO LỖI RÕ, KHÔNG LẶNG LẼ RA 0 ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [], policyVersions: [] });
    const r = calculatePayrollItem({ employeeId: "NV1", employeeName: "J", segments: segIn(segs, []), adjustments: [], carryOpening: {} });
    assert.equal(r.components.length, 0);
    assert.equal(r.problems.length, 1, "chưa gán chính sách phải thành một vấn đề đọc được");
    assert.match(r.problems[0], /chưa gán chính sách/i);

    // Thiếu SỐ LIỆU là chuyện khác hẳn thiếu cấu hình: nó là CHƯA BIẾT, và nói rõ ai phải nhập.
    const segs2 = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const r2 = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "J",
      segments: segIn(segs2, [comp({ code: "H", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 30_000 } })]),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r2.netPay, null, "thiếu giờ công ⇒ CHƯA BIẾT, không phải 0 ₫");
    assert.equal(r2.missing[0].availability, "MANUAL");
    assert.match(r2.missing[0].message, /Giờ công/);
    // Một thành phần biết + một thành phần chưa biết ⇒ TỔNG chưa biết.
    const r3 = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "J",
      segments: segIn(segs2, [
        comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 5_000_000 } }),
        comp({ code: "H", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 30_000 } }),
      ]),
      adjustments: [],
      carryOpening: {},
    });
    assert.equal(r3.netPay, null, "biết một nửa không phải là biết");
  }

  // ─────────── 22. TÍNH LẠI LÀ BẤT BIẾN (IDEMPOTENT) ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const dung = () =>
      calculatePayrollItem({
        employeeId: "NV1",
        employeeName: "K",
        segments: segIn(
          segs,
          [
            comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 10_000_000 } }),
            comp({ code: "PROFIT", kind: "PROFIT_SHARE", carryForward: true, calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 8 } }),
          ],
          { PROFIT_PERSONAL: 50_000_000 },
        ),
        adjustments: [{ id: "a", kind: "ADVANCE", label: "Ứng", amount: 1_000_000, reason: "x" }],
        carryOpening: { PROFIT: -5_000_000 },
      });
    const a = dung();
    const b = dung();
    assert.equal(a.netPay, b.netPay, "chạy hai lần ra đúng một kết quả");
    assert.equal(a.components[1].carry?.closingBalance, b.components[1].carry?.closingBalance, "bù lỗ không được cộng dồn qua mỗi lượt tính");
    assert.equal(a.components[1].carry?.lossApplied, 5_000_000);
    assert.equal(a.netPay, 10_000_000 + Math.round(45_000_000 * 0.08) - 1_000_000);
  }

  // ─────────── VẾT GIẢI THÍCH ĐI CÙNG MỌI CON SỐ ───────────
  {
    const segs = resolveSegments({ ...THANG_9, employments: [emp()], policyAssignments: [assign()], policyVersions: [ver()] });
    const r = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "L",
      segments: segIn(segs, [comp({ code: "PROFIT", kind: "PROFIT_SHARE", carryForward: true, calc: { type: "RATE_OF_BASIS", basisKey: "PROFIT_PERSONAL", ratePercent: 10 } })], { PROFIT_PERSONAL: 75_000_000 }),
      adjustments: [],
      carryOpening: { PROFIT: -10_000_000 },
    });
    const labels = r.components[0].explain.map((s) => s.label);
    // Đúng các bước mà yêu cầu mục 16 đòi: đại lượng → lỗ mang sang → cơ sở sau bù → tỷ lệ → thành tiền.
    assert.ok(labels.some((l) => l.includes("Lợi nhuận quy kết")), "vết phải nêu đại lượng gốc");
    assert.ok(labels.some((l) => l.includes("Lỗ mang sang")), "vết phải nêu lỗ mang sang");
    assert.ok(labels.some((l) => l.includes("Cơ sở sau bù lỗ")), "vết phải nêu cơ sở sau bù lỗ");
    assert.ok(labels.some((l) => l === "Tỷ lệ"), "vết phải nêu tỷ lệ");
    assert.equal(r.netPay, 6_500_000, "ví dụ mục 16: (75tr − 10tr) × 10%");
  }

  console.log("  ✓ Máy tính lương chung: 30 tình huống bắt buộc");
}
