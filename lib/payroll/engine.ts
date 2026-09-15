/**
 * ═══════════ MÁY TÍNH LƯƠNG THEO THÀNH PHẦN — HÀM THUẦN, MỘT ĐƯỜNG DUY NHẤT ═══════════
 *
 * ─── ĐÂY LÀ NƠI DUY NHẤT MỘT CON SỐ LƯƠNG ĐƯỢC SINH RA ───
 *
 * Không màn hình nào, không tệp xuất nào, không API nào được tự nhân lại một tỷ lệ. Cùng luật với
 * `lib/metrics/scorecard.ts::evaluateMetric` (AGENTS.md mục 44) và `getOperatingCost()` (mục 18):
 * hai nơi cùng tính một khoản tiền là hai nơi sẽ nói hai con số khác nhau, và không ai biết nơi
 * nào đã dùng để trả tiền.
 *
 * ─── KHÔNG CÓ `if role === 'marketer'` Ở ĐÂY, VÀ KHÔNG BAO GIỜ ĐƯỢC CÓ ───
 *
 * Máy này không biết ai là MKTer, ai ở kho, ai làm từ xa. Nó chỉ biết: một danh sách THÀNH PHẦN,
 * một bộ ĐẦU VÀO, và một khoảng thời gian. Thêm một chức danh mới là khai một chính sách trên màn
 * hình — không sửa tệp này. Nếu có ngày ai đó định thêm một nhánh `if` theo phòng ban vào đây thì
 * đó là dấu hiệu chính sách khai chưa đủ, không phải dấu hiệu máy thiếu tính năng.
 *
 * ─── CHƯA BIẾT KHÔNG ĐƯỢC IN RA THÀNH 0 ───
 *
 * AGENTS.md mục 42 · mục 8.5. Một thành phần thiếu đại lượng (chưa chấm công, chưa chấm KPI, chưa
 * tính được lợi nhuận cá nhân) trả `amount: null` kèm một dòng `missing` nói ĐÚNG cái đang thiếu
 * và ai phải nhập. Tổng lương của người đó cũng là `null` — vì "tổng của một số đã biết và một số
 * chưa biết" là một số chưa biết, không phải số đã biết ấy. Chốt kỳ lúc đó bị chặn
 * (`payroll-readiness.ts`), đúng như nó phải thế.
 *
 * ─── VẾT GIẢI THÍCH ĐI CÙNG CON SỐ, KHÔNG PHẢI DỰNG LẠI SAU ───
 *
 * Mỗi thành phần trả kèm `explain`: từng bước, đọc được, theo đúng thứ tự máy đã làm. Dựng lại vết
 * ở tầng màn hình nghĩa là có hai phép tính — cái ra tiền và cái ra lời giải thích — và chúng sẽ
 * rời nhau đúng vào lúc ai đó cần đối chiếu nhất.
 */
import { prorateMonthlyAmount } from "@/lib/constants/cost-allocation";
import {
  applyRounding,
  componentBasisKey,
  payrollInput,
  PAYROLL_COMPONENT_SIGN,
  type PayrollComponentKind,
  type PolicyComponent,
} from "@/lib/constants/payroll-components";
import { carryoverMonth } from "@/lib/payroll/profit-carryover";
import { isWorkingSegment, type PayrollSegment } from "@/lib/payroll/policy-resolve";

/**
 * PHIÊN BẢN MÁY TÍNH. Đổi cách máy này biến (thành phần + đầu vào) thành tiền ⇒ TĂNG số này.
 *
 * Tách hẳn khỏi `PAYROLL_CALC_VERSION` (phiên bản của bảng lương cũ) và khỏi số phiên bản của từng
 * chính sách: đổi CHÍNH SÁCH là shop quyết trả khác đi; đổi MÁY là cùng chính sách ra số khác. Hai
 * chuyện khác nhau, và ảnh chụp mang cả hai để sáu tháng sau còn phân biệt được.
 */
export const PAYROLL_ENGINE_VERSION = 1;

/** Một bước trong lời giải thích. `value = null` = bước ấy chưa có số. */
export type ExplainStep = { label: string; value: number | null; unit?: string; note?: string };

/** Vì sao một con số là CHƯA BIẾT — đủ cụ thể để ai đó đi làm được việc còn thiếu. */
export type MissingInput = {
  componentCode: string;
  inputKey: string;
  label: string;
  /** `MANUAL` = chờ người nhập · `MEASURED` = ERP đo được nhưng kỳ này chưa có số. */
  availability: "MANUAL" | "MEASURED";
  message: string;
};

