/**
 * ═══════ XEM TRƯỚC CHUYỂN NHÂN SỰ SANG MÁY TÍNH CHUNG — PHẦN CHẠM CSDL ═══════
 *
 * Phép đề xuất và phép đối chiếu là hàm THUẦN (`lib/payroll/migration-preview.ts`). File này chỉ
 * đọc lời khai cũ, chạy CẢ HAI đường tính cho cùng một kỳ, rồi đặt kết quả cạnh nhau.
 *
 * ─── VÌ SAO PHẢI CHẠY THẬT CẢ HAI ĐƯỜNG ───
 *
 * Đối chiếu bằng cách "nhân lại tỷ lệ cho nhanh" là dựng một đường tính THỨ BA chỉ tồn tại trong
 * bảng đối chiếu — và nó sẽ khớp với cả hai đường kia đúng tới lúc một trong hai đổi. Ở đây cả hai
 * cột đều là kết quả THẬT: cột CŨ từ `getPayrollReport` (đường bốn ô), cột MỚI từ máy thành phần
 * chạy trên chính bản đề xuất.
 */
import { calculatePayrollItem } from "@/lib/payroll/engine";
import { resolveSegments } from "@/lib/payroll/policy-resolve";
import { proposePolicyFromLegacy, reconcile, type MigrationProposal, type ReconResult } from "@/lib/payroll/migration-preview";
import { buildCandidateEmployments, legacyConfigGaps, newModelConfigGaps, type ConfigGap } from "@/lib/payroll/reconcile-context";
import { getCarryoverConfig } from "@/lib/queries/payroll-carryover";
import { getPayrollReport, listEmployees } from "@/lib/queries/payroll";
import { employeesOnPolicyEngine, loadAdjustments, loadAssignmentBook } from "@/lib/queries/payroll-policies";
import { payrollPeriodKey, type PayrollBasis } from "@/lib/constants/payroll";
import { PAYROLL_COMPONENT_SIGN, type PayrollComponentKind } from "@/lib/constants/payroll-components";
import type { Period } from "@/lib/search-params";

export type MigrationRow = {
  proposal: MigrationProposal;
  recon: ReconResult | null;
  /** Người này ĐÃ chuyển sang máy chung chưa. Đã chuyển thì không đề xuất lại. */
  alreadyMigrated: boolean;
  /** Đã khai phân công lao động chưa — thiếu nó thì máy chung coi như người ấy không đi làm ngày nào. */
  hasEmployment: boolean;
  /**
   * ═══ HAI DANH SÁCH THIẾU, TÁCH RỜI — XEM `lib/payroll/reconcile-context.ts` ═══
   *
   * `blockers` của bản đề xuất GỘP cả hai và màn hình “Xem trước chuyển đổi” chặn nút bấm bằng nó,
   * điều ấy đúng với câu hỏi CỦA MÀN HÌNH. Phép ĐỐI CHIẾU hỏi một câu khác nên phải đọc riêng:
   * thiếu dữ liệu của mô hình MỚI không làm nó mù, vì nó tự dựng bối cảnh ứng viên trong bộ nhớ.
   */
  legacyGaps: ConfigGap[];
  newModelGaps: ConfigGap[];
  /** Cột “mới” chạy trên phân công DỰNG TẠM (`true`) hay trên phân công thật (`false`). */
  syntheticEmployment: boolean;
};

/**
 * XEM TRƯỚC CHO TOÀN BỘ NHÂN SỰ ĐANG LÀM VIỆC.
 *
 * KHÔNG ghi gì. Đây là điểm quan trọng nhất của công cụ: nó đọc, tính, so, và dừng lại ở đó.
 */
