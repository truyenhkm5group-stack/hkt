import { ITEM_CONDITIONS, ITEM_CONDITION_LABEL, type ItemCondition } from "@/lib/constants/return-lifecycle";

/**
 * ═══════════ CHỨNG CỨ, KHÔNG PHẢI SUY DIỄN ═══════════
 *
 * Một món hàng hoàn chỉ được gọi là "còn tốt" khi CÓ NGƯỜI NHÌN VÀO NÓ và ghi lại điều đó. Ba lối
 * tắt dưới đây đều nghe rất hợp lý và cả ba đều sai:
 *
 *  · «có phiếu tái nhập ⇒ hàng tốt» — phiếu nói hàng ĐÃ VÀO TỒN, không nói ai đã nhìn nó. Đường
 *    đếm một chạm cũ lập phiếu từ một kết luận ở mức CẢ KIỆN, nên phiếu tồn tại mà không món nào
 *    được xem riêng.
 *  · «tồn có tăng ⇒ điều kiện = GOOD» — đây là suy NGƯỢC từ hệ quả về nguyên nhân. Tồn tăng vì ai
 *    đó bấm một nút; cái nút ấy có thể đã bấm nhầm, và con số tồn không biết điều đó.
 *  · «không có dòng hỏng ⇒ hỏng = 0» — vắng mặt của bằng chứng không phải bằng chứng của vắng mặt.
 *    Đo trên production 14/09/2026: **0 món hỏng trên 132 món CÓ chứng cứ**, và **615 món không có
 *    chứng cứ nào**. In ra "0% hỏng" là khẳng định về 615 món mà chưa ai mở ra xem.
 *
 * Nên ở đây điều kiện của một món có BỐN mức, và mức đầu tiên là mức mặc định:
 */
export const ITEM_EVIDENCE_LEVELS = ["NO_EVIDENCE", "PARCEL_LEVEL_ONLY", "ITEM_CONFIRMED"] as const;
export type ItemEvidenceLevel = (typeof ITEM_EVIDENCE_LEVELS)[number];

export const EVIDENCE_LABEL: Record<ItemEvidenceLevel, string> = {
  NO_EVIDENCE: "Chưa ai kiểm",
  PARCEL_LEVEL_ONLY: "Chỉ có kết luận cả kiện",
  ITEM_CONFIRMED: "Có kết luận từng món",
};

export const EVIDENCE_WHY: Record<ItemEvidenceLevel, string> = {
  NO_EVIDENCE: "Kiện chưa có lượt đếm nào. Không biết trong kiện có gì, và cũng không được đoán.",
  PARCEL_LEVEL_ONLY:
    "Kiện đã đếm qua đường một chạm cũ: có phiếu tái nhập và một kết luận cho CẢ KIỆN, nhưng không món nào được ghi riêng. Điều kiện từng món là CHƯA BIẾT — không phải 'tốt'.",
  ITEM_CONFIRMED: "Có dòng `return_inspection_items`: người đếm đã ghi rõ món này về bao nhiêu và ở tình trạng nào.",
};

/** Mức nào được coi là ĐỦ để kết luận về chất lượng. Chỉ một. */
export const EVIDENCE_IS_CONCLUSIVE: Record<ItemEvidenceLevel, boolean> = {
  NO_EVIDENCE: false,
  PARCEL_LEVEL_ONLY: false,
  ITEM_CONFIRMED: true,
};

/**
 * ═══════════ TRẠNG THÁI ĐIỀU KIỆN DÙNG CHO BÁO CÁO ═══════════
 *
 * Bảy giá trị của `ITEM_CONDITIONS` (`OK` · `SHORT` · `WRONG_ITEM` · `DAMAGED` · `DIRTY` ·
 * `UNSELLABLE` · `OTHER`) là **phân loại đã có**, và bản này KHÔNG tạo bộ thứ hai — nó chỉ thêm
 * đúng MỘT giá trị mà bảng phân loại cũ không thể diễn đạt được:
 *
 *   `UNKNOWN` — chưa ai kết luận về món này.
 *
 * `UNKNOWN` cố ý KHÔNG nằm trong `ITEM_CONDITIONS`: bảng kia là những gì người đếm CHỌN được ở
 * màn hình, còn `UNKNOWN` là trạng thái khi họ chưa chọn gì. Trộn hai thứ vào một danh sách là mở
 * đường cho một nút "Chưa biết" xuất hiện trên trạm đếm — và một nút như thế là nút bỏ qua việc.
 */
export const CONDITION_UNKNOWN = "UNKNOWN" as const;
export type ReportedCondition = ItemCondition | typeof CONDITION_UNKNOWN;

export const REPORTED_CONDITIONS: readonly ReportedCondition[] = [...ITEM_CONDITIONS, CONDITION_UNKNOWN];

export const REPORTED_CONDITION_LABEL: Record<ReportedCondition, string> = {
  ...ITEM_CONDITION_LABEL,
  UNKNOWN: "Chưa biết",
};

/**
 * Món nào được tính vào MẪU SỐ của các tỷ lệ chất lượng.
 *
 * `UNKNOWN` bị loại — đó là cả điểm của bản này. Một tỷ lệ hỏng tính trên tập có cả món chưa ai
 * xem là một tỷ lệ pha loãng theo đúng hướng dễ chịu: càng ít người đếm kỹ thì tỷ lệ hỏng càng
 * đẹp. Thay vào đó tỷ lệ chỉ tính trên món CÓ chứng cứ, và ĐỘ PHỦ luôn đứng cạnh nó
 * (AGENTS.md mục 27 và 39).
 */
export function countsTowardQualityRate(c: ReportedCondition): boolean {
  return c !== CONDITION_UNKNOWN;
}

