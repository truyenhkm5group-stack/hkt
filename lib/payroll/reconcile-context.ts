/**
 * ═══════ BỐI CẢNH ỨNG VIÊN CHO PHÉP ĐỐI CHIẾU — DỰNG TRONG BỘ NHỚ, KHÔNG BAO GIỜ GHI ═══════
 *
 * ─── SỰ CỐ TỆP NÀY SINH RA ĐỂ CHẶN ───
 *
 * Lượt đối chiếu production 18/09/2026 trả về **4/4 nhân sự = “Thiếu khai báo”**, và cổng đứng lại
 * ở `RECONCILIATION_BLOCKED_BY_CONFIG`. Đọc kỹ bản in thì phép tính ĐÃ CHẠY: chuỗi lợi nhuận của
 * từng marketer in đủ, lương cứng đối chiếu ra `3.000.000 = 3.000.000` lệch 0 ₫.
 *
 * Nghĩa là cả hai đường tính đều ra số, đặt cạnh nhau được, và KHỚP — rồi bị một cái nhãn ném đi.
 *
 * Nguyên nhân: `proposal.blockers` là MỘT danh sách chuỗi gộp hai loại thiếu khác hẳn nhau, và
 * `scripts/payroll-reconcile.ts` đọc cả danh sách ấy làm căn cứ kết luận:
 *
 *  · **THIẾU KHAI BÁO CỦA MÔ HÌNH MỚI** — chưa có dòng `employment_assignments`, chưa gán chính
 *    sách. Đây là việc phải làm TRƯỚC KHI CHUYỂN THẬT, và màn hình “Xem trước chuyển đổi” chặn nút
 *    bấm bằng nó là ĐÚNG. Nhưng với phép ĐỐI CHIẾU thì nó không phải một chỗ thiếu: chính đường đối
 *    chiếu đã dựng sẵn một phân công ứng viên trong bộ nhớ phủ trọn kỳ để chạy cột “mới”.
 *  · **THIẾU KHAI BÁO NGHIỆP VỤ CŨ** — bốn ô lương cũ đều trống, hoặc một tỷ lệ khai ra số không
 *    dùng được. Cái này mới thật sự làm phép đối chiếu không có gì để so.
 *
 * ─── CÂU HỎI CỦA ĐỐI CHIẾU KHÁC CÂU HỎI CỦA MÀN HÌNH CHUYỂN ĐỔI ───
 *
 * Màn hình hỏi: *“người này CHUYỂN được chưa?”* — chưa khai phân công thì chưa, dứt khoát.
 * Đối chiếu hỏi: *“NẾU chuyển người này sang máy chung với ĐÚNG luật nghiệp vụ hiện hành, con số
 * có đổi không?”* — và câu ấy trả lời được TRƯỚC khi ai khai một dòng nào, đó chính là lý do phép
 * đối chiếu tồn tại. Bắt nó đòi dữ liệu của mô hình mới là bắt nó chạy SAU thứ nó phải chạy TRƯỚC.
 *
 * Nên hai câu hỏi đọc hai danh sách khác nhau. `blockers` giữ nguyên cho màn hình — không một dòng
 * hành vi nào của nó đổi; đối chiếu đọc `legacyConfigGaps()`.
 *
 * ─── HÀM THUẦN, VÀ CHỈ NẰM TRONG BỘ NHỚ ───
 *
 * Không đọc CSDL, không ghi CSDL, không đọc đồng hồ. Phân công ứng viên dựng ở đây KHÔNG BAO GIỜ
 * được ghi xuống và KHÔNG BAO GIỜ được dùng để trả tiền thật — nó mang cờ
 * `RECONCILIATION_ONLY_SYNTHETIC_CONTEXT` để chỗ nào lỡ cầm nó đi xa cũng đọc được điều đó.
 */
import type { EmploymentRow } from "@/lib/payroll/policy-resolve";

/**
 * NHÃN CỦA MỘT BỐI CẢNH DỰNG TẠM.
 *
 * Nó là một CHUỖI chứ không phải một `boolean` để khi con số đi vào báo cáo / JSON xuất ra, người
 * đọc thấy đúng chữ ấy thay vì một cờ `true` không nói được nó bật vì cái gì.
 */
export const RECONCILIATION_ONLY_SYNTHETIC_CONTEXT = "RECONCILIATION_ONLY_SYNTHETIC_CONTEXT" as const;

/** Hai loại “thiếu”, và chỉ một loại là lý do chính đáng để KHÔNG đối chiếu được. */
export type ConfigGapKind = "LEGACY_BUSINESS_CONFIG" | "NEW_MODEL_CONFIG";

