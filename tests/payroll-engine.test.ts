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
import { assignmentOverlaps, componentMissingParams, policyGaps } from "@/lib/payroll/policy-validation";
import { carryoverChain } from "@/lib/payroll/profit-carryover";
import { MIGRATION_STATUSES, MIGRATION_STATUS_LABEL, migrationStatus, proposePolicyFromLegacy, reconcile } from "@/lib/payroll/migration-preview";
import { DEFAULT_STATUTORY, STATUTORY_STATES, STATUTORY_STATE_LABEL, statutoryDisplay } from "@/lib/constants/payroll-statutory";
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

  // ─────────── MỐC HIỆU LỰC THIẾU MILI GIÂY KHÔNG ĐƯỢC SINH RA MỘT NGÀY CÔNG MA ───────────
  {
    /*
      `vnEndOfDay` trả 23:59:59.999, nhưng một dòng ghi bằng đường khác có thể mang 23:59:59 chẵn.
      Khi ấy `effectiveTo + 1ms` rơi vào GIỮA ngày 15, và nếu mốc cắt không được làm tròn lên đầu
      ngày thì mẩu 999 mili giây ấy thành một đoạn RIÊNG: không chính sách nào phủ (bảng lương báo
      "chưa gán chính sách" cho một người đã gán đủ), và `inclusiveDays` đếm nó là MỘT NGÀY.
    */
    const thieuMiliGiay = new Date("2026-09-15T23:59:59+07:00");
    const segs = resolveSegments({
      ...THANG_9,
      employments: [emp()],
      policyAssignments: [
        assign({ id: "a1", policyId: "PA", policyCode: "A", effectiveTo: thieuMiliGiay }),
        assign({ id: "a2", policyId: "PB", policyCode: "B", effectiveFrom: d("2026-09-16") }),
      ],
      policyVersions: [ver({ id: "vA", policyId: "PA" }), ver({ id: "vB", policyId: "PB" })],
    });
    assert.equal(segs.length, 2, "mốc thiếu mili giây vẫn ra ĐÚNG hai đoạn, không sinh mẩu thứ ba");
    assert.equal(segs[0].days + segs[1].days, 30, "và tổng số ngày vẫn đúng bằng số ngày của tháng — không có ngày công ma");
    assert.ok(segs.every((sg) => sg.policyVersionId), "không đoạn nào bị rơi ra ngoài mọi chính sách");
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
    // `-0` bằng `0` với `===` nhưng in ra màn hình thành "-0 ₫" — một dòng khấu trừ âm không tồn tại.
    const khongTru = calculatePayrollItem({
      employeeId: "NV1",
      employeeName: "I",
      segments: segIn(segs, [comp({ code: "BASE", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 1_000_000 } })]),
      adjustments: [],
      carryOpening: {},
    });
    assert.ok(Object.is(khongTru.totalDeductions, 0), "không có khoản trừ nào ⇒ đúng 0, không phải −0");
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

  // ─────────── KIỂM SỔ KHAI: CHỒNG LẤN · KHOẢNG TRỐNG · THIẾU THAM SỐ ───────────
  {
    const ten = (id: string) => (id === "NV1" ? "An" : id);

    /*
      CHỒNG LẤN. `resolveSegments` vẫn chạy được (nó lấy dòng có `effectiveFrom` muộn nhất), nên
      KHÔNG có lỗi nào nổ ra — và đó chính là vấn đề: tiền của những ngày ấy do một quy tắc ngầm
      quyết định, không do người khai.
    */
    const chongLan = assignmentOverlaps(
      [
        assign({ id: "a1", policyId: "PA", policyCode: "A", effectiveFrom: d("2026-09-01"), effectiveTo: dEnd("2026-09-20") }),
        assign({ id: "a2", policyId: "PB", policyCode: "B", effectiveFrom: d("2026-09-15") }),
      ],
      ten,
    );
    assert.equal(chongLan.length, 1, "hai dòng gán cùng phủ một ngày PHẢI bị bắt");
    assert.equal(chongLan[0].blocking, true, "và nó chặn chốt kỳ — tiền không được do thứ tự dòng quyết định");
    assert.match(chongLan[0].message, /Phân công/, "câu chặn phải nói ĐÚNG chỗ sửa");

    // Đóng dòng cũ lại đúng ngày liền trước ⇒ hết chồng lấn.
    const sachSe = assignmentOverlaps(
      [
        assign({ id: "a1", policyId: "PA", policyCode: "A", effectiveFrom: d("2026-09-01"), effectiveTo: dEnd("2026-09-14") }),
        assign({ id: "a2", policyId: "PB", policyCode: "B", effectiveFrom: d("2026-09-15") }),
      ],
      ten,
    );
    assert.deepEqual(sachSe, [], "đóng dòng cũ đúng ngày liền trước ⇒ không còn chồng lấn");

    /*
      THAM SỐ BẰNG 0 LÀ MỘT CÂU HỎI, KHÔNG PHẢI MỘT LỖI.

      0 là giá trị hợp lệ — chủ shop có thể thật sự muốn thế. Nhưng "chưa ai nhập" và "đã quyết là
      0" trông y hệt nhau, và cái giá của việc đoán nhầm là một người không nhận được khoản mình
      đáng nhận. ERP KHÔNG đặt hộ con số; nó hỏi lại.
    */
    const thieu = componentMissingParams("PE_TEST", [
      comp({ code: "A", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 0 } }),
      comp({ code: "B", kind: "COMMISSION", calc: { type: "RATE_OF_BASIS", basisKey: "REVENUE_PERSONAL", ratePercent: 0 } }),
      comp({ code: "C", kind: "TIME_BASED", calc: { type: "PER_UNIT", basisKey: "WORK_HOURS", unitRate: 0 } }),
      comp({ code: "D", kind: "FIXED", calc: { type: "FIXED_AMOUNT", amount: 5_000_000 } }),
    ]);
    assert.equal(thieu.length, 3, "ba thành phần khai 0 phải bị hỏi lại, thành phần khai đủ thì không");
    assert.ok(thieu.every((i) => i.blocking));
    assert.ok(thieu.every((i) => /KHÔNG đặt hộ/.test(i.message)), "và nói rõ ERP không tự đặt số");

    /*
      KHOẢNG TRỐNG. Người ĐÃ bước sang máy mới mà có đoạn không chính sách nào phủ thì đoạn ấy ra 0
      đồng — trông y hệt "kỳ này không có gì để nhận". Người CHƯA gán chính sách nào thì KHÔNG bị
      soi: họ vẫn đi đường tính cũ, và đó là trạng thái hợp lệ trong giai đoạn chuyển.
    */
    const trong = policyGaps({
      ...THANG_9,
      employees: [{ id: "NV1", name: "An" }, { id: "NV2", name: "Bình" }],
      employments: [emp({ employeeId: "NV1" }), emp({ id: "e2", employeeId: "NV2" })],
      // An gán chính sách nhưng chỉ tới 20/09; Bình chưa gán gì.
      policyAssignments: [assign({ employeeId: "NV1", effectiveTo: dEnd("2026-09-20") })],
      policyVersions: [ver()],
    });
    assert.equal(trong.length, 1, "chỉ người ĐÃ gán chính sách mới bị soi khoảng trống");
    assert.equal(trong[0].employeeId, "NV1");
    assert.match(trong[0].message, /KHÔNG chính sách nào phủ/);

    // Gán chính sách nhưng phiên bản còn là NHÁP ⇒ một vấn đề KHÁC, và câu chặn phải khác.
    const nhap = policyGaps({
      ...THANG_9,
      employees: [{ id: "NV1", name: "An" }],
      employments: [emp()],
      policyAssignments: [assign()],
      policyVersions: [ver({ status: "DRAFT" })],
    });
    assert.equal(nhap[0].code, "VERSION_NOT_EFFECTIVE", "bản nháp là chuyện khác hẳn chưa gán chính sách");
    assert.match(nhap[0].message, /Chính sách lương/, "và chỉ sang đúng tab khác");
  }

  // ─────────── CHUỖI BỐN THÁNG: LỖ CHỒNG LỖ, RỒI BÙ DẦN ───────────
  {
    /*
      Ca chủ shop đưa: T1 −10tr · T2 −5tr · T3 +8tr · T4 +20tr.

      Đây là ca mà mọi cách làm tắt đều sai. Cộng bốn tháng lại rồi lấy `max(…, 0)` cho ra 13tr —
      trùng hợp đúng bằng đáp án, nhưng chỉ vì ví dụ này kết thúc ở một tháng dương đủ lớn. Đổi T4
      thành +6tr thì phép cộng cho 0 còn phép tuần tự cho −1tr mang sang, và chúng khác nhau.
      Số dư là một chuỗi TUẦN TỰ, không phải một phép cộng.
    */
    const chuoi = carryoverChain(
      [
        { openingBalance: 0, realProfit: -10_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: -5_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: 8_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: 20_000_000, commissionPercent: 10 },
      ],
      0,
    );
    assert.equal(chuoi[0].closingBalance, -10_000_000, "T1 đóng ở −10tr");
    assert.equal(chuoi[1].closingBalance, -15_000_000, "T2 lỗ CHỒNG lên lỗ ⇒ −15tr");
    assert.equal(chuoi[2].closingBalance, -7_000_000, "T3 lãi 8tr bù bớt ⇒ −7tr");
    assert.equal(chuoi[3].commissionBase, 13_000_000, "T4: 20tr − 7tr = 13tr là cơ sở tính hoa hồng");
    assert.equal(chuoi[3].closingBalance, 0, "và bù hết nên sổ về 0");
    // Ba tháng đầu KHÔNG được trả đồng hoa hồng nào.
    for (const t of chuoi.slice(0, 3)) assert.equal(t.payableCommission, 0, "tháng còn âm sau bù ⇒ hoa hồng bằng 0");
    assert.equal(chuoi[3].payableCommission, 1_300_000, "T4 ăn 10% trên ĐÚNG 13tr, không phải trên 20tr");

    // Chạy lại y hệt ⇒ y hệt: chuỗi không được cộng dồn qua mỗi lượt tính.
    const lai = carryoverChain(
      [
        { openingBalance: 0, realProfit: -10_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: -5_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: 8_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: 20_000_000, commissionPercent: 10 },
      ],
      0,
    );
    assert.deepEqual(lai.map((x) => x.closingBalance), chuoi.map((x) => x.closingBalance), "chạy lại ra đúng một chuỗi");

    // Và phép CỘNG không thay được phép tuần tự — đổi tháng cuối là hai cách cho hai kết quả.
    const doiT4 = carryoverChain(
      [
        { openingBalance: 0, realProfit: -10_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: -5_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: 8_000_000, commissionPercent: 10 },
        { openingBalance: 0, realProfit: 6_000_000, commissionPercent: 10 },
      ],
      0,
    );
    assert.equal(doiT4[3].closingBalance, -1_000_000, "T4 chỉ +6tr ⇒ còn −1tr mang sang tháng 5");
    assert.equal(doiT4[3].payableCommission, 0);
  }

  // ─────────── ĐỀ XUẤT CHUYỂN ĐỔI TỪ HỒ SƠ CŨ ───────────
  {
    const hoSo = {
      id: "mig-1",
      name: "Người cũ",
      shortName: "Cũ",
      department: "Marketing",
      aliases: [],
      accountIds: [],
      fixed: 8_000_000,
      percentTotal: 2,
      percentPersonal: 10,
      percentRevenue: 0,
      active: true,
      note: "",
    };

    /*
      BÙ LỖ CHÉP TRẠNG THÁI HIỆN TẠI, KHÔNG ĐOÁN.

      Đây là chỗ dễ làm sai tiền nhất trong cả phép chuyển: sổ đang bật mà thành phần khai tắt thì
      người ấy bỗng ăn hoa hồng trên đủ lợi nhuận như chưa từng lỗ.
    */
    const tat = proposePolicyFromLegacy(hoSo, false);
    const bat = proposePolicyFromLegacy(hoSo, true);
    assert.equal(tat.components.find((c) => c.code === "PERSONAL_PROFIT_COMMISSION")?.carryForward, false);
    assert.equal(bat.components.find((c) => c.code === "PERSONAL_PROFIT_COMMISSION")?.carryForward, true);
    assert.ok(tat.notes.some((n) => /TẮT/.test(n)), "sổ đang tắt phải được nói ra, không im lặng");

    // Ô bằng 0 KHÔNG sinh thành phần: một thành phần khai 0 sẽ bị cổng chặn hỏi lại mãi.
    assert.equal(tat.components.length, 3, "ba ô khác 0 ⇒ ba thành phần; ô % doanh thu bằng 0 thì không sinh");
    assert.ok(!tat.components.some((c) => c.code === "REVENUE_COMMISSION"));

    // Lương cứng phải giữ NGUYÊN luật chia theo ngày của đường cũ — đó là điều kiện để số không đổi.
    assert.equal(tat.components.find((c) => c.code === "BASE_SALARY")?.prorate, "PERIOD_DAYS");

    // Hồ sơ trống rỗng thì nói thẳng là không ánh xạ được, không sinh một chính sách rỗng.
    const trong = proposePolicyFromLegacy({ ...hoSo, fixed: 0, percentTotal: 0, percentPersonal: 0 }, false);
    assert.equal(trong.components.length, 0);
    assert.equal(trong.blockers.length, 1);
  }

  // ─────────── ĐỐI CHIẾU: LỆCH PHẢI CÓ GIẢI THÍCH, KHÔNG THÌ CHẶN ───────────
  {
    const khop = reconcile({
      employeeId: "r1",
      employeeName: "A",
      old: { fixed: 8_000_000, bonusTotal: 1_000_000, bonusPersonal: 2_000_000, bonusRevenue: 0, salary: 11_000_000 },
      next: {
        components: [
          { code: "BASE_SALARY", amount: 8_000_000 },
          { code: "SHOP_PROFIT_SHARE", amount: 1_000_000 },
          { code: "PERSONAL_PROFIT_COMMISSION", amount: 2_000_000 },
          { code: "REVENUE_COMMISSION", amount: 0 },
        ],
        grossEarnings: 11_000_000,
        totalDeductions: 0,
        netPay: 11_000_000,
      },
      adjustmentTotal: 0,
    });
    assert.equal(khop.netDiff, 0);
    assert.equal(khop.hasUnexplained, false, "khớp hết ⇒ chuyển được");

    /*
      HAI TỔNG BẰNG NHAU KHÔNG CÓ NGHĨA LÀ ĐÚNG.

      Ở đây lương cứng thừa 1tr và hoa hồng thiếu 1tr — chúng triệt tiêu ở dòng NET. So theo TỪNG
      khoản mới bắt được; so mỗi tổng thì bảng xanh và tiền của người ấy vẫn sai ở hai chỗ.
    */
    const trietTieu = reconcile({
      employeeId: "r2",
      employeeName: "B",
      old: { fixed: 8_000_000, bonusTotal: 0, bonusPersonal: 2_000_000, bonusRevenue: 0, salary: 10_000_000 },
      next: {
        components: [
          { code: "BASE_SALARY", amount: 9_000_000 },
          { code: "PERSONAL_PROFIT_COMMISSION", amount: 1_000_000 },
        ],
        grossEarnings: 10_000_000,
        totalDeductions: 0,
        netPay: 10_000_000,
      },
      adjustmentTotal: 0,
    });
    assert.equal(trietTieu.netDiff, 0, "tổng bằng nhau…");
    assert.equal(trietTieu.hasUnexplained, true, "…nhưng hai khoản lệch triệt tiêu nhau PHẢI bị bắt");

    // Khoản điều chỉnh tay là lệch CÓ CHỦ Ý: đường cũ không có chỗ nào ghi tạm ứng.
    const coUng = reconcile({
      employeeId: "r3",
      employeeName: "C",
      old: { fixed: 8_000_000, bonusTotal: 0, bonusPersonal: 0, bonusRevenue: 0, salary: 8_000_000 },
      next: { components: [{ code: "BASE_SALARY", amount: 8_000_000 }], grossEarnings: 8_000_000, totalDeductions: 1_000_000, netPay: 7_000_000 },
      adjustmentTotal: -1_000_000,
    });
    assert.equal(coUng.netDiff, -1_000_000);
    assert.equal(coUng.hasUnexplained, false, "lệch đúng bằng khoản điều chỉnh ⇒ giải thích được ⇒ chuyển được");
    assert.match(coUng.lines.find((l) => l.key === "net")!.explanation, /CÓ CHỦ Ý/);

    // CHƯA BIẾT không được đọc thành "không lệch".
    const chuaBiet = reconcile({
      employeeId: "r4",
      employeeName: "D",
      old: { fixed: null, bonusTotal: 0, bonusPersonal: null, bonusRevenue: 0, salary: null },
      next: { components: [], grossEarnings: null, totalDeductions: null, netPay: null },
      adjustmentTotal: 0,
    });
    assert.equal(chuaBiet.hasUnexplained, true, "một bên chưa biết ⇒ KHÔNG được coi là khớp");
  }

  /*
    ═══ NĂM TRẠNG THÁI CHUYỂN ĐỔI — BẢNG CHÂN LÝ ═══

    Thứ tự ưu tiên là phần dễ sai nhất: gộp "có chênh lệch" vào "sẵn sàng" là in chữ "sẵn sàng" lên
    một người mà số cũ và số mới không bằng nhau, rồi người bấm bấm qua như mọi người khác.
  */
  {
    const st = (o: Partial<Parameters<typeof migrationStatus>[0]>) =>
      migrationStatus({ alreadyMigrated: false, blockers: [], componentCount: 1, hasUnexplainedDiff: false, ...o });

    assert.equal(st({}), "READY", "ánh xạ xong + khớp ⇒ SẴN SÀNG");
    assert.equal(st({ hasUnexplainedDiff: true }), "DIFF", "còn lệch chưa giải thích ⇒ CÓ CHÊNH LỆCH, không phải SẴN SÀNG");
    assert.equal(st({ blockers: ["chưa khai phân công"] }), "BLOCKED", "còn việc phải làm ⇒ BỊ CHẶN");
    assert.equal(st({ blockers: ["x"], hasUnexplainedDiff: true }), "BLOCKED", "bị chặn thắng chênh lệch — không bấm được thì phần lệch chưa phải việc hôm nay");
    assert.equal(st({ componentCount: 0 }), "LEGACY", "không ánh xạ được thành phần nào ⇒ CÒN Ở ĐƯỜNG CŨ, khác hẳn SẴN SÀNG");
    assert.equal(st({ componentCount: 0, blockers: ["x"] }), "BLOCKED", "có việc phải làm thì nói việc phải làm trước");
    assert.equal(st({ alreadyMigrated: true, blockers: ["x"], hasUnexplainedDiff: true, componentCount: 0 }), "MIGRATED", "đã chuyển thắng tất cả — bảng đối chiếu của kỳ cũ không còn là việc phải làm");

    assert.equal(new Set(MIGRATION_STATUSES).size, MIGRATION_STATUSES.length, "danh sách trạng thái không được trùng");
    for (const k of MIGRATION_STATUSES) assert.ok(MIGRATION_STATUS_LABEL[k]?.length, `trạng thái ${k} phải có nhãn tiếng Việt`);
  }

  /*
    ═══ KHẤU TRỪ THEO LUẬT: "CHƯA CẤU HÌNH" KHÔNG ĐƯỢC BẰNG "0 ĐỒNG" ═══

    Một phiếu lương in "0 ₫" ở dòng thuế là khẳng định khoản khấu trừ đã được tính và bằng không.
    Sự thật là chưa ai tính. Hai thứ ấy khác nhau, và bên chịu là người lao động (AGENTS.md mục 42).
  */
  {
    assert.equal(DEFAULT_STATUTORY.state, "NOT_CONFIGURED", "mặc định phải là CHƯA CẤU HÌNH — không tự khai hộ chủ shop một luật thuế");
    assert.equal(DEFAULT_STATUTORY.legalBasis, "", "chưa khai thì không có căn cứ pháp lý nào");

    const chua = statutoryDisplay(DEFAULT_STATUTORY);
    assert.equal(chua.amount, null, "CHƯA CẤU HÌNH phải trả CHƯA BIẾT, không phải 0 — trả 0 là để chỗ gọi cộng nó vào tổng như một con số đã xác minh");
    assert.equal(chua.label, STATUTORY_STATE_LABEL.NOT_CONFIGURED);

    const mien = statutoryDisplay({ ...DEFAULT_STATUTORY, state: "EXEMPT", legalBasis: "Cộng tác viên khoán, không thuộc diện đóng BHXH" });
    assert.equal(mien.amount, 0, "KHÔNG ÁP DỤNG là một khẳng định CÓ CHỦ ⇒ 0 thật, in được 0 ₫");
    assert.match(mien.hint, /Cộng tác viên khoán/, "căn cứ pháp lý phải đi kèm ra tới màn hình");

    const daKhai = statutoryDisplay({ ...DEFAULT_STATUTORY, state: "CONFIGURED", legalBasis: "Nghị định X" });
    assert.equal(daKhai.amount, null, "đã cấu hình thì SỐ TIỀN do thành phần trong chính sách tính, không do hàm hiển thị bịa ra");

    assert.equal(STATUTORY_STATES.length, 3, "ba trạng thái, và sự khác nhau giữa chúng là toàn bộ vấn đề");
  }

  console.log("  ✓ Máy tính lương chung: 30 tình huống bắt buộc + kiểm sổ khai · chuỗi bù lỗ 4 tháng · đề xuất và đối chiếu chuyển đổi · 5 trạng thái chuyển đổi");
}