/**
 * ═══════════ NGƯỠNG ĐỦ TIN ĐỂ KẾT LUẬN ═══════════
 *
 * Dưới ngưỡng này, màn hình vẫn hiện con số nhưng KHÔNG tô màu, KHÔNG xếp hạng và gắn nhãn
 * "dữ liệu chưa đủ" (AGENTS.md mục 39 và 44: `canConclude = false` ⇒ hiện thực tế, không kết luận).
 *
 * 60% là ngưỡng TRÌNH BÀY, không phải ngưỡng nghiệp vụ tính ra tiền — nhưng vẫn chỉ đổi ở đây.
 * Đo 14/09/2026: độ phủ thật là 132/747 = 17,7%, nên hôm nay mọi tỷ lệ chất lượng đều nằm dưới
 * ngưỡng và phải mang nhãn ấy.
 */
export const QUALITY_COVERAGE_MIN_PCT = 60;

/** Số món tối thiểu để một tỷ lệ có nghĩa, dù độ phủ cao. */
export const QUALITY_MIN_SAMPLE = 20;

export type CoverageVerdict = "ENOUGH" | "LOW_COVERAGE" | "LOW_SAMPLE" | "NONE";

/**
 * Có đủ căn cứ để KẾT LUẬN về chất lượng hay không — và nếu không thì vì sao.
 *
 * Trả về lý do chứ không chỉ true/false: "chưa đủ dữ liệu" và "mẫu quá nhỏ" là hai việc phải làm
 * khác nhau (đi đếm kỹ hơn, hay đợi thêm hàng về), và người quản lý cần biết mình đang gặp cái nào.
 */
export function coverageVerdict(withEvidence: number, total: number): CoverageVerdict {
  if (total <= 0 || withEvidence <= 0) return "NONE";
  if (withEvidence < QUALITY_MIN_SAMPLE) return "LOW_SAMPLE";
  if ((withEvidence / total) * 100 < QUALITY_COVERAGE_MIN_PCT) return "LOW_COVERAGE";
  return "ENOUGH";
}

export const COVERAGE_VERDICT_LABEL: Record<CoverageVerdict, string> = {
  ENOUGH: "Đủ căn cứ",
  LOW_COVERAGE: "Dữ liệu chưa đủ",
  LOW_SAMPLE: "Mẫu quá nhỏ",
  NONE: "Chưa có chứng cứ nào",
};

export const COVERAGE_VERDICT_WHY: Record<CoverageVerdict, string> = {
  ENOUGH: `Từ ${QUALITY_COVERAGE_MIN_PCT}% số món trở lên có kết luận từng món, và mẫu đủ lớn.`,
  LOW_COVERAGE: `Dưới ${QUALITY_COVERAGE_MIN_PCT}% số món có kết luận từng món. Tỷ lệ vẫn hiện ra nhưng chỉ nói về phần ĐÃ xem, không nói về cả lô.`,
  LOW_SAMPLE: `Ít hơn ${QUALITY_MIN_SAMPLE} món có kết luận. Một hai món hỏng là đủ làm tỷ lệ nhảy vọt.`,
  NONE: "Không món nào có kết luận từng món, nên không có tỷ lệ chất lượng nào để nói.",
};

/**
 * ═══════════ CƠ SỞ GIÁ VỐN: BỐN BẬC, BẬC CUỐI LÀ CHƯA BIẾT ═══════════
 *
 * `lib/queries/cogs.ts::LINE_UNIT_COST` kết thúc bằng `0`. Với lợi nhuận thì `0` và "chưa biết"
 * ra hai kết luận khác hẳn nhau, nên ở đây bậc cuối là **NULL**, và cái nhãn đi kèm nói rõ con số
 * đến từ đâu — một con số giá vốn không có xuất xứ thì không kiểm chứng lại được.
 *
 * KHÔNG BAO GIỜ dùng giá BÁN, doanh thu POS hay biên lợi nhuận ước tính để thay giá vốn: đó là
 * lấy thứ khách trả làm thứ shop bỏ ra.
 */
export const COST_BASES = ["RECEIPT", "ORDER_SNAPSHOT", "VARIANT_DEFAULT", "UNKNOWN"] as const;
export type CostBasis = (typeof COST_BASES)[number];

export const COST_BASIS_LABEL: Record<CostBasis, string> = {
  RECEIPT: "Phiếu nhập kho",
  ORDER_SNAPSHOT: "Giá vốn ghi trên đơn",
  VARIANT_DEFAULT: "Giá nhập mẫu mã",
  UNKNOWN: "Chưa biết",
};

/** Bậc nào là chứng từ kho thật — chỉ bậc này mới gọi là "đo được". */
export const COST_BASIS_IS_AUTHORITATIVE: Record<CostBasis, boolean> = {
  RECEIPT: true,
  ORDER_SNAPSHOT: false,
  VARIANT_DEFAULT: false,
  UNKNOWN: false,
};

export const COST_BASIS_WHY: Record<CostBasis, string> = {
  RECEIPT: "Giá trên phiếu nhập kho gần nhất của chính mẫu mã này — chứng từ thật, kiểm chứng lại được.",
  ORDER_SNAPSHOT: "Giá vốn Pancake chụp lại lúc đồng bộ đơn. Dùng được nhưng không phải chứng từ kho.",
  VARIANT_DEFAULT: "Giá nhập khai ở mẫu mã. Là con số khai báo, không gắn với một lần nhập cụ thể nào.",
  UNKNOWN: "Không nguồn nào cho giá vốn của mẫu mã này. KHÔNG được thay bằng 0 — 0đ nghĩa là hàng cho không.",
};
