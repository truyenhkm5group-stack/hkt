/**
 * ───────────── PHÂN LOẠI MẪU MÃ: ĐÁNG NHÂN BẢN HAY ĐÁNG DỪNG ─────────────
 *
 * NGUYÊN TẮC CỨNG: "ĐÁNG NHÂN BẢN" phải đạt ĐỦ CẢ SÁU điều kiện. Thiếu dữ liệu ở bất kỳ chiều nào
 * thì KHÔNG phán — trả về "chưa đủ căn cứ" kèm tên chiều còn thiếu.
 *
 * Vì sao khắt khe như vậy: gắn nhãn "bán chạy" cho một mẫu mã dựa trên hai chiều rồi để chủ shop
 * đặt sản xuất hàng nghìn cái là cách gây thiệt hại lớn nhất mà một báo cáo có thể gây ra. Một mẫu
 * bán 100 cái, giao thành công 95%, doanh thu cao — mà lãi gộp âm vì tiền quảng cáo — vẫn là mẫu
 * phải dừng, và chỉ chiều thứ sáu mới nói ra điều đó.
 *
 * Ngược lại, "đáng lo" chỉ cần MỘT dấu hiệu đủ nặng: cảnh báo sai làm mất một cơ hội, còn bỏ sót
 * làm mất tiền thật.
 */

export type ProductVerdict = "WINNER" | "RISK" | "LOSER" | "NEUTRAL" | "INSUFFICIENT_DATA";

export const VERDICT_LABEL: Record<ProductVerdict, string> = {
  WINNER: "Đáng nhân bản",
  RISK: "Đáng lo",
  LOSER: "Đang lỗ · nên dừng",
  NEUTRAL: "Bình thường",
  INSUFFICIENT_DATA: "Chưa đủ căn cứ",
};

export const VERDICT_TONE: Record<ProductVerdict, string> = {
  WINNER: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  RISK: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  LOSER: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  NEUTRAL: "bg-muted text-muted-foreground",
  INSUFFICIENT_DATA: "bg-muted text-muted-foreground italic",
};

/**
 * Ngưỡng phân loại. MỘT CHỖ DUY NHẤT. Đây là ngưỡng phân tích, không phải ngưỡng nghiệp vụ về tiền
 * hay kết quả đơn — nó không đổi con số nào, chỉ đổi nhãn gợi ý. Chủ shop nên chỉnh sau vài kỳ.
 */
export const VERDICT_RULES = {
  /** Bán quá ít thì mọi tỷ lệ đều là nhiễu, không kết luận được gì. */
  minDeliveredQty: 10,
  /** Tỷ lệ giao thành công tối thiểu để gọi là tốt. */
  minSuccessRate: 70,
  /** Doanh thu giao thành công tối thiểu — mẫu bán tốt nhưng bé quá thì chưa đáng dồn vốn. */
  minDeliveredRevenue: 5_000_000,
  /** Biên lợi nhuận góp tối thiểu (%) trên doanh thu giao thành công. */
  minContributionMarginPct: 25,
  /** Tiền quảng cáo tối đa (%) trên doanh thu giao thành công của cùng mã hàng. */
  maxAdsCostPct: 30,
  /** Tồn đủ bán trong khoảng này là khoẻ: dưới là sắp cháy, trên là chôn vốn. */
  healthyCoverMinDays: 7,
  healthyCoverMaxDays: 90,

  // ── Dấu hiệu đáng lo: mỗi cái đứng một mình đã đủ ──
  /** Tỷ lệ hoàn từ mức này là đáng lo dù doanh thu có đẹp. */
  riskReturnRatePct: 40,
  /** Tỷ lệ giao thành công dưới mức này là hỏng, không phải dao động. */
  badSuccessRate: 50,
  /** Tồn đủ bán quá số ngày này = vốn đang nằm chết trong kho. */
  stuckCoverDays: 120,
} as const;

/** Một chiều đánh giá và kết quả của nó — để giao diện giải thích được vì sao. */
export type VerdictCheck = {
  key: "volume" | "success" | "revenue" | "margin" | "ads" | "stock";
  label: string;
  /** `null` = chưa đủ dữ liệu để xét chiều này. */
  passed: boolean | null;
  detail: string;
};

export type ProductVerdictResult = {
  verdict: ProductVerdict;
  checks: VerdictCheck[];
  /** Câu giải thích ngắn cho giao diện. */
  reason: string;
};

export type VerdictInput = {
  deliveredQty: number;
  successRate: number | null;
  returnRate: number | null;
  deliveredRevenue: number;
  /** `null` = chưa tra được giá vốn. */
  contribution: number | null;
  /** Tiền quảng cáo quy cho MÃ HÀNG của mẫu mã này; `null` = không ghép được chiến dịch nào. */
  adSpend: number | null;
  daysOfCover: number | null;
  available: number | null;
};

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * Phân loại một mẫu mã. Trả về cả sáu chiều để giao diện hiện được vì sao — nhãn mà người đọc không
 * kiểm chứng được thì không đáng tin hơn cảm tính.
 */
