/**
 * ═══════════ KIỂM LỜI KHAI TRƯỚC KHI NÓ THÀNH TIỀN — HÀM THUẦN ═══════════
 *
 * Bốn cách hỏng mà một sổ chính sách + phân công có thể mắc, và cả bốn đều KHÔNG lộ ra ở con số
 * cuối cùng — đó là lý do chúng phải có một chỗ kiểm riêng:
 *
 *  1. **Chồng lấn** — hai dòng gán chính sách cùng phủ một ngày. Tiền của ngày ấy phụ thuộc vào
 *     thứ tự dòng, thứ không ai đọc ra được từ màn hình.
 *  2. **Khoảng trống** — một đoạn trong kỳ mà người đang đi làm nhưng không chính sách nào phủ.
 *     Máy tính sẽ nói ra, nhưng nói ở mức TỪNG ĐOẠN; ở đây nói ở mức "sổ khai thiếu gì".
 *  3. **Thiếu tham số** — một thành phần khai tỷ lệ 0, đơn giá 0 hay ngưỡng 0. Nó KHÔNG phải lỗi
 *     kỹ thuật: 0 là một số hợp lệ. Nhưng "chưa ai nhập" và "chủ shop quyết là 0" trông y hệt
 *     nhau, nên phải hỏi lại chứ không được lặng lẽ trả 0 đồng.
 *  4. **Phiên bản không phủ** — chính sách có bản nháp nhưng chưa bản nào hiệu lực trong kỳ.
 *
 * Hàm thuần: nhận vào lời khai đã đọc, trả ra danh sách việc phải làm. Không đọc CSDL, nên kiểm
 * thử được bằng số viết tay.
 */
import type { PolicyComponent } from "@/lib/constants/payroll-components";
import type { EmploymentRow, PolicyAssignmentRow, PolicyVersionRow } from "@/lib/payroll/policy-resolve";
import { isWorkingSegment, resolveSegments } from "@/lib/payroll/policy-resolve";

export type PolicyIssue = {
  code: "ASSIGNMENT_OVERLAP" | "POLICY_GAP" | "COMPONENT_MISSING_PARAM" | "VERSION_NOT_EFFECTIVE";
  /** Khoá nhân sự. `null` = vấn đề của CHÍNH SÁCH, không của một người. */
  employeeId: string | null;
  /** Nói ĐÚNG việc phải làm và ĐÚNG chỗ phải sửa. Không có "dữ liệu không hợp lệ". */
  message: string;
  /** Có chặn chốt kỳ không. `false` = đáng đọc nhưng không làm sai số tiền. */
  blocking: boolean;
};

const ngay = (d: Date) => d.toLocaleDateString("vi-VN");

/**
 * HAI DÒNG GÁN CHÍNH SÁCH CÙNG PHỦ MỘT NGÀY.
 *
 * `resolveSegments` vẫn chạy được (nó lấy dòng có `effectiveFrom` MUỘN NHẤT), nên không có lỗi nào
 * nổ ra — và đó chính là vấn đề: tiền của những ngày ấy do một quy tắc ngầm quyết định. Người khai
 * phải đóng dòng cũ lại, không phải tin vào thứ tự.
 */
export function assignmentOverlaps(rows: readonly PolicyAssignmentRow[], nameOf: (id: string) => string): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  const byEmployee = new Map<string, PolicyAssignmentRow[]>();
  for (const r of rows) {
    const list = byEmployee.get(r.employeeId) ?? [];
    list.push(r);
    byEmployee.set(r.employeeId, list);
  }
  for (const [employeeId, list] of byEmployee) {
    const sorted = [...list].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const aTo = a.effectiveTo ? a.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
      if (aTo < b.effectiveFrom.getTime()) continue;
      out.push({
        code: "ASSIGNMENT_OVERLAP",
        employeeId,
        blocking: true,
        message: `${nameOf(employeeId)} có hai dòng gán chính sách cùng phủ ngày ${ngay(b.effectiveFrom)}: “${a.policyCode}” (từ ${ngay(a.effectiveFrom)}${a.effectiveTo ? ` đến ${ngay(a.effectiveTo)}` : ", còn hiệu lực"}) và “${b.policyCode}” (từ ${ngay(b.effectiveFrom)}). Tiền của những ngày chồng lấn sẽ do thứ tự dòng quyết định. Sửa ở tab “Phân công & gán chính sách”: đóng dòng cũ lại tại ngày liền trước.`,
      });
    }
  }
  return out;
}

/**
 * THAM SỐ BẰNG 0 LÀ MỘT CÂU HỎI, KHÔNG PHẢI MỘT LỖI.
 *
 * 0 là một giá trị hợp lệ — chủ shop có thể thật sự muốn một thành phần bằng 0 trong một kỳ. Nhưng
 * "chưa ai nhập" và "đã quyết là 0" trông y hệt nhau trên màn hình, và cái giá của việc đoán nhầm
 * là một người không nhận được khoản mình đáng nhận. Nên nó CHẶN, và câu chặn nói rõ cách xác nhận:
 * khai đúng số, hoặc bỏ thành phần khỏi chính sách.
 */