export type ConfigGap = {
  kind: ConfigGapKind;
  message: string;
};

/** Bốn ô lương trên hồ sơ nhân sự cũ — đúng những gì `proposePolicyFromLegacy` đọc. */
export type LegacyPayrollConfig = {
  name: string;
  fixed: number;
  percentTotal: number;
  percentPersonal: number;
  percentRevenue: number;
};

/** Ba ô tỷ lệ, kèm tên người đọc hiểu. Danh sách ĐÓNG — thêm ô mới thì phải khai vào đây. */
const RATE_FIELDS = [
  { key: "percentTotal", label: "% lợi nhuận tổng" },
  { key: "percentPersonal", label: "% lợi nhuận cá nhân" },
  { key: "percentRevenue", label: "% doanh thu cá nhân" },
] as const;

/** Cùng phép ép kiểu mà cả hai đường tính dùng cho ô lương cứng — chép luật là mở đường cho lệch. */
const fixedOf = (v: number): number => Math.max(0, Math.round(Number(v) || 0));

/**
 * ═══ CHỖ THIẾU THẬT SỰ CỦA HỒ SƠ CŨ ═══
 *
 * Trả về danh sách rỗng ⇒ dựng được chính sách ứng viên ⇒ ĐỐI CHIẾU ĐƯỢC, bất kể mô hình mới còn
 * trống tới đâu.
 *
 * Hai điều kiện dưới đây đều là chỗ hai đường tính **thật sự** không đứng chung được, chứ không
 * phải một thủ tục chưa làm:
 *
 *  1. **Không ô nào khai** ⇒ không có thành phần nào để sinh ⇒ không có gì để so. Đây đúng là câu
 *     `proposePolicyFromLegacy` đã nói, và nó là một chỗ thiếu THẬT.
 *  2. **Một tỷ lệ không phải số hữu hạn ≥ 0.** Chỗ này tinh: đường CŨ nhân thẳng
 *     (`round(max(LN,0) × p/100)`) nên một `p` âm ra một khoản thưởng ÂM, còn bản đề xuất chỉ sinh
 *     thành phần khi `p > 0` nên nó BỎ hẳn khoản ấy. Hai đường đứng trên hai luật khác nhau vì một
 *     con số khai sai — và phần lệch sinh ra sẽ trông y hệt một lỗi của máy tính mới.
 *
 * Còn `fixed` âm hay `NaN` thì KHÔNG vào đây: cả hai đường đều ép nó về 0 bằng cùng một phép, nên
 * chúng vẫn đồng ý. Đưa nó vào là loại một người ra khỏi mẫu đối chiếu mà chẳng có gì để lo.
 */
export function legacyConfigGaps(e: LegacyPayrollConfig): ConfigGap[] {
  const gaps: ConfigGap[] = [];

  for (const f of RATE_FIELDS) {
    const v = e[f.key];
    if (!Number.isFinite(v) || v < 0) {
      gaps.push({
        kind: "LEGACY_BUSINESS_CONFIG",
        message: `${e.name}: ô “${f.label}” trên hồ sơ cũ đang là ${String(v)} — không phải một tỷ lệ dùng được. Đường CŨ vẫn nhân thẳng con số ấy, còn bản đề xuất chỉ sinh thành phần khi tỷ lệ > 0, nên hai đường sẽ đứng trên hai luật khác nhau. Sửa ô ấy ở hồ sơ nhân sự rồi đối chiếu lại.`,
      });
    }
  }

  const coRate = RATE_FIELDS.some((f) => Number.isFinite(e[f.key]) && e[f.key] > 0);
  if (fixedOf(e.fixed) <= 0 && !coRate) {
    gaps.push({
      kind: "LEGACY_BUSINESS_CONFIG",
      message: `${e.name} chưa khai ô nào trên hồ sơ nhân sự cũ (lương cứng và cả ba tỷ lệ đều bằng 0), nên KHÔNG có gì để ánh xạ sang máy chung và cũng không có gì để đối chiếu. Khai chính sách tay ở tab “Chính sách lương”.`,
    });
  }

  return gaps;
}

/**
 * ═══ CHỖ THIẾU CỦA MÔ HÌNH MỚI — BÁO CHỨ KHÔNG CHẶN ═══
 *
 * Danh sách này vẫn được in ra, vì nó là việc phải làm trước khi chuyển THẬT. Nhưng nó KHÔNG được
 * dùng để kết luận một người “chưa đối chiếu được”: phép đối chiếu chạy TRƯỚC lượt chuyển, và đòi
 * kết quả của lượt chuyển làm điều kiện để đối chiếu là một vòng tròn.
 */