export type ComponentResult = {
  code: string;
  label: string;
  kind: PayrollComponentKind;
  /** `null` = CHƯA BIẾT. Dấu đã áp theo loại: khấu trừ / tạm ứng là số ÂM. */
  amount: number | null;
  /** Giá trị đại lượng đã dùng (`null` = không cần hoặc chưa biết). */
  basisKey: string | null;
  basisValue: number | null;
  explain: ExplainStep[];
  /** Có bị chạm trần / sàn không — hiện ra để chủ shop biết con số đã bị cắt. */
  cappedBy: "MIN" | "MAX" | null;
  /** Kết quả bù lỗ của thành phần này (`null` = thành phần không bật bù lỗ). */
  carry: {
    openingBalance: number;
    lossApplied: number;
    commissionBase: number;
    closingBalance: number;
  } | null;
};

/** Giá trị một đại lượng cho MỘT đoạn. `null` = chưa biết. */
export type BasisValues = Readonly<Record<string, number | null | undefined>>;

/** Khoản điều chỉnh tay cho một kỳ (thưởng nóng, tạm ứng, khấu trừ) — đã được người duyệt. */
export type AdjustmentInput = {
  id: string;
  kind: PayrollComponentKind;
  label: string;
  /** Số tiền DƯƠNG. Dấu do `kind` quyết định, không do người nhập gõ dấu trừ. */
  amount: number;
  reason: string;
};

export type SegmentInput = {
  segment: PayrollSegment;
  components: readonly PolicyComponent[];
  /** Đại lượng của RIÊNG đoạn này. */
  basis: BasisValues;
};

export type PayrollItemInput = {
  employeeId: string;
  employeeName: string;
  segments: readonly SegmentInput[];
  adjustments: readonly AdjustmentInput[];
  /**
   * Số dư lỗ mang sang đầu kỳ, theo `code` của thành phần bật bù lỗ. `null` = CHƯA XÁC LẬP ⇒ mọi
   * thành phần bù lỗ của người này là chưa biết. KHÔNG được coi là 0: "chưa biết còn lỗ bao nhiêu"
   * khác hẳn "đã xác minh là hết lỗ".
   */
  carryOpening: Readonly<Record<string, number | null | undefined>>;
};

export type PayrollItemResult = {
  employeeId: string;
  employeeName: string;
  components: ComponentResult[];
  adjustments: ComponentResult[];
  /** Tổng các khoản CỘNG. `null` khi còn thành phần chưa biết. */
  grossEarnings: number | null;
  /** Tổng các khoản TRỪ, số DƯƠNG. */
  totalDeductions: number | null;
  /** `grossEarnings − totalDeductions`. */
  netPay: number | null;
  missing: MissingInput[];
  /** Vấn đề về CẤU HÌNH (chưa gán chính sách, phiên bản chưa duyệt) — khác hẳn thiếu số liệu. */
  problems: string[];
  /** Đoạn nào áp chính sách nào — để màn hình nói được "01–14 chính sách A, 15–30 chính sách B". */
  segments: { from: Date; to: Date; days: number; policyCode: string; policyVersion: number | null; working: boolean }[];
};

const num = (v: number | null | undefined): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

/**
 * ═══ TÍNH MỘT THÀNH PHẦN TRÊN MỘT ĐOẠN ═══
 *
 * Thứ tự cố định, và thứ tự ấy là một phần của luật:
 *   1. lấy đại lượng (thiếu ⇒ dừng, trả CHƯA BIẾT);
 *   2. bù lỗ lũy kế nếu thành phần bật (đổi CƠ SỞ, không đổi khoản phải trả);
 *   3. phép tính theo `calc`;
 *   4. chia theo ngày của đoạn nếu `prorate = PERIOD_DAYS`;
 *   5. sàn / trần;
 *   6. làm tròn;
 *   7. áp dấu theo loại.
 *
 * Trần áp TRƯỚC làm tròn: làm tròn lên một khoản đã chạm trần sẽ vượt trần đúng bằng bước làm tròn,
 * và một cái trần vượt được không phải là trần.
 */
