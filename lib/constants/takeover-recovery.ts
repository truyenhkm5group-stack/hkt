/**
 * ═══════════ AI ĐÃ RÚT LUI — CỚ ẤY CÒN ĐÚNG KHÔNG ═══════════
 *
 * `conversation.handoff` đặt `human_takeover_at` kèm MỘT CÂU LÝ DO, và sau lời gọi ấy nhân sự AI
 * im lặng trong hội thoại đó **mãi mãi** — kể cả với tin khách gửi ngày mai. Cờ này DÍNH, đó là
 * thiết kế đúng: một cuộc đã giao cho người thì máy không được nhảy vào giữa chừng.
 *
 * Nhưng nó dính cả khi CÁI CỚ ĐÃ HẾT. Đo bản chạy thử 23/09/2026, 295 cuộc đang mang cờ, và
 * **0 cuộc nào do người thật bấm nhận việc** — tất cả đều là AI tự rút.
 *
 * ─── VÌ SAO KHÔNG GỠ HẾT MỘT LƯỢT ───
 *
 * Vì ba nhóm dưới đây trông giống hệt nhau trong CSDL mà hệ quả thì ngược nhau:
 *
 *   `CAUSE_GONE`      — cớ đã CHỨNG MINH được là hết. Gỡ cờ là trả lại việc máy làm được.
 *   `CAUSE_UNVERIFIED`— cớ CÓ THỂ đã hết, nhưng chưa ai chứng minh. Gỡ là một phỏng đoán.
 *   `CAUSE_STANDS`    — cớ VẪN ĐÚNG. Gỡ là ném máy trở lại đúng chỗ nó đã tự biết không nên ở:
 *                       giữa một khiếu nại, giữa một cuộc mặc cả giá.
 *
 * Gộp ba nhóm rồi "dọn cho sạch" là cách nhanh nhất để một cái máy nói chen vào cuộc đang căng.
 *
 * ─── MỘT GIẢ THUYẾT ĐÃ BỊ CHÍNH SỐ LIỆU BÁC BỎ ───
 *
 * Tôi từng viết rằng 295 cờ ấy là di sản của lần phân loại người gửi sai — ERP xếp bot Gemini là
 * NGƯỜI nên AI tưởng có người đang trả lời rồi rút. Bảng lý do bác bỏ điều đó: **không một cuộc
 * nào mang cớ ấy.** Ghi lại ở đây thay vì xoá đi, vì một giả thuyết nghe rất hợp lý mà sai là thứ
 * sẽ được nghĩ lại lần nữa nếu không có ai ghi rằng nó đã được kiểm và đã sai.
 */

export const RECOVERY_CLASSES = ["CAUSE_GONE", "CAUSE_UNVERIFIED", "CAUSE_STANDS"] as const;
export type RecoveryClass = (typeof RECOVERY_CLASSES)[number];

export const RECOVERY_CLASS_LABEL: Record<RecoveryClass, string> = {
  CAUSE_GONE: "Cớ đã hết — chứng minh được",
  CAUSE_UNVERIFIED: "Cớ CÓ THỂ đã hết — chưa chứng minh",
  CAUSE_STANDS: "Cớ vẫn đúng — giữ nguyên",
};

type Rule = {
  /** Khớp theo TIỀN TỐ mã lý do mà `conversation.handoff` đã lưu. */
  prefix: string;
  klass: RecoveryClass;
  /** Vì sao xếp vào nhóm ấy — in thẳng lên màn hình, không để người đọc phải tin suông. */
  vi: string;
  /** Với `CAUSE_UNVERIFIED`: đo cái gì thì mới chuyển được sang `CAUSE_GONE`. */
  cach?: string;
};

/**
 * Sổ đăng ký. Thêm một mã lý do mới ở `decide.ts` mà quên khai ở đây thì nó rơi về
 * `CAUSE_STANDS` — nhánh HẸP NHẤT. Mặc định phải là "không đụng tới": một mã chưa ai nghĩ tới
 * mà tự động được gỡ cờ là cách một luật an toàn trở thành một luật vô hại trên giấy.
 */
export const RECOVERY_RULES: Rule[] = [
  {
    prefix: "SIZE_DATA_MISSING",
    klass: "CAUSE_GONE",
    vi: "AI rút vì ERP chưa có bảng số đo cho mẫu này. Bảng nam + nữ đã khai cho cả 7 mã (23/09/2026), nên cái cớ ấy không còn tồn tại — kiểm được bằng chính `resolveSizeRule()`.",
  },
  {
    prefix: "LOW_CONFIDENCE: Không hiểu được khách đang muốn gì",
    klass: "CAUSE_UNVERIFIED",
    vi: "AI rút vì không hiểu ý khách. Lúc đo đợt trước danh mục TRỐNG — `product.search` gọi 36 lần, 36 lần ra rỗng — nên phần lớn 'không hiểu' thật ra là 'không tra được mẫu nào'. Danh mục nay đã đồng bộ 7 mã.",
    cach: "Chạy lại chính những hội thoại ấy ở chế độ NGẦM và đếm bao nhiêu lượt còn rút với cùng cớ. Còn rút thì cớ vẫn đúng — không phải cứ đồng bộ danh mục là máy hiểu được người.",
  },
  {
    prefix: "LOW_CONFIDENCE: Đã hỏi",
    klass: "CAUSE_STANDS",
    vi: "AI đã hỏi cùng một thứ ba lần mà không nhận được câu trả lời dùng được. Gỡ cờ là cho nó hỏi lần thứ tư.",
  },
  {
    prefix: "PRICE_NEGOTIATION",
    klass: "CAUSE_STANDS",
    vi: "Khách trả giá. Giá là quyết định của người — máy không tự hạ, và không được quay lại bàn tiếp.",
  },
  {
    prefix: "COMPLAINT",
    klass: "CAUSE_STANDS",
    vi: "Khách khiếu nại. Một cái máy nói chen vào giữa một khiếu nại làm hỏng đúng cái quan hệ mà cuộc ấy đang cần cứu.",
  },
  {
    prefix: "AFTER_SALES",
    klass: "CAUSE_STANDS",
    vi: "Việc sau bán (đổi trả, bảo hành) thuộc nhóm bắt buộc người xử lý.",
  },
];

/** HÀM THUẦN. Không khớp mã nào ⇒ `CAUSE_STANDS`, nhánh hẹp nhất. */
export function classifyTakeover(reason: string): { klass: RecoveryClass; vi: string; cach?: string } {
  const r = (reason ?? "").trim();
  for (const rule of RECOVERY_RULES) {
    if (r.startsWith(rule.prefix)) return { klass: rule.klass, vi: rule.vi, cach: rule.cach };
  }
  return {
    klass: "CAUSE_STANDS",
    vi: "Mã lý do chưa được khai trong sổ đăng ký — rơi về nhánh hẹp nhất, KHÔNG gỡ. Khai nó vào `RECOVERY_RULES` nếu đã biết cớ ấy còn đúng hay không.",
  };
}
