/**
 * ĐỘ TIN CỦA HỆ THỐNG — DỰNG TỪ BẰNG CHỨNG, KHÔNG HỎI MÔ HÌNH.
 *
 * ═══ VÌ SAO KHÔNG DÙNG ĐỘ TIN CỦA MÔ HÌNH ═══
 *
 * `understanding.confidence` là con số MÔ HÌNH TỰ CHẤM CHO MÌNH. Nó có ích, nhưng nó không phải
 * bằng chứng: một mô hình đọc nhầm "vâng" thành màu vàng vẫn có thể rất tự tin, vì nó tự tin về
 * cái nó ĐÃ HIỂU, không phải về cái khách ĐÃ NÓI. Đo trên bản chạy thử 19/09/2026: 771/1006 lượt
 * có độ tin ≥ 0.75, và KHÔNG lượt nào được người chấm — nên con số ấy chưa từng được đối chiếu
 * với sự thật lần nào.
 *
 * Độ tin của HỆ THỐNG hỏi một câu khác: *có bao nhiêu bằng chứng KIỂM ĐƯỢC đứng sau kết luận này*.
 * Khớp đúng một dòng mẫu mã trong danh mục là bằng chứng. Khách gõ thẳng màu ra là bằng chứng.
 * "Mô hình thấy chắc" thì không.
 *
 * ═══ HAI CON SỐ GIỮ RIÊNG, KHÔNG TRỘN ═══
 *
 * `model_confidence` và `system_confidence` trả lời hai câu hỏi khác nhau, và chỗ CHÚNG LỆCH NHAU
 * mới là chỗ đáng đọc nhất: mô hình rất tự tin trong khi hệ thống không có bằng chứng nào là dấu
 * hiệu kinh điển của một câu bịa trôi chảy. Trộn thành một số trung bình là xoá đúng tín hiệu ấy.
 *
 * Bộ định tuyến ưu tiên `system_confidence` — xem `preferSystem()` cuối tệp.
 */

/** Dấu hiệu LÀM TĂNG độ tin. Mỗi dấu hiệu là một thứ KIỂM ĐƯỢC, không phải một cảm giác. */
export const POSITIVE_SIGNALS = {
  EXACT_PRODUCT_MATCH: { weight: 0.25, label: "Khớp đúng một sản phẩm trong danh mục" },
  EXACT_SKU: { weight: 0.25, label: "Khớp đúng một mẫu mã cụ thể" },
  EXPLICIT_COLOR: { weight: 0.12, label: "Khách nói rõ màu" },
  EXPLICIT_SIZE: { weight: 0.12, label: "Khách nói rõ size" },
  EXPLICIT_QUANTITY: { weight: 0.08, label: "Khách nói rõ số lượng" },
  EXPLICIT_CONFIRMATION: { weight: 0.2, label: "Khách xác nhận đúng bản chốt đã gửi" },
  SOURCE_PROVENANCE: { weight: 0.1, label: "Mỗi dữ kiện truy được về tin nhắn gốc" },
  CATALOG_MATCH: { weight: 0.1, label: "Dữ kiện khớp danh mục ERP" },
  NO_CONFLICTS: { weight: 0.08, label: "Không có mâu thuẫn nào trong hội thoại" },
} as const satisfies Record<string, { weight: number; label: string }>;

/**
 * Dấu hiệu LÀM GIẢM độ tin.
 *
 * Trọng số âm cố ý NẶNG HƠN dương: một mâu thuẫn chưa gỡ xoá được nhiều bằng chứng thuận, vì nó
 * nói rằng ta đang hiểu sai một chỗ nào đó — và chưa biết chỗ nào.
 */
export const NEGATIVE_SIGNALS = {
  MULTIPLE_CANDIDATE_PRODUCTS: { weight: -0.3, label: "Nhiều sản phẩm cùng khớp" },
  CONFLICTING_VARIANTS: { weight: -0.3, label: "Mẫu mã mâu thuẫn nhau" },
  REPEATED_CORRECTIONS: { weight: -0.25, label: "Khách đã sửa lại nhiều lần" },
  AMBIGUOUS_LANGUAGE: { weight: -0.2, label: "Câu khách nhiều cách hiểu" },
  MISSING_CATALOG: { weight: -0.35, label: "Chưa nối được vào danh mục" },
  STALE_CATALOG: { weight: -0.15, label: "Dữ liệu danh mục đã cũ" },
  INFERRED_SIZE: { weight: -0.2, label: "Size do máy suy ra, khách chưa chọn" },
  UNKNOWN_PRICE: { weight: -0.25, label: "Chưa tính được giá" },
} as const satisfies Record<string, { weight: number; label: string }>;

