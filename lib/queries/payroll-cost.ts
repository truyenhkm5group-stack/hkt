/**
 * ═══════ CHI PHÍ NHÂN SỰ ĐƯỢC GHI NHẬN — GIAO DIỆN TÀI CHÍNH DÙNG CHUNG ═══════
 *
 * Đây là cửa DUY NHẤT để Profit Engine hỏi bảng Lương "kỳ này chi phí nhân sự được ghi nhận là bao
 * nhiêu". Trả về kèm ĐỘ PHỦ, vì chuyển thẩm quyền mà không kiểm tra độ phủ là cách nhanh nhất làm
 * lương biến mất khỏi lợi nhuận.
 *
 * ─────────── VÌ SAO HOA HỒNG KHÔNG THỂ DO BẢNG LƯƠNG GHI NHẬN (hiện nay) ───────────
 *
 * Cả bốn cơ sở tính hoa hồng của ERP đều là **phần trăm của LỢI NHUẬN** (LN1, LN2, dòng tiền, danh
 * nghĩa). Muốn coi hoa hồng là một khoản CHI PHÍ nằm trong lợi nhuận thì phải biết lợi nhuận trước
 * đã — mà lợi nhuận lại cần biết chi phí. Vòng tròn.
 *
 * Có hai cách thoát, và cả hai đều là quyết định của chủ shop chứ không phải của ERP:
 *  (a) chốt một cơ sở KHÔNG dẫn xuất từ lợi nhuận (vd % doanh thu thuần), hoặc
 *  (b) chấp nhận hoa hồng là phân phối lợi nhuận SAU khi đã có lợi nhuận, không phải chi phí.
 *
 * Trước khi chủ shop chốt, ERP **không đoán**: hoa hồng giữ nguyên đường cũ (khoản chi ở bảng Chi
 * phí) và bật cảnh báo `COMMISSION_BASIS_NEEDS_REVIEW`. Đây cũng là lý do file này KHÔNG gọi
 * `getPayrollReport` — gọi vào là tạo đệ quy vô hạn với Profit Engine.
 */
