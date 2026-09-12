import { SLOW_MOVING_RULES } from "@/lib/constants/slow-moving";
import { VERDICT_RULES } from "@/lib/constants/product-verdict";
import { RECOMMENDATION_CONFIDENCE, type RecommendationConfidence } from "@/lib/constants/recommendation";

/**
 * ───────────── BỘ MÁY QUYẾT ĐỊNH VỐN TỒN KHO ─────────────
 *
 * Trả lời câu hỏi mà từng bảng riêng lẻ không trả lời được: với TỪNG mẫu mã, nên làm gì với
 * TIỀN — đặt thêm (cần bao nhiêu vốn), giữ nguyên, hay xả để giải phóng vốn?
 *
 * KHÔNG có công thức đo lường mới ở đây. Tốc độ bán, tồn khả dụng, số lượng nên đặt lấy nguyên
 * từ `lib/constants/planning.ts` (computePlan / computeVelocity); ngưỡng hàng chậm lấy từ
 * `lib/constants/slow-moving.ts`; ngưỡng tỷ lệ hoàn đáng lo lấy từ `product-verdict.ts`.
 * File này chỉ GHÉP các con số đã có thành MỘT kết luận cho mỗi mẫu mã, kèm lý do và mức tin cậy.
 *
 * RANH GIỚI CỨNG (cùng luật với `lib/constants/recommendation.ts`):
 *  · CHỈ ĐỀ XUẤT. Không tự tạo đơn sản xuất, không tự sửa tồn kho, không ghi gì cả.
 *  · CHƯA BIẾT là CHƯA BIẾT: thiếu giá vốn thì tiền vốn là `null` và hiện "chưa có giá nhập",
 *    không phải 0đ. Chưa có phiếu nhập thì không kết luận gì.
 *  · Số ước tính phải mang nhãn ước tính (`grossImpactEstimate` LUÔN là ước tính).
 */

export type InventoryDecisionKind =
  | "STOCKOUT_RISK"
  | "REORDER"
  | "OVERSTOCK"
  | "CLEARANCE_CANDIDATE"
  | "HOLD"
  | "DATA_INSUFFICIENT";

export const DECISION_LABEL: Record<InventoryDecisionKind, string> = {
  STOCKOUT_RISK: "Nguy cơ hết hàng",
  REORDER: "Nên đặt thêm",
  OVERSTOCK: "Đang chôn vốn",
  CLEARANCE_CANDIDATE: "Nên xả / dừng",
  HOLD: "Giữ nguyên",
  DATA_INSUFFICIENT: "Chưa đủ dữ liệu",
};

export const DECISION_TONE: Record<InventoryDecisionKind, string> = {
  STOCKOUT_RISK: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  REORDER: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  OVERSTOCK: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  CLEARANCE_CANDIDATE: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  HOLD: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DATA_INSUFFICIENT: "bg-muted text-muted-foreground italic",
};

/** Việc chủ shop nên làm với mỗi kết luận — nhãn không kèm hành động thì không phải quyết định. */
export const DECISION_ACTION: Record<InventoryDecisionKind, string> = {
  STOCKOUT_RISK: "Đặt sản xuất NGAY — đợi thêm là mất doanh thu từng ngày.",
  REORDER: "Đặt trong đợt chốt gần nhất; còn dư địa nhưng không nhiều.",
  OVERSTOCK: "Ngừng đặt thêm; đẩy bán để rút bớt vốn đang nằm trong kho.",
  CLEARANCE_CANDIDATE: "Xả theo giá vốn hoặc gộp combo; cân nhắc dừng hẳn mẫu này.",
  HOLD: "Không cần làm gì trong kỳ này.",
  DATA_INSUFFICIENT: "Bổ sung dữ liệu (phiếu nhập / kiểm kê / giá nhập) trước khi quyết định.",
};

/** Thứ tự ưu tiên hiển thị: việc mất tiền ngay đứng trước việc tiền nằm chờ. */
export const DECISION_RANK: Record<InventoryDecisionKind, number> = {
  STOCKOUT_RISK: 0,
  REORDER: 1,
  OVERSTOCK: 2,
  CLEARANCE_CANDIDATE: 3,
  DATA_INSUFFICIENT: 4,
  HOLD: 5,
};

/**
 * Ngưỡng RIÊNG của bộ máy quyết định — chỉ những gì chưa có chỗ nào khai.
 * Ngưỡng hàng chậm / hàng chết dùng thẳng `SLOW_MOVING_RULES`; tỷ lệ hoàn đáng lo dùng
 * `VERDICT_RULES.riskReturnRatePct`. Không chép lại số ở đây.
 */
