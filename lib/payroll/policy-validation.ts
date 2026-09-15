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
import { PAYROLL_COMPONENT_SIGN, carryForwardAllowed, componentBasisKey, payrollInput, type PolicyComponent } from "@/lib/constants/payroll-components";
import { formatDate } from "@/lib/format";
import { componentRef, danglingRefs, findCycles } from "@/lib/payroll/policy-graph";
import type { EmploymentRow, PolicyAssignmentRow, PolicyVersionRow } from "@/lib/payroll/policy-resolve";
import { isWorkingSegment, resolveSegments } from "@/lib/payroll/policy-resolve";

export type PolicyIssue = {
  code: "ASSIGNMENT_OVERLAP" | "EMPLOYMENT_OVERLAP" | "POLICY_GAP" | "COMPONENT_MISSING_PARAM" | "VERSION_NOT_EFFECTIVE";
  /** Khoá nhân sự. `null` = vấn đề của CHÍNH SÁCH, không của một người. */
  employeeId: string | null;
  /** Nói ĐÚNG việc phải làm và ĐÚNG chỗ phải sửa. Không có "dữ liệu không hợp lệ". */
  message: string;
  /** Có chặn chốt kỳ không. `false` = đáng đọc nhưng không làm sai số tiền. */
  blocking: boolean;
};

// Cùng lý do với `engine.ts`: `toLocaleDateString` đổi ĐỊNH DẠNG chứ không đổi MÚI GIỜ, và máy
// chủ chạy UTC — mốc đầu ngày Việt Nam sẽ in lùi một ngày.
const ngay = (d: Date) => formatDate(d);

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
 * HAI DÒNG PHÂN CÔNG LAO ĐỘNG CÙNG PHỦ MỘT NGÀY.
 *
 * Cùng một lỗ hổng với gán chính sách, nhưng hậu quả KHÁC và nặng hơn: dòng phân công mang cả
 * `status`. Hai dòng chồng lấn mà một dòng ghi `TERMINATED` thì `resolveSegments` lấy dòng có
 * `effectiveFrom` MUỘN NHẤT — nên chỉ cần khai thêm một dòng "đã nghỉ" có mốc muộn hơn là cả đoạn
 * ấy thôi được tính lương, im lặng, không lỗi nào nổ ra.
 *
 * Khác với gán chính sách, đường ghi phân công KHÔNG tự đóng dòng cũ (và không nên tự đóng: đổi
 * phòng ban không phải lúc nào cũng là kết thúc dòng trước). Nên phép kiểm này là chỗ DUY NHẤT
 * phát hiện ra, và nó CHẶN chốt kỳ.
 */
