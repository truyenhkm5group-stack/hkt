/**
 * ═══════════ MỘT BỘ ĐIỀU KIỆN CHỐT LƯƠNG, DÙNG CHUNG CHO MÀN HÌNH VÀ SERVER ═══════════
 *
 * Trước bản này điều kiện chốt nằm RẢI RÁC: server action kiểm bốn thứ, còn màn hình tự quyết có
 * hiện nút hay không bằng một biểu thức riêng. Hai nơi, hai mệnh đề, và không ai buộc chúng nói
 * cùng một điều — nên hoặc là nút hiện rồi server từ chối (bắt người dùng phát hiện luật bằng cách
 * bấm nhầm), hoặc tệ hơn: nút ẩn vì một lý do, còn server lại cho qua vì lý do khác.
 *
 * Nay cả hai gọi CÙNG hàm này. Nó là hàm THUẦN — nhận vào bản báo cáo đã tính, trả ra danh sách
 * VIỆC CÒN THIẾU kèm lý do đọc được. Không đọc CSDL, không gọi lại phép tính nào.
 *
 * ─── PHÂN BIỆT "THIẾU CĂN CỨ TÀI CHÍNH" VỚI "THÔNG BÁO KHÔNG ẢNH HƯỞNG SỐ" ───
 *
 * Chặn mọi cảnh báo là cách nhanh nhất để không bao giờ chốt được kỳ nào, và rồi ai đó sẽ tắt hết
 * cảnh báo cho xong. Nên chỉ những thứ làm SAI SỐ TIỀN mới chặn:
 *
 *  · một con số dùng để trả tiền đang là CHƯA BIẾT;
 *  · một khoản chi có thật đang bị BỎ RA ngoài phép tính (cảnh báo mức `high` của máy chi phí);
 *  · số dư lỗ đầu kỳ chưa xác lập, nên cơ sở tính hoa hồng chưa có căn cứ.
 *
 * Cảnh báo mức `medium` là lời khai về NGUỒN, không phải lỗ hổng về SỐ — nó đi cùng con số để chủ
 * shop đọc, nhưng không chặn.
 */
import type { CostEngineWarning } from "@/lib/queries/cost-engine";

export type FinalizeBlocker = {
  /** Khoá ổn định để kiểm thử và để màn hình chọn cách hiển thị. */
  code:
    | "PERIOD_UNBOUNDED"
    | "BASIS_NOT_ELIGIBLE"
    | "UNKNOWN_SALARY"
    | "COST_EVIDENCE_MISSING"
    | "CARRYOVER_OPENING_NOT_ESTABLISHED"
    | "ENGINE_INPUT_MISSING"
    | "ENGINE_POLICY_PROBLEM"
    | "POLICY_BOOK_INVALID";
  /** Nói ĐÚNG cái đang thiếu, và nói được phải làm gì. Không có "dữ liệu không hợp lệ". */
  message: string;
};

/**
 * Hình dạng tối thiểu của bản báo cáo mà hàm này cần. Cố ý KHÔNG nhận `PayrollReport` đầy đủ:
 * `lib/queries/payroll.ts` import ngược lại đây thì thành vòng module, và một hàm thuần không nên
 * biết tới cả cây kiểu của tầng truy vấn.
 */
export type ReadinessInput = {
  bounded: boolean;
  basisEligible: boolean;
  basisWhy: string;
  basisLabel: string;
  totalSalary: number | null;
  costWarnings: readonly CostEngineWarning[];
  /** Mỗi dòng lương: đã có số dư lỗ đủ căn cứ chưa (bỏ qua khi sổ không áp dụng). */
  lines: readonly {
    name: string;
    carryEstablished: boolean | null;
    carryReason: string | null;
    /**
     * Đại lượng còn THIẾU của máy tính lương chung (chấm công chưa nhập, KPI chưa chấm…). Mỗi mục
     * là một con số CHƯA BIẾT đang nằm trong tiền của người này.
     */
    engineMissing?: readonly { label: string; message: string }[];
    /** Vấn đề về CẤU HÌNH: chưa gán chính sách, phiên bản còn là bản nháp. Khác hẳn thiếu số liệu. */
    engineProblems?: readonly string[];
  }[];
  /**
   * Lỗi ở SỔ KHAI (`lib/payroll/policy-validation.ts`): chồng lấn mốc gán, khoảng trống không
   * chính sách nào phủ, thành phần thiếu tỷ lệ/đơn giá, phiên bản chưa hiệu lực.
   *
   * Tách khỏi `engineProblems` vì chúng nói ở hai MỨC khác nhau: `engineProblems` nói "đoạn này
   * không tính được", còn đây nói "sổ khai thiếu gì và sửa ở đâu". Người đọc cần cái thứ hai để
   * đi làm được việc.
   */
  policyIssues?: readonly { message: string; blocking: boolean }[];
};