export const DECISION_RULE = {
  /**
   * Mẫu mã có phiếu nhập đầu tiên chưa quá ngần này ngày = MẪU MỚI: chưa bán được cái nào cũng
   * chưa nói lên điều gì — không được kết luận "hàng chết" hay "chôn vốn" trên 5 ngày lịch sử.
   */
  minHistoryDays: 14,
  /**
   * CỔNG DỮ LIỆU CỦA CẢ TRANG (ngưỡng quan sát, không phải ngưỡng nghiệp vụ): dưới mức này trang tự
   * xưng "DỮ LIỆU CHƯA ĐỦ" và không được dùng làm căn cứ đặt hàng. Đối chiếu production 12/09/2026:
   * 30/41 mẫu có phiếu nhập nhưng 0/41 có sổ kho đủ 14 ngày ⇒ trang ra mắt ở trạng thái này.
   */
  gate: { minStockKnownPct: 80, minCostKnownPct: 80, minHistoryKnownPct: 50 },
  /**
   * Bán 30 ngày dưới ngần này món thì tốc độ bán là DẤU HIỆU chứ chưa phải bằng chứng —
   * mọi kết luận dựa trên tốc độ bị hạ tin cậy.
   */
  minSold30ForTrust: 5,
  /** Đơn đã kết thúc tối thiểu để tin tỷ lệ hoàn của RIÊNG mẫu mã (trùng với kế hoạch SX). */
  minReturnSample: 20,
} as const;

export type DecisionInput = {
  /** false = chưa có phiếu nhập nào ⇒ tồn CHƯA BIẾT ⇒ không kết luận. */
  stockKnown: boolean;
  /** Tồn thực tế theo sổ kho. */
  stock: number;
  /** Tồn khả dụng = tồn thực tế − đã chốt đơn chưa xuất. */
  available: number;
  /** Hàng ước quay lại kho (hoàn chờ nhận + phần hàng đang đi ước bị hoàn) — số của kế hoạch SX. */
  incomingFromReturns: number;
  /** Đã đặt xưởng (đơn sản xuất SENT) chưa nhận — cam kết vốn đã ký, KHÔNG phải hàng trong kho. */
  openPoQty: number;
  /** Tốc độ bán món/ngày đã chống nhiễu (computeVelocity). */
  velocity: number;
  /** Tốc độ bán đã bị cắt một ngày đột biến (livestream…). */
  velocityTrimmed: boolean;
  soldInWindow: number;
  sold30: number;
  /** Khả dụng ÷ tốc độ; `null` khi không bán được cái nào. */
  daysOfCover: number | null;
  /** `null` = KHÔNG biết thời gian sản xuất — không được bịa hạn đặt. */
  leadTimeDays: number | null;
  /** Thời gian SX là số khai riêng cho mã hàng hay giả định chung của trang cấu hình. */
  leadTimeSource: "override" | "default" | null;
  safetyDays: number;
  /** Số lượng nên đặt theo computePlan (đã trừ tồn + hàng sắp về, đã áp MOQ). */
  suggested: number;
  /** Giá nhập gần nhất; `null` = CHƯA BIẾT giá vốn (không phải 0đ). */
  unitCost: number | null;
  /** Giá bán niêm yết; `null` = chưa khai. */
  retailPrice: number | null;
  /** Tỷ lệ hoàn hiệu lực 0–1 (của riêng mẫu khi đủ mẫu, không thì của toàn shop). */
  returnRate: number | null;
  /** Tỷ lệ hoàn lấy từ đâu — để nói ra trong phần tin cậy. */
  returnRateSource: "variant" | "shop" | null;
  /** Ngày từ lần cuối GIAO THÀNH CÔNG; `null` = chưa bán được lần nào. */
  daysSinceLastSale: number | null;
  /** Tuổi của mẫu mã tính từ phiếu nhập đầu tiên; `null` = không xác định được. */
  ageDays: number | null;
};

