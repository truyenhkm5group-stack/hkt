/**
 * LÝ DO CHẤM — VÌ SAO CÂU NÀY KHÔNG ĐẠT.
 *
 * Một ô chữ tự do ghi được mọi thứ nhưng ĐẾM được không thứ gì. Sau ba mươi lượt chấm, chủ shop
 * cần biết "máy hay hỏng ở đâu nhất" — và câu trả lời ấy chỉ có nếu lý do là một DANH SÁCH ĐÓNG.
 *
 * Mỗi nhãn khai thẳng ai phải đi sửa, vì đó mới là thứ biến một bảng đếm thành một việc:
 *   `MODEL`  — sửa luật / lời dặn / mẫu câu. Việc của người làm hệ thống.
 *   `DATA`   — ERP chưa có dữ liệu để trả lời đúng. Việc của CHỦ SHOP, không phải "AI còn yếu".
 *   `POLICY` — máy làm đúng luật đang chạy, nhưng luật ấy nên đổi. Việc của người ra quyết định.
 *
 * Ô ghi chú vẫn còn và vẫn quan trọng — nhãn để ĐẾM, ghi chú để HIỂU. Không cái nào thay cái nào.
 */
export const REVIEW_REASON_TAGS = [
  // ── Nhóm HIỂU SAI: máy đọc sai thứ khách nói ──
  "WRONG_INTENT",
  "WRONG_PRODUCT",
  "WRONG_VARIANT",
  "WRONG_STATE",
  "MISSING_ENTITY",
  "WRONG_PRICE",
  "MISSED_QUESTION",
  "WRONG_NEXT_STEP",
  "TOO_PUSHY",
  "TOO_PASSIVE",
  "UNNATURAL_TONE",
  "TOO_LONG",
  "HALLUCINATION",
  "BAD_REPLY",
  "WRONG_ORDER_DRAFT",
  "SHOULD_HAVE_HANDED_OFF",
  "HANDED_OFF_TOO_EARLY",
  "MISSING_ERP_DATA",
  "POLICY_TOO_STRICT",
  // Rổ CUỐI CÙNG, và nó phải tồn tại. Không có nó thì một lỗi chưa ai lường trước sẽ bị nhét vào
  // một nhãn gần đúng, và bảng đếm nói sai về chỗ máy hay hỏng nhất. Một `OTHER` kèm ghi chú đọc
  // được là dữ liệu; một nhãn sai là nhiễu.
  "OTHER",
] as const;

export type ReviewReasonTag = (typeof REVIEW_REASON_TAGS)[number];

export const REVIEW_REASON_TAG_META: Record<ReviewReasonTag, { label: string; owner: "MODEL" | "DATA" | "POLICY" }> = {
  WRONG_INTENT: { label: "Đọc sai ý khách hỏi", owner: "MODEL" },
  WRONG_PRODUCT: { label: "Nhận nhầm sản phẩm", owner: "MODEL" },
  WRONG_VARIANT: { label: "Nhận nhầm mẫu mã (màu / size)", owner: "MODEL" },
  WRONG_STATE: { label: "Mất hoặc ghi sai trạng thái đã chốt", owner: "MODEL" },
  MISSING_ENTITY: { label: "Bỏ sót dữ kiện khách đã nói", owner: "MODEL" },
  WRONG_PRICE: { label: "Báo sai giá / phí ship", owner: "MODEL" },
  MISSED_QUESTION: { label: "Không trả lời câu khách hỏi", owner: "MODEL" },
  WRONG_NEXT_STEP: { label: "Đẩy sai bước tiếp theo", owner: "MODEL" },
  TOO_PUSHY: { label: "Thúc ép quá", owner: "MODEL" },
  TOO_PASSIVE: { label: "Không đẩy hội thoại đi tiếp", owner: "MODEL" },
  UNNATURAL_TONE: { label: "Giọng không giống người bán", owner: "MODEL" },
  TOO_LONG: { label: "Dài dòng so với một tin chat", owner: "MODEL" },
  HALLUCINATION: { label: "Nói điều ERP không bảo đảm được", owner: "MODEL" },
  BAD_REPLY: { label: "Câu chữ không gửi được cho khách", owner: "MODEL" },
  WRONG_ORDER_DRAFT: { label: "Bản nháp đơn sai (mẫu mã · số lượng · tiền)", owner: "MODEL" },
  SHOULD_HAVE_HANDED_OFF: { label: "Đáng lẽ phải chuyển người", owner: "MODEL" },
  HANDED_OFF_TOO_EARLY: { label: "Chuyển người quá sớm", owner: "MODEL" },
  MISSING_ERP_DATA: { label: "ERP chưa có dữ liệu để trả lời", owner: "DATA" },
  POLICY_TOO_STRICT: { label: "Luật đang chạy quá chặt", owner: "POLICY" },
  OTHER: { label: "Khác — ghi rõ ở ô ghi chú", owner: "MODEL" },
};

/** Ba nấc kết luận chung cho cả lượt. `null` = CHƯA CHẤM, không phải "tạm được". */
export const REVIEW_VERDICTS = ["GOOD", "ACCEPTABLE", "BAD"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  GOOD: "Gửi được nguyên văn",
  ACCEPTABLE: "Sửa nhẹ là gửi được",
  BAD: "Không gửi được",
};

export function isReviewReasonTag(value: string): value is ReviewReasonTag {
  return (REVIEW_REASON_TAGS as readonly string[]).includes(value);
}