export function payrollFinalizeBlockers(input: ReadinessInput): FinalizeBlocker[] {
  const out: FinalizeBlocker[] = [];

  if (!input.bounded) {
    out.push({
      code: "PERIOD_UNBOUNDED",
      message: "Kỳ “Toàn bộ” không có mốc đầu/cuối nên không có danh tính nào để chốt, và lương cứng của nó là CHƯA BIẾT.",
    });
  }
  if (!input.basisEligible) {
    out.push({
      code: "BASIS_NOT_ELIGIBLE",
      message: `Cơ sở “${input.basisLabel}” không dùng để chốt lương được. ${input.basisWhy}`,
    });
  }
  if (input.totalSalary === null) {
    out.push({
      code: "UNKNOWN_SALARY",
      message:
        "Còn con số CHƯA BIẾT trong kỳ (lương cứng, thưởng theo LN cá nhân, hoặc số dư lỗ mang sang). Chốt lúc này là đóng băng một chỗ trống rồi gọi nó là kết quả.",
    });
  }

  /*
    CHỈ CHẶN CẢNH BÁO MỨC `high`. Máy chi phí dùng `high` cho đúng một loại chuyện: có tiền thật
    đang NẰM NGOÀI phép tính (khoản gõ tay bị loại vì trùng nguồn, phần nhóm lương chưa đối chiếu
    được). Đó là "chi phí chưa đủ căn cứ" theo đúng nghĩa. `medium` là lời khai về nguồn — đi cùng
    con số, không chặn.
  */
  for (const w of input.costWarnings) {
    if (w.severity !== "high") continue;
    out.push({
      code: "COST_EVIDENCE_MISSING",
      message: `${w.title}. ${w.detail} Việc cần làm: ${w.action}`,
    });
  }

  /*
    SỐ DƯ LỖ ĐẦU KỲ PHẢI ĐÃ XÁC LẬP.

    Xem được không có nghĩa là chốt được: số dư mô phỏng từ một tháng còn NHÁP sẽ đổi khi tháng ấy
    được chốt, mà tiền thì đã trả rồi. `carryEstablished === null` nghĩa là sổ không áp dụng cho kỳ
    này — không phải một lỗ hổng.
  */
  const thieuSoDu = input.lines.filter((l) => l.carryEstablished === false);
  for (const l of thieuSoDu) {
    out.push({
      code: "CARRYOVER_OPENING_NOT_ESTABLISHED",
      message: `Số dư lỗ đầu kỳ của ${l.name} chưa xác lập. ${l.carryReason ?? ""}`.trim(),
    });
  }

  /*
    ═══ MÁY TÍNH LƯƠNG CHUNG: THIẾU SỐ LIỆU VÀ THIẾU CẤU HÌNH LÀ HAI CHUYỆN KHÁC NHAU ═══

    Cả hai đều chặn chốt, nhưng việc phải làm khác hẳn nhau, nên chúng KHÔNG được gộp thành một câu
    "dữ liệu chưa đủ":

      · THIẾU SỐ LIỆU  — chính sách khai đúng, nhưng chưa ai nhập ngày công / KPI / sản lượng. Việc
        phải làm: một người đi nhập, ở tab Đầu vào.
      · THIẾU CẤU HÌNH — người này chưa gán chính sách, hoặc chính sách chỉ mới có bản nháp. Việc
        phải làm: một người đi khai, ở tab Chính sách.

    Không chặn thì hậu quả không phải một cảnh báo bỏ lỡ: `netPay` là `null` ⇒ `totalSalary` là
    `null` ⇒ cửa `UNKNOWN_SALARY` ở trên đã chặn rồi, nhưng nó chỉ nói "còn con số chưa biết" mà
    không nói con số nào của ai. Hai cửa dưới đây nói ĐÚNG chỗ và đúng người.
  */
  for (const issue of input.policyIssues ?? []) {
    if (!issue.blocking) continue;
    out.push({ code: "POLICY_BOOK_INVALID", message: issue.message });
  }

  for (const l of input.lines) {
    for (const m of l.engineMissing ?? []) {
      out.push({ code: "ENGINE_INPUT_MISSING", message: `${l.name} — thiếu “${m.label}”. ${m.message}` });
    }
    for (const p of l.engineProblems ?? []) {
      out.push({ code: "ENGINE_POLICY_PROBLEM", message: `${l.name} — ${p}` });
    }
  }

  return out;
}