export type InventoryDecisionResult = {
  decision: InventoryDecisionKind;
  /** Vì sao ra kết luận này — câu tiếng Việt đọc được, không phải mã. */
  reason: string;
  /** Khoảng trống dữ liệu / cảnh báo đi kèm — chính là căn cứ hạ mức tin cậy. */
  notes: string[];
  confidence: RecommendationConfidence;
  /** Số nên đặt SAU khi trừ hàng đã đặt xưởng; `null` = không tính được. */
  suggestedQty: number | null;
  /** Vốn cần bỏ ra cho đề xuất đặt; `null` = CHƯA BIẾT giá vốn. */
  capitalRequired: number | null;
  /** Số món vượt mức tồn lành mạnh (chỉ với OVERSTOCK / CLEARANCE). */
  excessQty: number;
  /** Vốn (theo GIÁ NHẬP) có thể giải phóng nếu xả phần vượt mức; `null` = chưa biết giá vốn. */
  capitalFreeable: number | null;
  /**
   * ƯỚC TÍNH lãi gộp mất nếu để hết hàng (STOCKOUT_RISK): tốc độ × số ngày trống hàng ×
   * (giá bán − giá vốn) × tỷ lệ giao thành công. LUÔN là ước tính; `null` khi thiếu giá.
   */
  grossImpactEstimate: number | null;
};

const vnd = (v: number) => `${Math.round(v).toLocaleString("vi-VN")}đ`;

function confidenceFrom(notes: string[], critical: boolean): RecommendationConfidence {
  if (critical) return RECOMMENDATION_CONFIDENCE.LOW;
  if (notes.length === 0) return RECOMMENDATION_CONFIDENCE.HIGH;
  if (notes.length <= 2) return RECOMMENDATION_CONFIDENCE.MEDIUM;
  return RECOMMENDATION_CONFIDENCE.LOW;
}

/**
 * Kết luận cho MỘT mẫu mã. Hàm thuần — cùng đầu vào luôn cho cùng đầu ra, kiểm thử được từng
 * trường hợp biên mà không cần CSDL.
 *
 * Thứ tự xét (mỗi bước chặn một kiểu sai):
 *  1. Chưa biết tồn ⇒ DATA_INSUFFICIENT — đề xuất trên dữ liệu bịa còn tệ hơn không đề xuất.
 *  2. Tồn âm mà không bán ⇒ DATA_INSUFFICIENT (sổ kho lệch, phải kiểm kê chứ không phải đặt hàng).
 *  3. Hết / sắp hết trước khi lô mới về ⇒ STOCKOUT_RISK (trừ hàng đã đặt xưởng trước khi kêu đặt thêm).
 *  4. Còn thiếu sau khi trừ mọi nguồn cung ⇒ REORDER.
 *  5. Không bán được: mẫu mới thì CHỜ, đủ lâu thì CLEARANCE_CANDIDATE.
 *  6. Tồn vượt xa nhịp bán ⇒ OVERSTOCK. Còn lại ⇒ HOLD.
 */