export function calculateComponent(
  component: PolicyComponent,
  ctx: { segment: PayrollSegment; basis: BasisValues; carryOpening: number | null },
): { result: ComponentResult; missing: MissingInput | null } {
  const explain: ExplainStep[] = [];
  const basisKey = componentBasisKey(component.calc);
  const spec = basisKey ? payrollInput(basisKey) : null;

  const fail = (inputKey: string, label: string, availability: "MANUAL" | "MEASURED", message: string) => ({
    result: {
      code: component.code,
      label: component.label,
      kind: component.kind,
      amount: null,
      basisKey,
      basisValue: null,
      explain,
      cappedBy: null,
      carry: null,
    } satisfies ComponentResult,
    missing: { componentCode: component.code, inputKey, label, availability, message } satisfies MissingInput,
  });

  // ─── 1. ĐẠI LƯỢNG ───
  let basisValue: number | null = null;
  if (basisKey) {
    if (!spec) {
      return fail(
        basisKey,
        basisKey,
        "MEASURED",
        `Thành phần “${component.label}” nối vào đại lượng “${basisKey}” không có trong sổ đăng ký đầu vào. Chính sách này khai bằng một phiên bản cũ hơn sổ — sửa lại thành phần rồi tính lại.`,
      );
    }
    basisValue = num(ctx.basis[basisKey]);
    if (basisValue === null) {
      return fail(
        basisKey,
        spec.label,
        spec.availability,
        spec.availability === "MANUAL"
          ? `Chưa có “${spec.label}” cho ${component.label}. ${spec.source}`
          : `ERP chưa tính được “${spec.label}” cho kỳ này nên “${component.label}” là CHƯA BIẾT, không phải 0. ${spec.source}`,
      );
    }
    explain.push({ label: spec.label, value: basisValue, unit: spec.unit });
  }

  // ─── 2. BÙ LỖ LŨY KẾ ───
  let carry: ComponentResult["carry"] = null;
  let effectiveBasis = basisValue;
  if (component.carryForward && basisValue !== null) {
    if (ctx.carryOpening === null) {
      return fail(
        basisKey ?? component.code,
        "Số dư lỗ đầu kỳ",
        "MANUAL",
        `Thành phần “${component.label}” bù lỗ lũy kế nhưng số dư lỗ đầu kỳ chưa xác lập. Chốt lúc này là tính hoa hồng trên một cơ sở chưa có căn cứ — khai số dư mở sổ hoặc chốt kỳ trước đã.`,
      );
    }
    const r = carryoverMonth({ openingBalance: ctx.carryOpening, realProfit: basisValue, commissionPercent: 0 });
    carry = {
      openingBalance: ctx.carryOpening,
      lossApplied: r.lossApplied ?? 0,
      commissionBase: r.commissionBase ?? 0,
      closingBalance: r.closingBalance ?? 0,
    };
    explain.push({ label: "Lỗ mang sang từ kỳ trước", value: ctx.carryOpening, unit: "VND" });
    explain.push({ label: "Cơ sở sau bù lỗ", value: carry.commissionBase, unit: "VND", note: "Không bao giờ âm — phần âm còn lại chuyển sang kỳ sau." });
    effectiveBasis = carry.commissionBase;
  }

  // ─── 3. PHÉP TÍNH ───
  let raw: number;
  switch (component.calc.type) {
    case "FIXED_AMOUNT": {
      raw = component.calc.amount;
      explain.push({ label: "Số tiền khai trong chính sách", value: raw, unit: "VND" });
      break;
    }
    case "PER_UNIT": {
      raw = (effectiveBasis ?? 0) * component.calc.unitRate;
      explain.push({ label: "Đơn giá", value: component.calc.unitRate, unit: "VND" });
      explain.push({ label: "Thành tiền", value: raw, unit: "VND" });
      break;
    }
    case "RATE_OF_BASIS": {
      /*
        CƠ SỞ ÂM KHÔNG SINH RA MỘT KHOẢN PHẢI TRẢ ÂM.

        Một tháng lỗ không được biến thành "người này nợ shop tiền hoa hồng" — đó là một phép trừ
        vào lương cứng mà không hợp đồng nào nói tới. Con số âm KHÔNG bị vứt: thành phần bật bù lỗ
        đã giữ nó ở `carry.closingBalance` để kỳ sau bù (mục 2 ở trên). Thành phần KHÔNG bật bù lỗ
        thì số âm đúng là bị bỏ — và đó là lựa chọn của chính sách, khai rõ ở ô "Bù lỗ lũy kế".
      */
      raw = Math.max(effectiveBasis ?? 0, 0) * (component.calc.ratePercent / 100);
      explain.push({ label: "Tỷ lệ", value: component.calc.ratePercent, unit: "PERCENT" });
      explain.push({ label: "Thành tiền", value: raw, unit: "VND" });
      break;
    }
    case "TIERED_RATE": {
      const base = Math.max(effectiveBasis ?? 0, 0);
      raw = 0;
      const tiers = [...component.calc.tiers].sort((a, b) => a.from - b.from);
      for (let i = 0; i < tiers.length; i += 1) {
        const tier = tiers[i];
        const next = tiers[i + 1];
        if (base <= tier.from) break;
        /*
          BẬC ÁP CHO PHẦN VƯỢT, KHÔNG PHẢI CHO TOÀN BỘ.

          Bậc "từ 100 triệu trở lên 10%" mà áp 10% cho cả 100 triệu đầu thì vượt ngưỡng một đồng
          làm tiền thưởng nhảy một bậc — và người ta sẽ giữ đơn lại để rơi vào đúng bên có lợi.
        */
        const upper = next ? Math.min(base, next.from) : base;
        const slice = upper - tier.from;
        if (slice <= 0) continue;
        const part = slice * (tier.ratePercent / 100);
        raw += part;
        explain.push({
          label: `Bậc từ ${tier.from.toLocaleString("vi-VN")} · ${tier.ratePercent}%`,
          value: part,
          unit: "VND",
          note: `Phần thuộc bậc: ${slice.toLocaleString("vi-VN")}`,
        });
      }
      explain.push({ label: "Thành tiền", value: raw, unit: "VND" });
      break;
    }
    case "THRESHOLD_BONUS": {
      const reached = (effectiveBasis ?? 0) >= component.calc.threshold;
      raw = reached ? component.calc.amount : 0;
      explain.push({ label: "Ngưỡng phải đạt", value: component.calc.threshold });
      explain.push({ label: reached ? "Đã đạt ngưỡng" : "Chưa đạt ngưỡng", value: raw, unit: "VND" });
      break;
    }
  }

  // ─── 4. CHIA THEO NGÀY CỦA ĐOẠN ───
  if (component.prorate === "PERIOD_DAYS") {
    /*
      DÙNG ĐÚNG HÀM MÀ CHI PHÍ NHÂN SỰ DÙNG (`prorateMonthlyAmount`).

      Nó chia theo SỐ NGÀY THẬT của từng tháng chồng lấn, nên cộng đủ một tháng luôn ra đúng khoản
      tháng — không dư không thiếu vì làm tròn. Tự viết một phép `× ngày / 30` ở đây là mở đường
      cho bảng lương và báo cáo lợi nhuận nói hai con số khác nhau về cùng một khoản lương, đúng
      cái lỗi đã sửa ngày 14/09/2026.
    */
    const prorated = prorateMonthlyAmount(raw, ctx.segment.from, ctx.segment.to);
    explain.push({
      label: "Chia theo số ngày của đoạn",
      value: prorated,
      unit: "VND",
      note: `${ctx.segment.days} ngày`,
    });
    raw = prorated;
  }

  // ─── 5. SÀN / TRẦN ───
  let cappedBy: ComponentResult["cappedBy"] = null;
  if (component.maxAmount !== null && raw > component.maxAmount) {
    explain.push({ label: "Chạm trần của chính sách", value: component.maxAmount, unit: "VND", note: `Trước trần: ${Math.round(raw).toLocaleString("vi-VN")}` });
    raw = component.maxAmount;
    cappedBy = "MAX";
  }
  if (component.minAmount !== null && raw < component.minAmount) {
    explain.push({ label: "Nâng lên sàn của chính sách", value: component.minAmount, unit: "VND", note: `Trước sàn: ${Math.round(raw).toLocaleString("vi-VN")}` });
    raw = component.minAmount;
    cappedBy = "MIN";
  }

  // ─── 6 & 7. LÀM TRÒN VÀ ÁP DẤU ───
  const rounded = applyRounding(raw, component.rounding);
  /*
    `+ 0` KHÔNG THỪA — cùng lý do với `totalDeductions` ở cuối tệp.

    Một khoản KHẤU TRỪ tính ra đúng 0 cho `0 × -1 = -0`. Nó bằng 0 với `===`, nhưng
    `JSON.stringify` viết `-0` vào ảnh chụp và `Intl` in "-0" — một dòng khấu trừ âm không tồn
    tại, đứng cạnh tên một người thật.
  */
  const amount = rounded * PAYROLL_COMPONENT_SIGN[component.kind] + 0;
  if (rounded !== raw) explain.push({ label: "Sau làm tròn", value: rounded, unit: "VND" });

  return {
    result: { code: component.code, label: component.label, kind: component.kind, amount, basisKey, basisValue, explain, cappedBy, carry },
    missing: null,
  };
}