export function classifyProduct(input: VerdictInput): ProductVerdictResult {
  const r = VERDICT_RULES;
  const marginPct = input.contribution === null ? null : pct(input.contribution, input.deliveredRevenue);
  const adsPct = input.adSpend === null ? null : pct(input.adSpend, input.deliveredRevenue);

  const checks: VerdictCheck[] = [
    {
      key: "volume",
      label: "Sản lượng",
      passed: input.deliveredQty >= r.minDeliveredQty,
      detail: `${input.deliveredQty} món đã tới tay khách (cần ≥ ${r.minDeliveredQty} thì tỷ lệ mới hết là nhiễu)`,
    },
    {
      key: "success",
      label: "Tỷ lệ giao thành công",
      passed: input.successRate === null ? null : input.successRate >= r.minSuccessRate,
      detail: input.successRate === null ? "Chưa đơn nào kết thúc" : `${input.successRate}% (cần ≥ ${r.minSuccessRate}%)`,
    },
    {
      key: "revenue",
      label: "Doanh thu giao thành công",
      passed: input.deliveredRevenue >= r.minDeliveredRevenue,
      detail: `${Math.round(input.deliveredRevenue).toLocaleString("vi-VN")}đ (cần ≥ ${r.minDeliveredRevenue.toLocaleString("vi-VN")}đ)`,
    },
    {
      key: "margin",
      label: "Biên lợi nhuận góp",
      passed: marginPct === null ? null : marginPct >= r.minContributionMarginPct,
      detail: marginPct === null ? "Chưa tra được giá vốn" : `${marginPct.toFixed(1)}% (cần ≥ ${r.minContributionMarginPct}%)`,
    },
    {
      key: "ads",
      label: "Chi quảng cáo trên doanh thu",
      passed: adsPct === null ? null : adsPct <= r.maxAdsCostPct,
      detail: adsPct === null ? "Không ghép được chiến dịch nào với mã hàng này" : `${adsPct.toFixed(1)}% (cần ≤ ${r.maxAdsCostPct}%)`,
    },
    {
      key: "stock",
      label: "Sức khoẻ tồn kho",
      passed: input.daysOfCover === null ? null : input.daysOfCover >= r.healthyCoverMinDays && input.daysOfCover <= r.healthyCoverMaxDays,
      detail:
        input.daysOfCover === null
          ? input.available === null
            ? "Chưa có phiếu nhập nào"
            : "Chưa bán được cái nào nên chưa tính được số ngày còn hàng"
          : `Đủ bán ${input.daysOfCover} ngày (khoẻ: ${r.healthyCoverMinDays}–${r.healthyCoverMaxDays})`,
    },
  ];

  // ── ĐANG LỖ: lãi gộp âm là kết luận dứt khoát, không cần chiều nào khác ──
  if (input.contribution !== null && input.contribution < 0 && input.deliveredQty > 0) {
    return { verdict: "LOSER", checks, reason: "Lợi nhuận góp âm — bán càng nhiều càng lỗ." };
  }

  // ── ĐÁNG LO: một dấu hiệu đủ nặng là đủ. Cảnh báo sai mất một cơ hội; bỏ sót mất tiền thật ──
  const risks: string[] = [];
  if (input.returnRate !== null && input.returnRate >= r.riskReturnRatePct && input.deliveredQty + (input.returnRate > 0 ? 1 : 0) > 0) {
    risks.push(`tỷ lệ hoàn ${input.returnRate}%`);
  }
  if (input.successRate !== null && input.successRate < r.badSuccessRate) risks.push(`giao thành công chỉ ${input.successRate}%`);
  if (input.daysOfCover !== null && input.daysOfCover > r.stuckCoverDays) risks.push(`tồn đủ bán ${input.daysOfCover} ngày — vốn nằm chết`);
  if (marginPct !== null && marginPct < r.minContributionMarginPct / 2) risks.push(`biên lợi nhuận góp chỉ ${marginPct.toFixed(1)}%`);
  if (risks.length) return { verdict: "RISK", checks, reason: risks.join(" · ") };

  // ── ĐÁNG NHÂN BẢN: phải đủ CẢ SÁU. Thiếu dữ liệu chiều nào thì KHÔNG phán ──
  const unknown = checks.filter((c) => c.passed === null);
  const failed = checks.filter((c) => c.passed === false);
  if (!failed.length && !unknown.length) {
    return { verdict: "WINNER", checks, reason: "Đạt cả sáu điều kiện: sản lượng, giao thành công, doanh thu, biên lợi nhuận, chi quảng cáo và tồn kho." };
  }
  if (unknown.length && !failed.length) {
    return {
      verdict: "INSUFFICIENT_DATA",
      checks,
      reason: `Đủ điều kiện ở các chiều đo được, nhưng chưa xét được: ${unknown.map((c) => c.label.toLowerCase()).join(", ")}.`,
    };
  }
  return { verdict: "NEUTRAL", checks, reason: `Chưa đạt: ${failed.map((c) => c.label.toLowerCase()).join(", ")}.` };
}