export function decideInventory(i: DecisionInput): InventoryDecisionResult {
  const notes: string[] = [];
  const base: Omit<InventoryDecisionResult, "decision" | "reason" | "confidence"> = {
    notes,
    suggestedQty: null,
    capitalRequired: null,
    excessQty: 0,
    capitalFreeable: null,
    grossImpactEstimate: null,
  };

  // ── 1. Tồn CHƯA BIẾT thì mọi phép tính phía sau đều là bịa ──
  if (!i.stockKnown) {
    return {
      ...base,
      decision: "DATA_INSUFFICIENT",
      reason: "Chưa có phiếu nhập nào trong ERP — tồn kho CHƯA BIẾT, không kết luận được gì.",
      confidence: RECOMMENDATION_CONFIDENCE.LOW,
    };
  }

  // Ghi nhận khoảng trống dữ liệu dùng chung cho mọi nhánh.
  if (i.unitCost === null) notes.push("chưa có giá nhập — tiền vốn không tính được");
  if (i.velocityTrimmed) notes.push("tốc độ bán đã bỏ một ngày đột biến (livestream) — nhu cầu thường ngày thấp hơn nhiều");
  if (i.leadTimeSource === "default") notes.push("thời gian sản xuất là giả định chung, chưa khai riêng cho mã này");
  if (i.leadTimeDays === null) notes.push("CHƯA BIẾT thời gian sản xuất — không tính được hạn đặt");
  if (i.returnRateSource === "shop") notes.push("tỷ lệ hoàn dùng số toàn shop (mẫu riêng chưa đủ đơn kết thúc)");
  if (i.velocity > 0 && i.sold30 < DECISION_RULE.minSold30ForTrust)
    notes.push(`mới bán ${i.sold30} món trong 30 ngày — tốc độ là dấu hiệu, chưa phải bằng chứng`);
  const highReturn = i.returnRate !== null && i.returnRateSource === "variant" && i.returnRate * 100 >= VERDICT_RULES.riskReturnRatePct;
  if (highReturn) notes.push(`tỷ lệ hoàn của riêng mẫu này ${Math.round((i.returnRate as number) * 100)}% — đặt thêm là đổ vốn vào hàng sẽ quay về`);

  // ── 2. Tồn âm = sổ kho lệch. Bán vẫn chạy thì vẫn phải báo hết hàng, nhưng nói rõ số liệu lệch ──
  if (i.available < 0 && i.velocity <= 0) {
    notes.push("tồn âm — phiếu kho lệch với hàng đã xuất, cần kiểm kê");
    return {
      ...base,
      decision: "DATA_INSUFFICIENT",
      reason: `Tồn khả dụng ${i.available} (ÂM) mà không có nhịp bán — sổ kho đang lệch, kiểm kê trước khi quyết định.`,
      confidence: RECOMMENDATION_CONFIDENCE.LOW,
    };
  }

  // Số nên đặt SAU khi trừ hàng đã đặt xưởng: computePlan đã trừ hàng sắp quay về kho
  // (`incomingFromReturns`) nhưng không biết đơn sản xuất đang mở,
  // nên nếu không trừ thì mẫu đã đặt 500 cái vẫn bị kêu đặt thêm 500 cái nữa.
  const suggestedNet = Math.max(0, Math.round(i.suggested - Math.max(0, i.openPoQty)));
  const capitalOf = (qty: number) => (i.unitCost === null ? null : Math.round(qty * i.unitCost));

  if (i.velocity > 0) {
    const outNow = i.available <= 0;
    const coverShort = !outNow && i.daysOfCover !== null && i.leadTimeDays !== null && i.daysOfCover < i.leadTimeDays;

    if (outNow || coverShort) {
      if (i.available < 0) notes.push("tồn âm — phiếu kho lệch với hàng đã xuất, cần kiểm kê song song");
      // Ước lãi gộp đang/ sẽ mất: chỉ tính khi BIẾT cả giá bán lẫn giá vốn; luôn là ước tính.
      let grossImpactEstimate: number | null = null;
      if (i.unitCost !== null && i.retailPrice !== null && i.retailPrice > i.unitCost) {
        const gapDays = outNow ? (i.leadTimeDays ?? 0) : Math.max(0, (i.leadTimeDays as number) - (i.daysOfCover as number));
        const successShare = 1 - Math.min(1, Math.max(0, i.returnRate ?? 0));
        if (gapDays > 0) grossImpactEstimate = Math.round(i.velocity * gapDays * (i.retailPrice - i.unitCost) * successShare);
      }
      const poNote = i.openPoQty > 0 ? ` Đã đặt xưởng ${i.openPoQty} cái (chưa về) — đề xuất dưới đây đã trừ.` : "";
      const reason = outNow
        ? `Khả dụng ${i.available} ≤ 0 trong khi vẫn bán ${round1(i.velocity)} món/ngày — đang mất doanh thu ngay bây giờ.${poNote}`
        : `Còn bán được ~${Math.floor(i.daysOfCover as number)} ngày, ít hơn thời gian sản xuất ${i.leadTimeDays} ngày — đặt hôm nay vẫn trống hàng một quãng.${poNote}`;
      return {
        ...base,
        decision: "STOCKOUT_RISK",
        reason,
        suggestedQty: suggestedNet,
        capitalRequired: suggestedNet > 0 ? capitalOf(suggestedNet) : 0,
        grossImpactEstimate,
        confidence: confidenceFrom(notes, i.available < 0),
      };
    }

    if (suggestedNet > 0) {
      const poNote = i.openPoQty > 0 ? ` (đã trừ ${i.openPoQty} cái đang đặt xưởng)` : "";
      return {
        ...base,
        decision: "REORDER",
        reason: `Còn bán được ~${i.daysOfCover === null ? "?" : Math.floor(i.daysOfCover)} ngày; theo nhịp bán ${round1(i.velocity)} món/ngày cần đặt thêm ${suggestedNet} cái${poNote} để đủ bán sau khi lô mới về.`,
        suggestedQty: suggestedNet,
        capitalRequired: capitalOf(suggestedNet),
        confidence: confidenceFrom(notes, false),
      };
    }

    // Đủ hàng theo kế hoạch — xét chiều ngược lại: có đang GIỮ QUÁ NHIỀU vốn không?
    if (i.daysOfCover !== null && i.daysOfCover > SLOW_MOVING_RULES.excessCoverDays) {
      const healthyQty = Math.ceil(i.velocity * SLOW_MOVING_RULES.healthyCoverDays);
      const excessQty = Math.max(0, i.available - healthyQty);
      return {
        ...base,
        decision: "OVERSTOCK",
        reason: `Tồn đủ bán ${Math.floor(i.daysOfCover)} ngày theo nhịp hiện tại — vượt xa ngưỡng ${SLOW_MOVING_RULES.excessCoverDays} ngày; ${excessQty} cái nhiều hơn mức đủ bán ${SLOW_MOVING_RULES.healthyCoverDays} ngày.`,
        excessQty,
        capitalFreeable: capitalOf(excessQty),
        confidence: confidenceFrom(notes, false),
      };
    }

    const slowNote = i.daysOfCover !== null && i.daysOfCover > SLOW_MOVING_RULES.slowCoverDays ? " Bán chậm hơn mức lành mạnh — KHÔNG đặt thêm cho tới khi nhịp bán tăng lại." : "";
    const poHold = i.openPoQty > 0 && i.suggested > 0 ? ` Nhu cầu ${i.suggested} cái đã được phủ bởi ${i.openPoQty} cái đang đặt xưởng.` : "";
    return {
      ...base,
      decision: "HOLD",
      reason: `Còn bán được ~${i.daysOfCover === null ? "?" : Math.floor(i.daysOfCover)} ngày với nhịp ${round1(i.velocity)} món/ngày — trong vùng an toàn.${poHold}${slowNote}`,
      suggestedQty: 0,
      capitalRequired: 0,
      confidence: confidenceFrom(notes, false),
    };
  }

  // ── velocity = 0: không bán được cái nào trong cửa sổ ──
  if (i.available <= 0) {
    return {
      ...base,
      decision: "HOLD",
      reason: "Không còn tồn và không có nhịp bán — không có gì để quyết định.",
      suggestedQty: 0,
      capitalRequired: 0,
      confidence: confidenceFrom(notes, false),
    };
  }

  // Mẫu MỚI: chưa đủ lịch sử thì "chưa bán được" không phải bằng chứng — không kết tội hàng chết.
  if (i.ageDays !== null && i.ageDays < DECISION_RULE.minHistoryDays) {
    notes.push(`mẫu mới ${i.ageDays} ngày tuổi — chưa đủ lịch sử để kết luận`);
    return {
      ...base,
      decision: "HOLD",
      reason: `Mẫu mới nhập ${i.ageDays} ngày, chưa có lịch sử bán — theo dõi thêm, chưa kết luận.`,
      suggestedQty: 0,
      capitalRequired: 0,
      confidence: RECOMMENDATION_CONFIDENCE.LOW,
    };
  }

  const idleDays = i.daysSinceLastSale ?? i.ageDays;
  if (idleDays !== null && idleDays >= SLOW_MOVING_RULES.deadDays) {
    const freeable = capitalOf(i.available);
    return {
      ...base,
      decision: "CLEARANCE_CANDIDATE",
      reason:
        i.daysSinceLastSale === null
          ? `Nhập từ ${idleDays} ngày trước mà chưa bán được cái nào — toàn bộ ${i.available} cái là vốn nằm chết.`
          : `${idleDays} ngày không bán được cái nào (ngưỡng hàng chết ${SLOW_MOVING_RULES.deadDays} ngày) — còn ${i.available} cái trong kho.`,
      excessQty: i.available,
      capitalFreeable: freeable,
      confidence: confidenceFrom(notes, false),
    };
  }

  notes.push("không bán trong cửa sổ gần đây nhưng chưa tới ngưỡng hàng chết");
  return {
    ...base,
    decision: "HOLD",
    reason: `Không bán được trong cửa sổ gần đây (lần bán cuối ${idleDays === null ? "chưa rõ" : `${idleDays} ngày trước`}) — chưa tới ngưỡng ${SLOW_MOVING_RULES.deadDays} ngày để gọi là hàng chết. Không đặt thêm.`,
    suggestedQty: 0,
    capitalRequired: 0,
    confidence: confidenceFrom(notes, false),
  };
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

/** Câu tóm tắt tiền vốn cho giao diện — "null" phải đọc ra là CHƯA BIẾT, không phải 0đ. */
export function capitalLabel(v: number | null): string {
  return v === null ? "Chưa có giá nhập" : vnd(v);
}