export async function previewLegacyMigration(period: Period, basis: PayrollBasis): Promise<MigrationRow[]> {
  if (!period.from || !period.to) return [];
  const key = payrollPeriodKey(period.from, period.to);
  if (!key) return [];

  const [employees, report, carryConfig, daChuyen, book, adjustments] = await Promise.all([
    listEmployees(),
    getPayrollReport(period, basis),
    getCarryoverConfig(),
    employeesOnPolicyEngine(),
    loadAssignmentBook(),
    loadAdjustments(key),
  ]);

  const out: MigrationRow[] = [];
  for (const e of employees.filter((x) => x.active)) {
    const proposal = proposePolicyFromLegacy(e, carryConfig.enabled);
    const line = report.lines.find((l) => l.employee.id === e.id);
    const employments = book.employments.filter((x) => x.employeeId === e.id);
    const alreadyMigrated = daChuyen.has(e.id);

    if (!employments.length) {
      proposal.blockers.push(
        `${proposal.employeeName} chưa có dòng PHÂN CÔNG LAO ĐỘNG nào. Máy tính chung cắt kỳ theo mốc hiệu lực của phân công, nên thiếu nó thì mọi đoạn đều là “không đi làm” và lương ra 0 ₫. Khai ở tab “Phân công & gán chính sách” trước.`,
      );
    }

    /*
      CỘT "MỚI" CHẠY THẬT TRÊN BẢN ĐỀ XUẤT.

      Chưa khai phân công thì dựng một bối cảnh làm việc ỨNG VIÊN phủ trọn kỳ, CHỈ trong bộ nhớ.
      Không có nó thì cột mới luôn rỗng và bảng đối chiếu không nói được gì; có nó thì người bấm
      thấy đúng con số họ sẽ nhận sau khi khai đủ — và cổng đối chiếu trả lời được câu hỏi của nó
      TRƯỚC lượt chuyển, thay vì đòi kết quả của lượt chuyển làm điều kiện để chạy.
    */
    const boiCanh = buildCandidateEmployments({
      employeeId: e.id,
      legacyDepartment: e.department,
      period: { from: period.from, to: period.to },
      real: employments,
    });

    const segments = resolveSegments({
      from: period.from,
      to: period.to,
      employments: boiCanh.employments,
      policyAssignments: [
        { id: "preview", employeeId: e.id, policyId: "preview", policyCode: proposal.policyCode, policyName: proposal.policyName, effectiveFrom: period.from, effectiveTo: null },
      ],
      policyVersions: [{ id: "preview-v", policyId: "preview", version: 1, effectiveFrom: period.from, effectiveTo: null, status: "ACTIVE" }],
    });

    const adjRows = adjustments.byEmployee.get(e.id) ?? [];
    const ketQua = calculatePayrollItem({
      employeeId: e.id,
      employeeName: proposal.employeeName,
      segments: segments.map((segment) => ({
        segment,
        components: proposal.components,
        basis: {
          PROFIT_PERSONAL: line?.personalProfit ?? null,
          PROFIT_SHOP: report.totalProfit,
          REVENUE_PERSONAL: line?.personalRevenue ?? null,
          ORDERS_PERSONAL: null,
          PERIOD_DAYS: segment.days,
        },
      })),
      adjustments: adjRows.map((r) => ({ id: r.id, kind: r.kind as PayrollComponentKind, label: r.label, amount: r.amount, reason: r.reason })),
      // Số dư lỗ đầu kỳ của xem trước lấy từ chính `carry` mà đường cũ đã giải — hai đường phải
      // đứng trên CÙNG một số dư, nếu không bảng đối chiếu đang so hai thứ khác nhau.
      carryOpening: { [proposal.components.find((c) => c.carryForward)?.code ?? "__none"]: line?.carry?.openingBalance ?? null },
    });

    const adjustmentTotal = adjRows.reduce((t, r) => t + r.amount * (PAYROLL_COMPONENT_SIGN[r.kind as PayrollComponentKind] ?? 1), 0);

    out.push({
      proposal,
      alreadyMigrated,
      hasEmployment: employments.length > 0,
      legacyGaps: legacyConfigGaps({
        name: proposal.employeeName,
        fixed: e.fixed,
        percentTotal: e.percentTotal,
        percentPersonal: e.percentPersonal,
        percentRevenue: e.percentRevenue,
      }),
      newModelGaps: newModelConfigGaps({ hasEmployment: employments.length > 0, hasPolicyAssignment: alreadyMigrated }),
      syntheticEmployment: boiCanh.synthetic,
      recon: line
        ? reconcile({
            employeeId: e.id,
            employeeName: proposal.employeeName,
            old: { fixed: line.fixed, bonusTotal: line.bonusTotal, bonusPersonal: line.bonusPersonal, bonusRevenue: line.bonusRevenue, salary: line.salary },
            next: { components: ketQua.components, grossEarnings: ketQua.grossEarnings, totalDeductions: ketQua.totalDeductions, netPay: ketQua.netPay },
            adjustmentTotal,
          })
        : null,
    });
  }
  return out;
}
