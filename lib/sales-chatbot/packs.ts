/**
 * ═══════════ GÓI NGÀNH CỦA LỜI NHẮC CHATBOT BÁN HÀNG (docs/productization/TECH_DEBT.md TD-09 · MIGRATION_PLAN.md M5) ═══════════
 *
 * Lời nhắc hệ thống (`systemPrompt`, engine.ts) từng mang ví dụ của MỘT ngành — «1kg hay 2kg», «chả cá thu», khách sỉ «từ
 * 10kg» — cho MỌI tổ chức: shop thời trang hay spa đăng ký cũng nhận ví dụ hải sản. Nay phần chữ phụ thuộc ngành tách ra
 * đây; luật chung (giá chỉ từ công cụ, chốt khi khách đồng ý, khi nào chuyển người…) vẫn ở engine.ts.
 *
 * Gói `food` là chữ CŨ, trích NGUYÊN VĂN từ engine.ts lúc tách — tổ chức mẫu «Thực phẩm đóng gói» / «Hải sản» (Hải Sản Làng
 * Chài) nhận lời nhắc GIỐNG HỆT TỪNG KÝ TỰ như trước (tests/sales-packs.test.ts so từng byte với ảnh chụp). Gói chọn theo
 * mẫu ngành của tổ chức (`platform_organizations.template_key`): không có mẫu ⇒ `food` (giữ nguyên lời nhắc cũ); mẫu
 * ngành khác hẳn (TMĐT chung, sỉ, spa, nhà hàng…) ⇒ `generic`.
 */
export type SalesPackKey = "food" | "fashion" | "generic";

export type SalesPack = {
  key: SalesPackKey;
  label: string;
  /** B1 — ví dụ quy cách phải hỏi lại trước khi báo giá. */
  specExample: string;
  /** HIỂU KHÁCH — cả dòng: chữ mô tả ≠ tên sản phẩm, cách khách nói đơn vị. */
  describeLine: string;
  /** Ví dụ «đừng hỏi lại câu vừa hỏi». */
  answeredExample: string;
  /** Ví dụ câu chốt dễ trả lời khi khách lưng chừng. */
  nudgeExample: string;
  /** Gợi ý ngưỡng «số lượng lớn» của khách sỉ (có dấu cách đầu; rỗng = không nêu ngưỡng). */
  bulkHint: string;
  /** Luật 6 — ví dụ khách đồng ý lấy thêm món sau tóm tắt. */
  addMoreExample: string;
};

export const FOOD_PACK: SalesPack = {
  key: "food",
  label: "Thực phẩm / hải sản",
  specExample: "(vd 1kg hay 2kg)",
  describeLine: "  · «nguyên chất», «tươi», «loại ngon», «thật»… là MÔ TẢ, không phải tên sản phẩm khác; «1kí», «1 ký», «1 cân», «1kg» đều là 1kg; «nửa ký» = 0,5kg. Chọn sản phẩm có TÊN khớp món khách nói (vd «chả cá thu») trong kết quả search_products — không kết luận «không có» khi kết quả có sản phẩm cùng tên chính. Mỗi QUY CÁCH (1kg, 0,5kg…) là một mẫu mã riêng với giá riêng: khách nói số lượng không khớp một quy cách (1,5kg, «nửa ký») ⇒ GHÉP từ các quy cách đang bán (vd 1kg + 0,5kg, mỗi dòng đúng mẫu mã của nó); không ghép được ⇒ nói các quy cách shop đang bán, KHÔNG tự chia / nhân giá.",
  answeredExample: "(vd shop hỏi «lấy bao nhiêu kg», khách đáp «lấy lần 20-30 kg»)",
  nudgeExample: "(vd «Dạ mình lấy 1kg ăn thử trước nhé, em lên đơn luôn ạ?»)",
  bulkHint: " (từ 10kg)",
  addMoreExample: "«lấy thêm 1kg»",
};

export const FASHION_PACK: SalesPack = {
  key: "fashion",
  label: "Thời trang",
  specExample: "(vd size nào, màu nào)",
  describeLine: "  · «form rộng», «chất mát», «hàng đẹp», «y hình»… là MÔ TẢ, không phải tên sản phẩm khác; khách nói chiều cao / cân nặng để chọn size ⇒ đối chiếu mẫu mã có size trong kết quả search_products, không tự bịa bảng size. Chọn sản phẩm có TÊN khớp món khách nói trong kết quả search_products — không kết luận «không có» khi kết quả có sản phẩm cùng tên chính.",
  answeredExample: "(vd shop hỏi «chị mặc size gì ạ», khách đáp «size M»)",
  nudgeExample: "(vd «Dạ em lên đơn size M cho mình luôn nhé ạ?»)",
  bulkHint: "",
  addMoreExample: "«lấy thêm 1 cái size M»",
};

export const GENERIC_PACK: SalesPack = {
  key: "generic",
  label: "Chung",
  specExample: "(vd loại / quy cách / kích cỡ nào)",
  describeLine: "  · «chính hãng», «loại tốt», «mới», «xịn»… là MÔ TẢ, không phải tên sản phẩm khác. Chọn sản phẩm có TÊN khớp món khách nói trong kết quả search_products — không kết luận «không có» khi kết quả có sản phẩm cùng tên chính.",
  answeredExample: "(vd shop hỏi «mình lấy mấy cái ạ», khách đáp «lấy 3»)",
  nudgeExample: "(vd «Dạ em lên đơn cho mình luôn nhé ạ?»)",
  bulkHint: "",
  addMoreExample: "«lấy thêm 1 cái»",
};

export const SALES_PACKS: Record<SalesPackKey, SalesPack> = { food: FOOD_PACK, fashion: FASHION_PACK, generic: GENERIC_PACK };

/**
 * Mẫu ngành của tổ chức ⇒ gói. HÀM THUẦN. KHÔNG có mẫu (tổ chức cấp bằng lệnh, «Bắt đầu trắng») ⇒ `food` = lời nhắc CŨ: tách
 * gói không được đổi hành vi của bất kỳ tổ chức nào đang chạy mà không ai chọn. Chỉ mẫu ngành KHÁC HẲN mới đổi gói.
 */
export function salesPackFor(templateKey: string | null): SalesPack {
  if (templateKey === null || templateKey === "food-commerce" || templateKey === "seafood-commerce") return FOOD_PACK;
  if (templateKey === "fashion-commerce") return FASHION_PACK;
  return GENERIC_PACK;
}