/**
 * ═══ TÍNH LƯƠNG MỘT NGƯỜI CHO CẢ KỲ ═══
 *
 * Tiền của kỳ = tổng tiền của các ĐOẠN. Một thành phần cùng `code` xuất hiện ở hai đoạn (đổi phiên
 * bản chính sách giữa kỳ) được GỘP thành một dòng trên phiếu lương, nhưng vết giải thích giữ cả
 * hai — người đọc phải thấy được "14 ngày đầu tính theo bản 1, phần còn lại theo bản 2".
 */
export function calculatePayrollItem(input: PayrollItemInput): PayrollItemResult {
  const byCode = new Map<string, ComponentResult>();
  const missing: MissingInput[] = [];
  const problems: string[] = [];

  /*
    ═══ SỐ DƯ LỖ CHẠY QUA CÁC ĐOẠN, KHÔNG ĐƯỢC ÁP LẠI TỪ ĐẦU Ở TỪNG ĐOẠN ═══

    Lỗ mang sang là MỘT nghĩa vụ của cả kỳ, không phải một nghĩa vụ cho mỗi đoạn. Đưa cùng một số
    dư đầu kỳ vào từng đoạn là bù nó NHIỀU LẦN, và cách hỏng rất kín: người bị trừ đúng bằng phần
    hoa hồng đáng lẽ được nhận, còn số dư chuyển sang kỳ sau thì vẫn âm — nên tháng sau bù tiếp
    một lần nữa.

    Đo được bằng số: lỗ đầu kỳ −10.000.000, lợi nhuận cả kỳ 16.000.000, tỷ lệ 10%.
      · một đoạn  → cơ sở 6.000.000 → hoa hồng 600.000, chuyển tiếp 0
      · hai đoạn (đổi phiên bản chính sách giữa kỳ), mỗi đoạn 8.000.000, nếu áp lại từ đầu
                  → cơ sở 0 + 0    → hoa hồng 0,       chuyển tiếp −2.000.000
    Cùng một người, cùng một tháng, cùng một con số lợi nhuận — chênh 600.000đ chỉ vì chủ shop đổi
    phiên bản chính sách giữa tháng.

    Nên số dư đi theo THỨ TỰ THỜI GIAN: đoạn sau nhận số dư CÒN LẠI của đoạn trước. Cách này giữ
    được tỷ lệ riêng của từng đoạn (đổi phiên bản là đổi tỷ lệ), mà tổng vẫn đúng bằng con số của
    một kỳ không bị cắt.
  */
  const carryRunning = new Map<string, number | null>();
  for (const [code, v] of Object.entries(input.carryOpening)) carryRunning.set(code, num(v));

  for (const seg of input.segments) {
    if (!isWorkingSegment(seg.segment)) continue;
    if (!seg.segment.policyVersionId) {
      /*
        KHÔNG CÓ CHÍNH SÁCH THÌ NÓI RA, KHÔNG TÍNH 0 (yêu cầu mục 29.30).

        Trả về 0 đồng cho một người chưa gán chính sách là câu trả lời sai nguy hiểm nhất ở đây: nó
        trông y hệt "người này kỳ này không có gì để nhận", nên không ai đi tìm nguyên nhân cho tới
        khi người ấy hỏi vì sao chưa nhận lương.
      */
      problems.push(
        seg.segment.policyId
          ? `Đoạn ${seg.segment.from.toLocaleDateString("vi-VN")} – ${seg.segment.to.toLocaleDateString("vi-VN")}: chính sách “${seg.segment.policyName}” chưa có phiên bản nào ĐANG HIỆU LỰC (bản nháp không dùng để trả tiền).`
          : `Đoạn ${seg.segment.from.toLocaleDateString("vi-VN")} – ${seg.segment.to.toLocaleDateString("vi-VN")}: chưa gán chính sách lương nào.`,
      );
      continue;
    }
    for (const component of seg.components) {
      const { result, missing: miss } = calculateComponent(component, {
        segment: seg.segment,
        basis: seg.basis,
        carryOpening: component.carryForward ? (carryRunning.get(component.code) ?? null) : null,
      });
      if (miss) missing.push(miss);
      // Đoạn sau đứng trên phần lỗ CÒN LẠI. Đoạn không tính được (thiếu đại lượng) không làm đổi
      // số dư — chưa biết lợi nhuận thì chưa bù được đồng nào.
      if (result.carry) carryRunning.set(component.code, result.carry.closingBalance);
      const prev = byCode.get(component.code);
      if (!prev) {
        byCode.set(component.code, { ...result, explain: [...result.explain] });
        continue;
      }
      /*
        GỘP HAI ĐOẠN: CHƯA BIẾT NUỐT ĐÃ BIẾT.

        Nửa tháng tính được 3 triệu và nửa còn lại chưa chấm công thì khoản của cả tháng là CHƯA
        BIẾT, không phải 3 triệu. In ra 3 triệu là khẳng định nửa tháng kia bằng 0.
      */
      prev.amount = prev.amount === null || result.amount === null ? null : prev.amount + result.amount;
      prev.basisValue = prev.basisValue === null || result.basisValue === null ? null : prev.basisValue + result.basisValue;
      prev.explain.push({ label: `— đoạn ${result.code} tiếp theo —`, value: null });
      prev.explain.push(...result.explain);
      if (result.cappedBy) prev.cappedBy = result.cappedBy;
      /*
        GỘP SỔ LỖ CỦA HAI ĐOẠN: ĐẦU của đoạn ĐẦU, CUỐI của đoạn CUỐI, phần giữa CỘNG lại.

        Lấy nguyên khối `carry` của đoạn cuối (như bản trước) là in ra một số dư đầu kỳ KHÔNG PHẢI
        số dư đầu kỳ — nó là số dư giữa kỳ — và người đọc không có cách nào biết.
      */
      if (result.carry) {
        prev.carry = prev.carry
          ? {
              openingBalance: prev.carry.openingBalance,
              lossApplied: prev.carry.lossApplied + result.carry.lossApplied,
              commissionBase: prev.carry.commissionBase + result.carry.commissionBase,
              closingBalance: result.carry.closingBalance,
            }
          : result.carry;
      }
    }
  }

  const components = [...byCode.values()];
  const adjustments: ComponentResult[] = input.adjustments.map((a) => {
    const sign = PAYROLL_COMPONENT_SIGN[a.kind];
    const amount = Math.round(Math.abs(a.amount)) * sign + 0;
    return {
      code: `ADJ:${a.id}`,
      label: a.label,
      kind: a.kind,
      amount,
      basisKey: null,
      basisValue: null,
      explain: [
        { label: "Khoản điều chỉnh đã duyệt", value: amount, unit: "VND" },
        { label: "Lý do", value: null, note: a.reason },
      ],
      cappedBy: null,
      carry: null,
    };
  });

  const all = [...components, ...adjustments];
  const unknown = all.some((c) => c.amount === null);
  const sum = (pick: (v: number) => boolean) =>
    unknown ? null : all.reduce((t, c) => t + ((c.amount !== null && pick(c.amount)) ? c.amount : 0), 0);
  const grossEarnings = sum((v) => v > 0);
  const deductionsSigned = sum((v) => v < 0);
  /*
    `+ 0` KHÔNG THỪA: `-0` LÀ MỘT GIÁ TRỊ KHÁC.

    Không có khoản trừ nào thì `deductionsSigned` là `0`, và `-0` lọt ra ngoài. Nó bằng `0` với
    `===` nhưng KHÁC với `Object.is`, in ra JSON thành `-0`, và hiện lên màn hình thành "-0 ₫" —
    một dòng khấu trừ âm không tồn tại, đứng cạnh tên một người thật.
  */
  const totalDeductions = deductionsSigned === null ? null : -deductionsSigned + 0;
  const netPay = grossEarnings === null || totalDeductions === null ? null : grossEarnings - totalDeductions;

  return {
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    components,
    adjustments,
    grossEarnings,
    totalDeductions,
    netPay,
    missing,
    problems,
    segments: input.segments.map((s) => ({
      from: s.segment.from,
      to: s.segment.to,
      days: s.segment.days,
      policyCode: s.segment.policyCode,
      policyVersion: s.segment.policyVersion,
      working: isWorkingSegment(s.segment),
    })),
  };
}
