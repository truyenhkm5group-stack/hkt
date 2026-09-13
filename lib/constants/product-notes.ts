/**
 * ═══════════ GHI CHÚ VẬN HÀNH: NHÓM ĐÓNG, VÀ KHÔNG CHẠM VÀO SỐ ═══════════
 *
 * Ghi chú tồn tại để trả lời những câu mà không con số nào trả lời được: vì sao lô này hay bị
 * đổi, size nào khách hay kêu chật, nhà cung cấp nào giao chậm. Đó là BỐI CẢNH cho người đọc —
 * và cố ý KHÔNG phải một đầu vào của bất kỳ phép tính nào.
 */

export const NOTE_CATEGORIES = ["QUALITY", "SIZING", "SUPPLIER", "PRICING", "PACKAGING", "OTHER"] as const;
export type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export const NOTE_CATEGORY_LABEL: Record<NoteCategory, string> = {
  QUALITY: "Chất lượng",
  SIZING: "Size / form",
  SUPPLIER: "Nhà cung cấp",
  PRICING: "Giá bán",
  PACKAGING: "Đóng gói",
  OTHER: "Khác",
};

export const NOTE_CATEGORY_HINT: Record<NoteCategory, string> = {
  QUALITY: "Vải, đường may, màu lệch so với mẫu — thứ khiến khách trả hàng.",
  SIZING: "Form chạy so với bảng size: hay chật, hay rộng, dài hơn mẫu.",
  SUPPLIER: "Xưởng nào làm, giao có đúng hẹn không, lô nào lệch.",
  PRICING: "Vì sao đặt giá này, lần đổi giá gần nhất và lý do.",
  PACKAGING: "Cách đóng gói riêng của mã này — thứ người đóng hàng cần biết trước.",
  OTHER: "Không thuộc nhóm nào ở trên.",
};

export const NOTE_CATEGORY_TONE: Record<NoteCategory, string> = {
  QUALITY: "bg-destructive/10 text-destructive",
  SIZING: "bg-warning/15 text-amber-700 dark:text-amber-300",
  SUPPLIER: "bg-info/12 text-info",
  PRICING: "bg-muted text-muted-foreground",
  PACKAGING: "bg-muted text-muted-foreground",
  OTHER: "bg-muted text-muted-foreground",
};

export const NOTE_MAX_LENGTH = 1000;
