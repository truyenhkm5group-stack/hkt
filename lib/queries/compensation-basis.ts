/**
 * ═══════════ CHI PHÍ THUỘC CƠ SỞ TÍNH LƯƠNG — MỘT CHIỀU, KHÔNG CÓ ĐƯỜNG VỀ ═══════════
 *
 * ─── SỰ THẬT VỀ "VÒNG LẶP": NÓ CHƯA BAO GIỜ TỒN TẠI Ở MỨC CHẠY ───
 *
 * Bản ghi chép trước nói có vòng gọi hàm `getOperatingCost → payroll-cost → getPayrollReport →
 * getMarketerReport → getOperatingCost`. Đọc lại mã nguồn thì KHÔNG: `lib/queries/payroll-cost.ts`
 * chỉ đọc `settings` và không import một dòng nào từ `payroll.ts` hay `cost-engine.ts`. Chiều phụ
 * thuộc hôm nay đã là một cây:
 *
 *     payroll.ts → cost-engine.ts → payroll-cost.ts → settings
 *
 * Vòng ấy là vòng SẼ xuất hiện nếu `payroll-cost` đi tính hoa hồng bằng cách gọi ngược bảng lương.
 * Nó là một cái bẫy, không phải một lỗi đang chạy.
 *
 * ─── NHƯNG CÓ MỘT LỖI ĐANG CHẠY, VÀ NÓ LÀM SAI TIỀN ───
 *
 * `getOperatingCost().amount` là tổng khối vận hành, và khối ấy **bao gồm hoa hồng**. Con số ấy đi
 * thẳng vào `productEconomics` → lợi nhuận từng mã → `PROFIT_PERSONAL` → cơ sở tính hoa hồng.
 *
 * Nên hôm nay: **hoa hồng của kỳ TRƯỚC (đã trả, đã ghi ở bảng Chi phí) đang làm giảm cơ sở tính
 * hoa hồng của kỳ NÀY.** Không phải một vòng lặp vô hạn — một phép trừ sai, im lặng, mỗi kỳ.
 *
 * Tệp này cắt đúng chỗ đó. Nó KHÔNG phải một nguồn chi phí thứ hai: nó DẪN XUẤT từ chính
 * `getRecognizedCosts` (một nguồn duy nhất, AGENTS.md mục 18) rồi trừ đi phần thù lao biến đổi
 * theo đúng lời khai ở `lib/constants/compensation-profit.ts`.
 *
 * ─── HAI THỨ PHẢI TRỪ, VÀ CHÚNG KHÁC ĐỘ TIN CẬY ───
 *
 *  1. **Thành phần `COMMISSION`** — đo được, tách bạch. Trừ thẳng.
 *  2. **Phần hoa hồng NẰM LẪN trong nhóm "Lương" ở bảng Chi phí** — ERP không tách được hai thứ ấy
 *     trong cùng một nhóm. Phần vượt quá lương cứng đã khai là ƯỚC TÍNH tốt nhất có được, và nó
 *     được trừ kèm nhãn `ESTIMATED` cùng một câu nói rõ giới hạn: nếu shop ghi lương cho người
 *     CHƯA khai trong sổ nhân sự thì phần vượt ấy là lương chứ không phải hoa hồng, và phép trừ
 *     này trừ nhầm.
 *
 * Không trừ gì cả thì cơ sở thấp hơn sự thật đúng bằng khoản hoa hồng kỳ trước — chiều hỏng làm
 * người lao động MẤT tiền, và không ai đi kiểm một con số thấp.
 */
import { COMPENSATION_PROFIT_RULES, COMPENSATION_PROFIT_LABEL } from "@/lib/constants/compensation-profit";
import type { CostComponent } from "@/lib/constants/cost-authority";
import { OPERATING_COMPONENTS, getRecognizedCosts, type CostEngineWarning, type LogisticsAdjustmentTotal } from "@/lib/queries/cost-engine";
import type { Period } from "@/lib/search-params";

/** Một khoản bị loại khỏi cơ sở, kèm mức tin cậy — ước tính KHÔNG được đi im lặng. */
export type BasisExclusion = {
  component: CostComponent | "SALARY_EMBEDDED_COMMISSION";
  label: string;
  amount: number;
  confidence: "MEASURED" | "ESTIMATED";
  why: string;
};

export type CompensationBasisCost = {
  /** Chi phí vận hành THUỘC cơ sở tính lương (đã trừ thù lao biến đổi). */
  amount: number;
  /** Tổng khối vận hành đầy đủ — để đối chiếu, và để báo cáo kế toán dùng. */
  operatingTotal: number;
  count: number;
  payrollCovered: boolean;
  exclusions: BasisExclusion[];
  warnings: CostEngineWarning[];
  /**
   * Cước / phí hoàn gõ tay khai `MANUAL_ADJUSTMENT` kèm lý do — NGUYÊN VĂN từ
   * `getRecognizedCosts().logisticsAdjustment`, không tự đọc bảng Chi phí lần thứ hai (luật 18).
   *
   * KHÔNG thuộc `amount` (khối vận hành): nó là thành phần Cước / Phí hoàn, nên cơ sở tính lương
   * trừ nó ở cột VẬN CHUYỂN (`lib/queries/payroll.ts::productEconomics`). Nó cũng không phải thù
   * lao biến đổi nên không có gì để loại — đứng trong cơ sở như mọi chi phí thật khác.
   */
  logisticsAdjustment: LogisticsAdjustmentTotal;
};