export function newModelConfigGaps(input: { hasEmployment: boolean; hasPolicyAssignment: boolean }): ConfigGap[] {
  const gaps: ConfigGap[] = [];
  if (!input.hasEmployment) {
    gaps.push({
      kind: "NEW_MODEL_CONFIG",
      message: `Chưa có dòng PHÂN CÔNG LAO ĐỘNG trong mô hình mới. Phép đối chiếu tự dựng một phân công ứng viên phủ trọn kỳ trong bộ nhớ (${RECONCILIATION_ONLY_SYNTHETIC_CONTEXT}) nên vẫn so được; nhưng trước khi CHUYỂN THẬT thì phải khai ở tab “Phân công & gán chính sách”.`,
    });
  }
  if (!input.hasPolicyAssignment) {
    gaps.push({
      kind: "NEW_MODEL_CONFIG",
      message: `Chưa gán chính sách lương trong mô hình mới. Phép đối chiếu dùng chính sách ỨNG VIÊN dựng từ hồ sơ cũ, chỉ nằm trong bộ nhớ.`,
    });
  }
  return gaps;
}

export type CandidateEmployments = {
  /** Danh sách đưa thẳng cho `resolveSegments`. */
  employments: EmploymentRow[];
  /** `true` ⇒ không có dòng phân công THẬT nào, đây là bối cảnh dựng tạm chỉ để đối chiếu. */
  synthetic: boolean;
  /** Nhãn ghi vết. `null` khi dùng phân công thật. */
  marker: typeof RECONCILIATION_ONLY_SYNTHETIC_CONTEXT | null;
};

/**
 * ═══ DỰNG BỐI CẢNH LÀM VIỆC ỨNG VIÊN ═══
 *
 * CÓ phân công thật thì dùng phân công thật — luôn luôn, không bao giờ đè lên nó. Chỉ khi KHÔNG có
 * dòng nào mới dựng tạm một dòng phủ trọn kỳ.
 *
 * ─── VÌ SAO CHỈ CẦN BẤY NHIÊU TRƯỜNG ───
 *
 * Máy tính lương đọc đúng HAI thứ từ phân công: `status !== "TERMINATED"` (`isWorkingSegment`) và
 * số ngày của đoạn. `workMode`, `positionName`, `employmentType`, `managerUserId`,
 * `standardWorkDays` không tham gia một phép tính tiền nào hôm nay — nên thiếu chúng KHÔNG được
 * chặn phép đối chiếu. Chúng vẫn được điền bằng dữ liệu cũ khi có (phòng ban), và bằng giá trị
 * trung tính khi không, để bản in nói đúng thứ nó biết.
 *
 * ─── MỐC HIỆU LỰC ───
 *
 * Hồ sơ nhân sự cũ (`settings: payroll.employees`) KHÔNG lưu ngày vào làm. Nên bối cảnh tạm phủ
 * ĐÚNG kỳ đang đối chiếu và mang nhãn `RECONCILIATION_ONLY_SYNTHETIC_CONTEXT`. Đây là một giả định
 * nói ra thành lời — “coi như người này đi làm trọn kỳ” — chứ không phải một dữ kiện; nó hợp lệ cho
 * câu hỏi *“cùng luật thì hai máy có ra cùng số không”*, và tuyệt đối không hợp lệ để trả tiền.
 */
export function buildCandidateEmployments(input: {
  employeeId: string;
  /** Phòng ban trên hồ sơ cũ. Chỉ để in ra, không tham gia phép tính. */
  legacyDepartment: string;
  period: { from: Date; to: Date };
  real: readonly EmploymentRow[];
}): CandidateEmployments {
  if (input.real.length > 0) {
    return { employments: [...input.real], synthetic: false, marker: null };
  }
  return {
    synthetic: true,
    marker: RECONCILIATION_ONLY_SYNTHETIC_CONTEXT,
    employments: [
      {
        id: RECONCILIATION_ONLY_SYNTHETIC_CONTEXT,
        employeeId: input.employeeId,
        departmentId: null,
        departmentName: input.legacyDepartment,
        positionId: null,
        positionName: "",
        managerUserId: null,
        employmentType: "FULL_TIME",
        workMode: "ONSITE",
        status: "ACTIVE",
        standardWorkDays: null,
        effectiveFrom: input.period.from,
        effectiveTo: null,
      },
    ],
  };
}