import { inclusiveDays, prorateMonthlyAmount } from "@/lib/constants/cost-allocation";
import type { CoverageState } from "@/lib/constants/cost-authority";
import { PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import type { Period } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";

export const PAYROLL_RECOGNITION_KEY = "payroll.recognition";

export type PayrollRecognitionMode = "LEGACY_EXPENSES" | "PAYROLL";

export type PayrollRecognitionConfig = {
  /**
   * `LEGACY_EXPENSES` (mặc định) — chi phí nhân sự vào lợi nhuận qua khoản chi nhóm "Lương" ở bảng
   * Chi phí, đúng như ERP đang chạy. Đổi sang `PAYROLL` là quyết định của chủ shop, và chỉ nên đổi
   * SAU khi đã ngừng ghi lương vào bảng Chi phí — nếu không sẽ có hai nguồn cho cùng một khoản.
   */
  mode: PayrollRecognitionMode;
};

export const DEFAULT_PAYROLL_RECOGNITION: PayrollRecognitionConfig = { mode: "LEGACY_EXPENSES" };

export type PayrollRecognition = {
  fixedSalary: number;
  commission: number;
  totalPayrollCost: number;
  recognitionPeriod: { from: Date | null; to: Date | null; days: number };
  allocationBasis: {
    fixedSalary: "PERIOD_PRORATA";
    /** `null` = chưa chốt được cơ sở tính hoa hồng ⇒ bảng Lương không ghi nhận hoa hồng */
    commission: null;
  };
  /**
   * ĐỘ PHỦ CỦA RIÊNG LƯƠNG CỨNG. Cố ý KHÔNG phải "độ phủ của cả chi phí nhân sự".
   *
   * Xem `componentCoverage` để biết vì sao: một cờ duy nhất cho hai thành phần là cách hoa hồng
   * biến mất khi chủ shop đổi nguồn.
   */
  coverage: CoverageState;
  /**
   * ═══ ĐỘ PHỦ THEO TỪNG THÀNH PHẦN ═══
   *
   * Trước bản này chỉ có MỘT cờ `coverage`, và nó bật `COMPLETE` chỉ vì lương cứng > 0. Máy chi phí
   * đọc cờ ấy rồi loại TOÀN BỘ nhóm "Lương" ở bảng Chi phí — trong đó có cả hoa hồng — trong khi
   * nguồn mới chỉ góp được lương cứng. Kết quả: đổi một ô cấu hình là hoa hồng rơi khỏi lợi nhuận,
   * và lợi nhuận tăng lên đúng bằng khoản ấy.
   *
   * Hai thành phần, hai cờ. Chuyển quyền cho thành phần nào thì chỉ thành phần ấy đổi nguồn.
   */
  componentCoverage: {
    fixedSalary: CoverageState;
    /**
     * Hôm nay LUÔN `INCOMPLETE`: cả bốn cơ sở tính hoa hồng đều là % của LỢI NHUẬN nên hoa hồng
     * không thể vừa là đầu vào vừa là đầu ra (xem khối chú thích đầu file). Đây là lời khai, không
     * phải một giá trị tạm.
     */
    commission: CoverageState;
  };
  /** Vì sao chưa đủ độ phủ — hiện thẳng cho chủ shop, không nuốt lỗi */
  reasons: string[];
  mode: PayrollRecognitionMode;
  activeEmployees: number;
  /** Tổng lương cứng khai báo mỗi tháng (chưa chia theo kỳ) — để đối chiếu */
  monthlyFixedTotal: number;
};

/**
 * Chi phí nhân sự được ghi nhận cho khoảng `[from, to]`.
 *
 * `coverage = COMPLETE` là điều kiện DUY NHẤT để Profit Engine loại khoản "Lương" ở bảng Chi phí.
 * Mọi trường hợp còn lại đều lùi về nguồn cũ — và lùi thì phải nói, không được lùi im lặng.
 */
export async function getRecognizedPayrollCost(period: Period): Promise<PayrollRecognition> {
  // Đọc thẳng settings, KHÔNG import `listEmployees` từ `lib/queries/payroll`: bảng lương lại đọc
  // Profit Engine, nên import ngược sẽ tạo vòng module.
  const [config, employees] = await Promise.all([
    getSettingJson<PayrollRecognitionConfig>(PAYROLL_RECOGNITION_KEY, DEFAULT_PAYROLL_RECOGNITION),
    getSettingJson<{ list: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] }).then((v) => v.list ?? []),
  ]);
  const mode: PayrollRecognitionMode = config?.mode === "PAYROLL" ? "PAYROLL" : "LEGACY_EXPENSES";
  const active = employees.filter((e) => e && e.active !== false);
  const monthlyFixedTotal = active.reduce((t, e) => t + Math.max(0, Math.round(Number(e.fixed) || 0)), 0);

  // Chia theo SỐ NGÀY THẬT của từng tháng: 9.000.000đ/tháng, xem 7 ngày của tháng 30 ngày = 2.100.000đ.
  const fixedSalary = prorateMonthlyAmount(monthlyFixedTotal, period.from, period.to);
  // Cùng hàm đếm ngày với `prorateMonthlyAmount`: mốc cuối là 23:59:59 nên chia rồi làm tròn ra
  // thừa một ngày (7 ngày thành 8), và con số ấy hiện thẳng ra màn hình.
  const days = period.from && period.to ? Math.max(0, inclusiveDays(period.from, period.to)) : 0;

  const reasons: string[] = [];
  if (mode !== "PAYROLL") {
    reasons.push("Chưa bật bảng Lương làm nguồn ghi nhận chi phí nhân sự (đang dùng khoản chi nhóm “Lương” ở bảng Chi phí).");
  }
  if (!period.from || !period.to) {
    reasons.push("Kỳ báo cáo không có mốc đầu/cuối nên không chia lương theo ngày được.");
  }
  if (!active.length) {
    reasons.push("Chưa khai nhân sự nào đang làm việc, không có lương cứng để ghi nhận.");
  } else if (monthlyFixedTotal <= 0) {
    reasons.push("Đã khai nhân sự nhưng lương cứng đều bằng 0.");
  }
  // Hoa hồng: xem khối chú thích đầu file — không thể vừa là đầu vào vừa là đầu ra của lợi nhuận.
  reasons.push("Hoa hồng đang tính theo % LỢI NHUẬN nên không thể đồng thời là chi phí nằm trong lợi nhuận; bảng Lương chưa ghi nhận hoa hồng.");

  const fixedCoverage: CoverageState = mode === "PAYROLL" && period.from && period.to && fixedSalary > 0 ? "COMPLETE" : "INCOMPLETE";
  // Hoa hồng chưa có nguồn nào ngoài bảng Chi phí, và điều đó KHÔNG đổi theo cấu hình — nên đây là
  // hằng số có lý do, không phải một giá trị chờ điền.
  const commissionCoverage: CoverageState = "INCOMPLETE";

  return {
    fixedSalary: fixedCoverage === "COMPLETE" ? fixedSalary : 0,
    commission: 0,
    totalPayrollCost: fixedCoverage === "COMPLETE" ? fixedSalary : 0,
    recognitionPeriod: { from: period.from, to: period.to, days },
    allocationBasis: { fixedSalary: "PERIOD_PRORATA", commission: null },
    coverage: fixedCoverage,
    componentCoverage: { fixedSalary: fixedCoverage, commission: commissionCoverage },
    reasons,
    mode,
    activeEmployees: active.length,
    monthlyFixedTotal,
  };
}