export function employmentOverlaps(rows: readonly EmploymentRow[], nameOf: (id: string) => string): PolicyIssue[] {
  const out: PolicyIssue[] = [];
  const byEmployee = new Map<string, EmploymentRow[]>();
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
        code: "EMPLOYMENT_OVERLAP",
        employeeId,
        blocking: true,
        message: `${nameOf(employeeId)} có hai dòng phân công lao động cùng phủ ngày ${ngay(b.effectiveFrom)}: dòng từ ${ngay(a.effectiveFrom)}${a.effectiveTo ? ` đến ${ngay(a.effectiveTo)}` : ", còn hiệu lực"} (${a.status}) và dòng từ ${ngay(b.effectiveFrom)} (${b.status}). Trạng thái làm việc của những ngày chồng lấn — và do đó việc có tính lương hay không — sẽ do thứ tự dòng quyết định. Sửa ở tab “Phân công & gán chính sách”: đóng dòng cũ lại tại ngày liền trước.`,
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
    ...employmentOverlaps(input.employments, nameOf),
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

/**
 * ═══════════ CỔNG PHÁT HÀNH MỘT PHIÊN BẢN CHÍNH SÁCH ═══════════
 *
 * Phát hành là lúc một lời khai trở thành cách trả tiền cho người thật. Mọi thứ sai sau mốc ấy đều
 * đã thành một con số trên phiếu lương của ai đó.
 *
 * Kiểm ở đây, KHÔNG kiểm lúc lưu nháp: bản nháp là chỗ để viết dở, và bắt nó hoàn chỉnh ngay từ ô
 * đầu tiên là bắt người khai phải nghĩ xong toàn bộ chính sách trước khi gõ chữ nào.
 *
 * Hàm THUẦN — màn hình gọi để hiện danh sách việc còn thiếu, server action gọi CHÍNH nó để quyết
 * định cho qua hay không. Hai nơi tự viết hai mệnh đề là cách nút hiện rồi server từ chối.
 */
export type ActivationBlocker = { code: string; message: string };

export function policyActivationBlockers(input: {
  policyCode: string;
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  components: readonly PolicyComponent[];
  /** Các phiên bản ĐANG HIỆU LỰC khác của cùng chính sách — để bắt chồng lấn. */
  otherActiveVersions: readonly { version: number; effectiveFrom: Date; effectiveTo: Date | null }[];
}): ActivationBlocker[] {
  const out: ActivationBlocker[] = [];
  const day = (d: Date) => formatDate(d);

  // ─── 1. KHÔNG CÓ THÀNH PHẦN NÀO ───
  if (!input.components.length) {
    out.push({
      code: "NO_COMPONENT",
      message: `Phiên bản ${input.version} chưa có thành phần nào. Phát hành nó là gán cho người một chính sách trả 0 đồng mà không ai thấy.`,
    });
  }

  // ─── 2. MỐC HIỆU LỰC ───
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    out.push({ code: "BAD_EFFECTIVE_RANGE", message: `Mốc kết thúc ${day(input.effectiveTo)} đứng trước mốc bắt đầu ${day(input.effectiveFrom)} — đó là một đoạn rỗng đội lốt.` });
  }

  // ─── 3. CHỒNG LẤN VỚI PHIÊN BẢN ĐANG HIỆU LỰC KHÁC ───
  /*
    Hai phiên bản cùng phủ một ngày thì `resolveSegments` lấy bản có `effectiveFrom` muộn hơn —
    đúng, nhưng IM LẶNG. Tiền của những ngày ấy do một quy tắc ngầm quyết định, không do người khai.
  */
  const tu = input.effectiveFrom.getTime();
  const den = input.effectiveTo ? input.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
  for (const v of input.otherActiveVersions) {
    const vTu = v.effectiveFrom.getTime();
    const vDen = v.effectiveTo ? v.effectiveTo.getTime() : Number.POSITIVE_INFINITY;
    if (vTu > den || vDen < tu) continue;
    out.push({
      code: "VERSION_OVERLAP",
      message: `Phiên bản ${input.version} (${day(input.effectiveFrom)}${input.effectiveTo ? ` – ${day(input.effectiveTo)}` : " trở đi"}) chồng lấn ngày với phiên bản ${v.version} đang hiệu lực. Đóng bản cũ lại tại ngày liền trước, nếu không tiền của những ngày chồng lấn do thứ tự dòng quyết định.`,
    });
  }

  // ─── 4. PHỤ THUỘC VÒNG TRÒN VÀ THAM CHIẾU TRỎ VÀO CHỖ TRỐNG ───
  for (const c of findCycles(input.components)) out.push({ code: "DEPENDENCY_CYCLE", message: c.message });
  for (const m of danglingRefs(input.components)) out.push({ code: "DANGLING_REF", message: m });

  // ─── 5. THAM SỐ BẮT BUỘC ───
  for (const b of componentMissingParams(input.policyCode, input.components)) {
    out.push({ code: "COMPONENT_MISSING_PARAM", message: b.message });
  }

  // ─── 6. TỪNG THÀNH PHẦN: ĐẠI LƯỢNG CÓ THẬT, BẬC HỢP LỆ, TỶ LỆ KHÔNG ÂM ───
  const khoa = new Set<string>();
  for (const c of input.components) {
    if (khoa.has(c.code)) {
      out.push({ code: "DUPLICATE_CODE", message: `Khoá thành phần “${c.code}” bị lặp. Máy tính gộp theo khoá nên hai dòng ấy sẽ cộng thành một khoản không ai đối chiếu lại được.` });
    }
    khoa.add(c.code);

    const key = componentBasisKey(c.calc);
    if (key && !componentRef(key) && !payrollInput(key)) {
      out.push({ code: "UNKNOWN_BASIS", message: `Thành phần “${c.label}” nối vào đại lượng “${key}” không có trong sổ đăng ký đầu vào. Máy sẽ đọc rỗng, nhân ra NaN, và NaN in ra màn hình thành “—” như một chỗ trống bình thường.` });
    }

    /*
      TỶ LỆ ÂM Ở MỘT KHOẢN CỘNG LÀ MỘT KHOẢN TRỪ ĐỘI LỐT.

      Muốn trừ thì khai loại khoản là `DEDUCTION` — lúc ấy dấu do LOẠI quyết định và người đọc phiếu
      lương thấy nó nằm đúng nhóm. Một tỷ lệ âm trong nhóm "thu nhập" thì trên phiếu nó vẫn đứng ở
      cột thu nhập.
    */
    if (c.calc.type === "RATE_OF_BASIS" && c.calc.ratePercent < 0 && PAYROLL_COMPONENT_SIGN[c.kind] === 1) {
      out.push({ code: "NEGATIVE_RATE", message: `Thành phần “${c.label}” khai tỷ lệ ÂM (${c.calc.ratePercent}%) trong một khoản CỘNG. Muốn trừ thì đổi loại khoản thành khấu trừ, để dấu do loại quyết định và người đọc phiếu lương thấy nó nằm đúng nhóm.` });
    }
    if (c.calc.type === "PER_UNIT" && c.calc.unitRate < 0 && PAYROLL_COMPONENT_SIGN[c.kind] === 1) {
      out.push({ code: "NEGATIVE_RATE", message: `Thành phần “${c.label}” khai đơn giá ÂM trong một khoản CỘNG. Đổi loại khoản thành khấu trừ nếu ý định là trừ.` });
    }

    if (c.calc.type === "TIERED_RATE") {
      const bac = [...c.calc.tiers].sort((a, b) => a.from - b.from);
      if (bac[0].from !== 0) {
        out.push({ code: "TIER_GAP", message: `Thành phần “${c.label}”: bậc thấp nhất bắt đầu từ ${bac[0].from.toLocaleString("vi-VN")} chứ không từ 0. Phần dưới mốc ấy không thuộc bậc nào và sẽ lặng lẽ thành 0.` });
      }
      for (let i = 1; i < bac.length; i += 1) {
        if (bac[i].from === bac[i - 1].from) {
          out.push({ code: "TIER_OVERLAP", message: `Thành phần “${c.label}”: hai bậc cùng mốc ${bac[i].from.toLocaleString("vi-VN")}. Không xác định được bậc nào áp cho phần vượt.` });
        }
      }
      if (bac.some((t) => t.ratePercent < 0)) {
        out.push({ code: "NEGATIVE_RATE", message: `Thành phần “${c.label}”: có bậc khai tỷ lệ ÂM.` });
      }
    }

    if (c.minAmount !== null && c.maxAmount !== null && c.maxAmount < c.minAmount) {
      out.push({ code: "BOUND_INVERTED", message: `Thành phần “${c.label}”: trần (${c.maxAmount.toLocaleString("vi-VN")}) thấp hơn sàn (${c.minAmount.toLocaleString("vi-VN")}) — cặp ấy không có giá trị nào thoả.` });
    }

    if (c.carryForward && !carryForwardAllowed(c.calc)) {
      out.push({ code: "CARRY_NOT_ALLOWED", message: `Thành phần “${c.label}” bật bù lỗ lũy kế nhưng đại lượng của nó không bao giờ âm. Sổ lỗ ở đó sẽ là một dòng không bao giờ khác 0.` });
    }
  }

  return out;
}
