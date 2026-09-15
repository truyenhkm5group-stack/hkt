/**
 * ═══════ CHI PHÍ NHÂN SỰ ĐƯỢC GHI NHẬN — GIAO DIỆN TÀI CHÍNH DÙNG CHUNG ═══════
 *
 * Đây là cửa DUY NHẤT để Profit Engine hỏi bảng Lương "kỳ này chi phí nhân sự được ghi nhận là bao
 * nhiêu". Trả về kèm ĐỘ PHỦ, vì chuyển thẩm quyền mà không kiểm tra độ phủ là cách nhanh nhất làm
 * lương biến mất khỏi lợi nhuận.
 *
 * ─────────── HOA HỒNG: CƠ SỞ ĐÃ CÓ TÊN, VÀ VÌ THẾ KHÔNG CÒN VÒNG TRÒN ───────────
 *
 * Hoa hồng tính bằng phần trăm của LỢI NHUẬN. Nếu nó đồng thời là chi phí nằm trong chính lợi
 * nhuận ấy thì hai vế định nghĩa lẫn nhau — một phép khai không xác định, không phải một bài toán
 * khó. Bản trước không chọn điểm dừng nào và bật một cảnh báo treo mãi mãi.
 *
 * `lib/constants/compensation-profit.ts` nay chọn, và chọn bằng cách ĐẶT TÊN cho điểm dừng:
 *
 *     LỢI NHUẬN TRƯỚC THÙ LAO BIẾN ĐỔI = doanh thu − mọi chi phí TRỪ hoa hồng
 *     hoa hồng                          = r × (cơ sở ấy, sau bù lỗ lũy kế)
 *     LỢI NHUẬN KẾ TOÁN                 = cơ sở − hoa hồng
 *
 * Cơ sở trả tiền và kết quả kinh doanh là HAI con số mang HAI cái tên. Gộp chúng lại chính là chỗ
 * sinh ra vòng tròn; tách ra thì vòng tròn không còn chỗ tồn tại.
 *
 * ─── NHƯNG FILE NÀY VẪN KHÔNG GỌI `getPayrollReport`, VÀ LÝ DO ĐỔI ───
 *
 * Trước: vì vòng tròn KHÁI NIỆM. Nay: vì vòng gọi hàm ở mức MÃ NGUỒN —
 * `getOperatingCost` → file này → `getPayrollReport` → `getMarketerReport` → `getOperatingCost`.
 * Khái niệm đã hết vòng, nhưng lời gọi thì chưa; nên hoa hồng vẫn được ghi nhận qua bảng Chi phí,
 * và phần đo được của lỗ hổng ấy (khoản nhóm "Lương" vượt quá lương cứng — nhiều khả năng là hoa
 * hồng đang nằm trong cơ sở) được `cost-engine.ts` cảnh báo CÓ ĐIỀU KIỆN: có thì báo, không có
 * thì im, thay vì một câu hỏi treo không bao giờ tắt.
 */
import { inclusiveDays, prorateMonthlyAmount } from "@/lib/constants/cost-allocation";
import type { CoverageState } from "@/lib/constants/cost-authority";
import { COMPENSATION_PROFIT_BASIS, COMPENSATION_PROFIT_LABEL, type CompensationProfitBasis } from "@/lib/constants/compensation-profit";
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
    /** `null` = bảng Lương KHÔNG ghi nhận hoa hồng (đường gọi hàm đi vòng) — xem `compensationBasis`. */
    commission: null;
  };
  /** Tên nghiệp vụ của cơ sở tính thù lao đang áp dụng. Không còn là một câu hỏi treo. */
  compensationBasis: CompensationProfitBasis;
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
  /**
   * LƯƠNG CỨNG THUỘC KỲ ĐÃ TÍNH RA, BẤT KỂ CÓ ĐƯỢC GHI NHẬN HAY KHÔNG.
   *
   * `fixedSalary` ở trên là con số ĐƯỢC GHI NHẬN — bằng 0 khi bảng Lương chưa cầm quyền. Nhưng
   * "không được ghi nhận" khác hẳn "không phát sinh": nghĩa vụ vẫn có, chỉ là nó đang không nằm
   * trong lợi nhuận. Muốn nói được câu đó thành một con số thì phải giữ lại phép tính, nên trường
   * này tồn tại.
   */
  fixedSalaryDue: number;
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
  // Hoa hồng: xem khối chú thích đầu file. Cơ sở đã có tên và đã loại hoa hồng ra khỏi chính nó;
  // thứ còn thiếu là một đường GỌI HÀM không đi vòng, không phải một quyết định nghiệp vụ.
  reasons.push(
    `Hoa hồng được khai là khoản trừ SAU cơ sở “${COMPENSATION_PROFIT_LABEL}”, không nằm trong cơ sở của chính nó. Bảng Lương chưa ghi nhận nó vì đường gọi hàm sẽ đi vòng (chi phí → bảng lương → chi phí); hoa hồng vẫn vào lợi nhuận qua bảng Chi phí.`,
  );

  const fixedCoverage: CoverageState = mode === "PAYROLL" && period.from && period.to && fixedSalary > 0 ? "COMPLETE" : "INCOMPLETE";
  // Hoa hồng chưa có nguồn nào ngoài bảng Chi phí, và điều đó KHÔNG đổi theo cấu hình — nên đây là
  // hằng số có lý do, không phải một giá trị chờ điền. Lý do nay là đường GỌI HÀM đi vòng, không
  // còn là cơ sở nghiệp vụ chưa chốt (xem khối đầu file).
  const commissionCoverage: CoverageState = "INCOMPLETE";

  return {
    fixedSalary: fixedCoverage === "COMPLETE" ? fixedSalary : 0,
    commission: 0,
    totalPayrollCost: fixedCoverage === "COMPLETE" ? fixedSalary : 0,
    recognitionPeriod: { from: period.from, to: period.to, days },
    allocationBasis: { fixedSalary: "PERIOD_PRORATA", commission: null },
    compensationBasis: COMPENSATION_PROFIT_BASIS,
    coverage: fixedCoverage,
    componentCoverage: { fixedSalary: fixedCoverage, commission: commissionCoverage },
    reasons,
    mode,
    activeEmployees: active.length,
    monthlyFixedTotal,
    fixedSalaryDue: fixedSalary,
  };
}