export function componentMissingParams(policyCode: string, components: readonly PolicyComponent[]): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  for (const c of components) {
    const thieu = (cai: string, sua: string) =>
      out.push({
        code: "COMPONENT_MISSING_PARAM",
        employeeId: null,
        blocking: true,
        message: `Chính sách “${policyCode}” · thành phần “${c.label}”: ${cai} đang bằng 0. ERP KHÔNG đặt hộ con số này — nó là một quyết định kinh doanh. ${sua}`,
      });
    switch (c.calc.type) {
      case "FIXED_AMOUNT":
        if (c.calc.amount === 0) thieu("số tiền", "Khai đúng số tiền ở tab Chính sách lương, hoặc bỏ thành phần này khỏi phiên bản.");
        break;
      case "PER_UNIT":
        if (c.calc.unitRate === 0) thieu("đơn giá", "Khai đơn giá cho mỗi đơn vị, hoặc bỏ thành phần này.");
        break;
      case "RATE_OF_BASIS":
        if (c.calc.ratePercent === 0) thieu("tỷ lệ phần trăm", "Khai tỷ lệ, hoặc bỏ thành phần này.");
        break;
      case "THRESHOLD_BONUS":
        if (c.calc.amount === 0) thieu("mức thưởng khi đạt ngưỡng", "Khai mức thưởng, hoặc bỏ thành phần này.");
        break;
      case "TIERED_RATE":
        if (c.calc.tiers.every((t) => t.ratePercent === 0)) thieu("tỷ lệ của mọi bậc", "Khai tỷ lệ cho ít nhất một bậc, hoặc bỏ thành phần này.");
        break;
    }
  }
  return out;
}

/**
 * ĐOẠN NÀO NGƯỜI ĐANG ĐI LÀM MÀ KHÔNG CHÍNH SÁCH NÀO PHỦ.
 *
 * Khác với `PayrollItemResult.problems` ở chỗ nó trả lời được ở mức SỔ KHAI: nói đúng khoảng ngày
 * còn trống và chỗ phải sửa, thay vì chỉ nói "đoạn này chưa có chính sách".
 */
export function policyGaps(input: {
  from: Date;
  to: Date;
  employees: readonly { id: string; name: string }[];
  employments: readonly EmploymentRow[];
  policyAssignments: readonly PolicyAssignmentRow[];
  policyVersions: readonly PolicyVersionRow[];
}): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  const coGan = new Set(input.policyAssignments.map((a) => a.employeeId));
  for (const e of input.employees) {
    // Người CHƯA gán chính sách nào vẫn đi đường tính cũ — đó là trạng thái hợp lệ trong giai đoạn
    // chuyển, không phải một lỗ hổng. Chỉ soi người ĐÃ bước sang máy mới.
    if (!coGan.has(e.id)) continue;
    const segs = resolveSegments({
      from: input.from,
      to: input.to,
      employments: input.employments.filter((x) => x.employeeId === e.id),
      policyAssignments: input.policyAssignments.filter((x) => x.employeeId === e.id),
      policyVersions: input.policyVersions,
    });
    for (const sg of segs) {
      if (!isWorkingSegment(sg)) continue;
      if (sg.policyVersionId) continue;
      out.push({
        code: sg.policyId ? "VERSION_NOT_EFFECTIVE" : "POLICY_GAP",
        employeeId: e.id,
        blocking: true,
        message: sg.policyId
          ? `${e.name}: đoạn ${ngay(sg.from)} – ${ngay(sg.to)} (${sg.days} ngày) gán chính sách “${sg.policyCode}” nhưng chính sách ấy chưa có phiên bản nào ĐANG HIỆU LỰC trong khoảng đó. Bản nháp không dùng để trả tiền. Sửa ở tab “Chính sách lương”: phát hành một phiên bản có mốc hiệu lực phủ đoạn này.`
          : `${e.name}: đoạn ${ngay(sg.from)} – ${ngay(sg.to)} (${sg.days} ngày) đang đi làm nhưng KHÔNG chính sách nào phủ. Người này đã bước sang máy tính chung nên đoạn ấy sẽ ra 0 đồng nếu không ai để ý. Sửa ở tab “Phân công & gán chính sách”.`,
      });
    }
  }
  return out;
}

/** Gộp cả bốn phép kiểm. Màn hình và cổng chốt kỳ gọi CHUNG hàm này. */
export function validatePolicyBook(input: {
  from: Date;
  to: Date;
  employees: readonly { id: string; name: string }[];
  employments: readonly EmploymentRow[];
  policyAssignments: readonly PolicyAssignmentRow[];
  policyVersions: readonly PolicyVersionRow[];
  /** Thành phần theo `versionId`, kèm mã chính sách để nói được nó thuộc về đâu. */
  componentsByVersion: ReadonlyMap<string, readonly PolicyComponent[]>;
  policyCodeByVersion: ReadonlyMap<string, string>;
}): PolicyIssue[] {
  const nameOf = (id: string) => input.employees.find((e) => e.id === id)?.name ?? id;
  const out: PolicyIssue[] = [
    ...assignmentOverlaps(input.policyAssignments, nameOf),
    ...policyGaps(input),
  ];
  /*
    CHỈ SOI PHIÊN BẢN THẬT SỰ ĐƯỢC DÙNG TRONG KỲ.

    Soi mọi phiên bản của mọi chính sách sẽ đẩy ra hàng loạt cảnh báo về những bản không ai đang
    dùng — và một danh sách chặn dài toàn thứ không liên quan là một danh sách người ta tắt đi.
  */
  const dungTrongKy = new Set<string>();
  for (const e of input.employees) {
    const segs = resolveSegments({
      from: input.from,
      to: input.to,
      employments: input.employments.filter((x) => x.employeeId === e.id),
      policyAssignments: input.policyAssignments.filter((x) => x.employeeId === e.id),
      policyVersions: input.policyVersions,
    });
    for (const sg of segs) if (sg.policyVersionId && isWorkingSegment(sg)) dungTrongKy.add(sg.policyVersionId);
  }
  for (const versionId of dungTrongKy) {
    const comps = input.componentsByVersion.get(versionId) ?? [];
    out.push(...componentMissingParams(input.policyCodeByVersion.get(versionId) ?? versionId, comps));
  }
  return out;
}