/**
 * ═══ CHI PHÍ VẬN HÀNH ĐỂ DỰNG `PRE_VARIABLE_COMPENSATION_PROFIT` ═══
 *
 * KHÔNG gọi `getPayrollReport`, KHÔNG gọi `getMarketerReport`, KHÔNG gọi một phép tính hoa hồng
 * nào. Chỉ đọc `getRecognizedCosts` — thứ đã đứng dưới bảng lương trong cây phụ thuộc.
 *
 * `tests/payroll-dependency.test.ts` quét mã nguồn để giữ điều đó: ngày nào có người thêm một lời
 * gọi ngược vào đây, bài kiểm đỏ ngay, chứ không đợi tới lúc một yêu cầu treo vì đệ quy.
 */
export async function getOperatingCostForCompensationBasis(period: Period): Promise<CompensationBasisCost> {
  const costs = await getRecognizedCosts(period);
  const payrollCovered = costs.payroll.coverage === "COMPLETE";
  const exclusions: BasisExclusion[] = [];

  /*
    1 · THÀNH PHẦN KHAI RÕ LÀ NGOÀI CƠ SỞ.

    Đọc từ sổ khai chứ không gõ tên: thêm một loại thù lao biến đổi mới thì chỉ cần khai ở
    `COMPENSATION_PROFIT_RULES`, không phải nhớ sửa thêm chỗ này.
  */
  for (const c of OPERATING_COMPONENTS) {
    const rule = COMPENSATION_PROFIT_RULES[c];
    if (rule.included) continue;
    const amount = costs.components[c].amount;
    if (amount === 0) continue;
    exclusions.push({ component: c, label: costs.components[c].label, amount, confidence: "MEASURED", why: rule.why });
  }

  /*
    2 · PHẦN HOA HỒNG NẰM LẪN TRONG NHÓM "LƯƠNG".

    Chỉ áp khi bảng Lương CHƯA cầm quyền — lúc ấy cả nhóm "Lương" (gồm hoa hồng) nằm trọn trong
    thành phần `SALARY`, và không có cách nào tách hai thứ ra trong cùng một nhóm. Khi bảng Lương
    ĐÃ cầm quyền thì phần vượt đã được tách sang thành phần `COMMISSION` và bước 1 ở trên đã trừ nó;
    trừ thêm lần nữa ở đây là trừ hai lần.
  */
  if (!payrollCovered) {
    const luongCung = costs.payroll.fixedSalaryDue;
    const nhomLuong = costs.components.SALARY.amount;
    const vuot = Math.max(0, nhomLuong - luongCung);
    if (vuot > 0) {
      exclusions.push({
        component: "SALARY_EMBEDDED_COMMISSION",
        label: "Phần nhóm “Lương” vượt quá lương cứng (nhiều khả năng là hoa hồng)",
        amount: vuot,
        confidence: "ESTIMATED",
        why: `Nhóm “Lương” ở bảng Chi phí cộng lại ${nhomLuong.toLocaleString("vi-VN")} ₫, nhiều hơn lương cứng đã khai ${luongCung.toLocaleString("vi-VN")} ₫. ERP không tách được hoa hồng khỏi lương cứng trong cùng một nhóm, nên phần vượt là ƯỚC TÍNH tốt nhất có được. GIỚI HẠN: nếu shop ghi lương cho người CHƯA khai trong sổ nhân sự thì phần vượt ấy là lương chứ không phải hoa hồng, và phép trừ này trừ nhầm — tách khoản hoa hồng sang nhóm riêng ở bảng Chi phí là cách làm nó thành số ĐO ĐƯỢC.`,
      });
    }
  }

  const loai = exclusions.reduce((t, e) => t + e.amount, 0);
  return {
    amount: costs.operatingTotal - loai,
    operatingTotal: costs.operatingTotal,
    count: costs.operatingCount,
    payrollCovered,
    exclusions,
    warnings: costs.warnings,
    logisticsAdjustment: costs.logisticsAdjustment,
  };
}

/**
 * LỢI NHUẬN KẾ TOÁN = CƠ SỞ − THÙ LAO BIẾN ĐỔI.
 *
 * Hàm THUẦN, và cố ý đứng ở tầng SAU bảng lương: nó nhận vào con số hoa hồng ĐÃ tính chứ không đi
 * tính. Đây chính là chỗ chiều phụ thuộc đảo lại một cách an toàn — vì tới lúc này cơ sở đã xong
 * và không còn ai hỏi lại nó.
 *
 *     nguồn → chi phí → CƠ SỞ → máy lương → thù lao biến đổi → KẾ TOÁN
 *
 * Mũi tên chỉ đi một chiều. Gọi ngược từ bất cứ ô nào bên trái là dựng lại đúng cái bẫy đã gỡ.
 */
export function accountingProfitAfterCompensation(preVariableProfit: number, variableCompensation: number | null): number | null {
  if (variableCompensation === null) return null;
  return preVariableProfit - variableCompensation;
}

export const COMPENSATION_BASIS_NOTE = `“${COMPENSATION_PROFIT_LABEL}” KHÔNG trừ thù lao biến đổi — đó là điều làm nó không phụ thuộc vào chính nó. Hoa hồng được trừ ở BƯỚC SAU để ra lợi nhuận kế toán.`;
