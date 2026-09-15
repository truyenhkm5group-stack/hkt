/**
 * CÂU DỮ KIỆN ĐÃ DUYỆT — thứ DUY NHẤT máy được nói khi khách hỏi ngoài kịch bản.
 *
 * Ranh giới của cả nền tảng này nằm ở đây: DỮ LIỆU LÀ SỰ THẬT, MÔ HÌNH CHỈ LÀ CÁCH NÓI. Mô hình
 * được đổi cách xưng hô, ghép hai ý, bớt một chữ. Nó KHÔNG được thêm một dữ kiện nào — không con
 * số mới, không cam kết mới, không đặc điểm sản phẩm mới.
 *
 * Mảng chữ trần không nói được ai duyệt, duyệt lúc nào, câu ấy thuộc nhóm nào. Mà "ai duyệt" chính
 * là thứ phân biệt MỘT DỮ KIỆN với một câu ai đó gõ vội trong lúc bận.
 */

export const FACT_CATEGORIES = [
  "MATERIAL",
  "FIT",
  "CARE",
  "PAYMENT",
  "DELIVERY",
  "POLICY",
  "FAQ",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FACT_CATEGORY_LABEL: Record<FactCategory, string> = {
  MATERIAL: "Chất liệu · độ dày · co giãn · lót",
  FIT: "Form dáng · ôm/rộng",
  CARE: "Bảo quản · giặt là",
  PAYMENT: "Thanh toán · COD · kiểm hàng",
  DELIVERY: "Giao hàng",
  POLICY: "Chính sách",
  FAQ: "Câu hỏi thường gặp đã duyệt",
};

export type ApprovedFact = {
  category: FactCategory;
  text: string;
  /** Email người duyệt. Rỗng = chưa ai đứng tên — câu đó KHÔNG được dùng. */
  approvedBy: string;
  /** ISO. Rỗng = chưa duyệt. */
  approvedAt: string;
};

/** Chỉ câu CÓ NGƯỜI ĐỨNG TÊN mới được dùng. Thiếu người duyệt thì nó là bản nháp, không phải dữ kiện. */
export function usableFacts(facts: ApprovedFact[] | null): ApprovedFact[] {
  return (facts ?? []).filter((f) => f.text.trim() && f.approvedBy.trim());
}

/** Câu đã duyệt hợp với câu hỏi đang xét — lọc theo nhóm, không lọc theo độ giống chữ. */
export function factsFor(facts: ApprovedFact[] | null, cats: FactCategory[]): ApprovedFact[] {
  return usableFacts(facts).filter((f) => cats.includes(f.category));
}
