/**
 * ═══════════ CÔNG THỨC VIẾT CONTENT QUẢNG CÁO (chủ shop 29/09/2026) ═══════════
 *
 * "Content viết theo các công thức, concept khác nhau nhằm tạo được CTR, CR cao" + "không để giá bán trên content". Mỗi phương án
 * AI viết đi theo MỘT công thức dưới đây, để người chọn so được các HƯỚNG khác nhau thật (không phải năm bản na ná). Lời dặn cho
 * mô hình viết TẠI ĐÂY (bảng hằng) — người chỉ chọn khoá. Không công thức nào được phép bịa số liệu (khách đã mua, sao đánh giá,
 * hàng còn lại) hay khuyến mãi: luật khẳng định chung của bộ viết vẫn áp trên mọi công thức.
 */

export const COPY_FORMULA_KEYS = ["HOOK_QUESTION", "AIDA", "PAS", "BAB", "FAB", "STORY", "UGC", "LISTICLE", "OCCASION"] as const;
export type CopyFormula = (typeof COPY_FORMULA_KEYS)[number];

type FormulaDef = { label: string; hint: string; instruction: string };

export const COPY_FORMULAS: Record<CopyFormula, FormulaDef> = {
  HOOK_QUESTION: {
    label: "Câu hỏi mở đầu",
    hint: "Dòng đầu là một câu hỏi đúng nỗi băn khoăn của khách — dừng lướt, tăng CTR",
    instruction: "Mở đầu bằng MỘT câu hỏi ngắn chạm đúng băn khoăn của khách khi chọn đồ (dáng, dịp mặc, cảm giác tự tin), rồi trả lời bằng sản phẩm trong ảnh và mời nhắn tin.",
  },
  AIDA: {
    label: "AIDA",
    hint: "Chú ý → Thích thú → Mong muốn → Hành động",
    instruction: "Theo AIDA: câu đầu gây CHÚ Ý; tiếp theo làm THÍCH THÚ bằng điểm nổi bật nhìn thấy trong ảnh; khơi MONG MUỐN (mặc lên thấy mình thế nào); kết bằng lời kêu gọi HÀNH ĐỘNG nhắn tin cụ thể.",
  },
  PAS: {
    label: "PAS",
    hint: "Vấn đề → Khuấy động → Giải pháp",
    instruction: "Theo PAS: nêu một VẤN ĐỀ quen thuộc khi mặc đồ (vd khó chọn váy che khuyết điểm, mặc đi tiệc sợ quê); KHUẤY ĐỘNG cảm giác ấy một câu; đưa sản phẩm trong ảnh làm GIẢI PHÁP; mời nhắn tin.",
  },
  BAB: {
    label: "Trước – Sau – Cầu nối",
    hint: "Trước khi có → sau khi có → sản phẩm là cầu nối",
    instruction: "Theo Before–After–Bridge: tả TRƯỚC (tình huống / cảm giác chưa ưng), SAU (mặc sản phẩm này thì khác thế nào), rồi sản phẩm là CẦU NỐI; mời nhắn tin để được tư vấn size.",
  },
  FAB: {
    label: "Đặc điểm – Lợi ích",
    hint: "Đặc điểm nhìn thấy → lợi thế → lợi ích cho người mặc",
    instruction: "Theo FAB: nêu 2–3 ĐẶC ĐIỂM nhìn thấy rõ trong ảnh (kiểu dáng, đường cắt, chi tiết), mỗi cái kèm LỢI ÍCH cụ thể cho người mặc; không nêu chất liệu nếu tên sản phẩm không ghi.",
  },
  STORY: {
    label: "Kể chuyện ngắn",
    hint: "Một khoảnh khắc đời thường có sản phẩm — tăng CR",
    instruction: "Kể một CÂU CHUYỆN rất ngắn (2–4 câu) về một khoảnh khắc đời thường khi mặc sản phẩm trong ảnh (đi làm, hẹn hò, đi chơi cuối tuần), giọng ấm, kết bằng lời mời nhắn tin.",
  },
  UGC: {
    label: "Giọng khách thật",
    hint: "Như lời một chị khách tâm sự — gần gũi, tin cậy",
    instruction: "Viết như lời một khách hàng nữ TÂM SỰ tự nhiên về cảm giác khi mặc (ngôi thứ nhất, giọng đời thường). KHÔNG bịa tên người, số sao, số lượt mua hay lời khen có thật — chỉ là giọng văn.",
  },
  LISTICLE: {
    label: "3 lý do",
    hint: "Danh sách ngắn, dễ đọc lướt",
    instruction: "Viết dạng DANH SÁCH: câu mở + 3 lý do ngắn (mỗi lý do một dòng, có thể dùng ✔️) vì sao nên chọn sản phẩm trong ảnh, dựa đúng thứ nhìn thấy; kết bằng lời mời nhắn tin.",
  },
  OCCASION: {
    label: "Theo dịp mặc",
    hint: "Gắn với dịp cụ thể (đi làm, đi tiệc, du lịch…) — tạo lý do mua ngay",
    instruction: "Gắn sản phẩm với MỘT dịp mặc cụ thể hợp với ảnh (đi làm, đi tiệc, hẹn hò, du lịch, lễ Tết…), tạo lý do nên có ngay cho dịp ấy — không bịa khuyến mãi hay số lượng có hạn.",
  },
};

/** Tối đa bấy nhiêu công thức một lượt — mỗi công thức một phương án. */
export const COPY_MAX_FORMULAS = 4;

/** Mặc định khi người không chọn: ba hướng khác nhau rõ (câu hỏi · nỗi đau · khoảnh khắc). */
export const COPY_DEFAULT_FORMULAS: CopyFormula[] = ["HOOK_QUESTION", "PAS", "STORY"];

/** Lời dặn chung để tăng CTR / CR — áp trên mọi công thức. */
export const COPY_CONVERSION_RULES = [
  "- Dòng ĐẦU TIÊN phải đủ sức dừng lướt (ngắn, cụ thể, chạm cảm xúc) — Facebook chỉ hiện 1–2 dòng trước chữ 'Xem thêm'.",
  "- Câu ngắn, xuống dòng hợp lý, 1–3 emoji vừa phải; giọng thân thiện, xưng hô 'chị em / nàng / chị' như shop thời trang nữ Việt.",
  "- Kết bằng lời kêu gọi nhắn tin RÕ và cụ thể (vd 'Nhắn shop để được tư vấn size vừa dáng').",
  "- headline: câu ngắn nêu lợi ích / cảm giác chính, không lặp y dòng đầu của primaryText.",
].join("\n");

/** Lời dặn KHÔNG GHI GIÁ (chủ shop: "không để giá bán trên content") — shop chốt giá qua tin nhắn. */
export const NO_PRICE_RULE = "- KHÔNG ghi giá bán, không bất kỳ con số tiền nào (k, đ, VND, nghìn, triệu…) — khách nhắn tin để được báo giá.";

/** Làm sạch danh sách công thức: khoá lạ bỏ, trùng bỏ, tối đa `COPY_MAX_FORMULAS`; rỗng ⇒ mặc định. Hàm THUẦN. */
export function normalizeFormulas(raw: unknown): CopyFormula[] {
  const out: CopyFormula[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (typeof x === "string" && (COPY_FORMULA_KEYS as readonly string[]).includes(x) && !out.includes(x as CopyFormula)) out.push(x as CopyFormula);
    if (out.length >= COPY_MAX_FORMULAS) break;
  }
  return out.length ? out : [...COPY_DEFAULT_FORMULAS];
}