export type PositiveSignal = keyof typeof POSITIVE_SIGNALS;
export type NegativeSignal = keyof typeof NEGATIVE_SIGNALS;
export type ConfidenceSignal = PositiveSignal | NegativeSignal;

export const ALL_SIGNALS: Record<string, { weight: number; label: string }> = { ...POSITIVE_SIGNALS, ...NEGATIVE_SIGNALS };

export type SystemConfidence = {
  /** 0–1, hoặc `null` khi KHÔNG CÓ dấu hiệu nào để đọc — chưa biết, không phải 0. */
  value: number | null;
  positives: PositiveSignal[];
  negatives: NegativeSignal[];
  /** Câu giải thích đọc được. Một con số không kèm lý do thì không ai sửa được gì từ nó. */
  why: string;
};

/**
 * Tính độ tin của hệ thống. HÀM THUẦN.
 *
 * KHÔNG CÓ dấu hiệu nào ⇒ `null`, không phải 0. Hai thứ đó khác nhau: "chưa quan sát được gì" là
 * lý do để đi lấy thêm dữ kiện, còn "0" là một lời khẳng định rằng mọi bằng chứng đều chống lại
 * kết luận. Luật 42 của kho mã nói đúng điều này, và đây là chỗ dễ vi phạm nhất vì 0 rất tiện.
 */
export function systemConfidence(signals: ConfidenceSignal[]): SystemConfidence {
  const positives = signals.filter((s): s is PositiveSignal => s in POSITIVE_SIGNALS);
  const negatives = signals.filter((s): s is NegativeSignal => s in NEGATIVE_SIGNALS);
  if (!positives.length && !negatives.length) {
    return { value: null, positives: [], negatives: [], why: "Không có dấu hiệu nào đọc được — CHƯA BIẾT, không phải 0" };
  }
  const tong = [...positives, ...negatives].reduce((t, s) => t + ALL_SIGNALS[s].weight, 0);
  // Kẹp về [0,1]: đây là một thang đọc-được cho người, không phải một xác suất có ý nghĩa thống kê,
  // và tệp này không giả vờ ngược lại.
  const value = Math.max(0, Math.min(1, Number(tong.toFixed(2))));
  const why = [
    positives.length ? `thuận: ${positives.map((p) => POSITIVE_SIGNALS[p].label).join(", ")}` : "",
    negatives.length ? `nghịch: ${negatives.map((n) => NEGATIVE_SIGNALS[n].label).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return { value, positives, negatives, why };
}

/**
 * Bộ định tuyến ƯU TIÊN độ tin của hệ thống.
 *
 * Hệ thống chưa đọc được gì (`null`) thì mới lùi về độ tin của mô hình — và KHI ẤY phải đọc nó
 * như một phỏng đoán, nên hàm trả kèm nguồn thay vì chỉ một con số. Một con số trần không nói
 * được nó đến từ bằng chứng hay từ lời tự chấm của mô hình.
 */
export function preferSystem(system: number | null, model: number | null): { value: number | null; from: "SYSTEM" | "MODEL" | "NONE" } {
  if (system !== null) return { value: system, from: "SYSTEM" };
  if (model !== null) return { value: model, from: "MODEL" };
  return { value: null, from: "NONE" };
}

/**
 * CHỖ HAI CON SỐ LỆCH NHAU — dấu hiệu kinh điển của một câu bịa trôi chảy.
 *
 * Mô hình rất tự tin (≥ 0.8) trong khi hệ thống gần như không có bằng chứng (≤ 0.3). Đây KHÔNG
 * phải một lỗi tự động; nó là một ca đáng đưa cho người đọc trước các ca khác.
 */
export function overconfident(system: number | null, model: number | null): boolean {
  return system !== null && model !== null && model >= 0.8 && system <= 0.3;
}
