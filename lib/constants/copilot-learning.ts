/**
 * ═══════════ HỌC TỪ CHỖ NGƯỜI SỬA — NHƯNG KHÔNG HỌC NHẦM THỨ ═══════════
 *
 * Chủ shop chốt 23/09/2026: mỗi câu khách nhắn, nhân sự AI soạn một bản nháp; chủ shop bấm gửi,
 * sửa rồi gửi, hoặc bỏ. "Từ đó case by case Sales AI agent sẽ biết cần làm thế nào cho hiệu quả."
 *
 * GHI LẠI KHÔNG PHẢI LÀ HỌC. Sổ thao tác đã lưu câu máy soạn, câu thật sự gửi và khoảng cách sửa
 * từ lâu — mà không dòng nào trong đó quay lại ảnh hưởng bản nháp kế tiếp. Muốn nó thành học thì
 * phải quyết định một điều mà sổ không tự trả lời được: **chỗ sửa ấy dạy điều gì.**
 *
 * ─── HAI LOẠI SỬA, VÀ CHÚNG ĐI HAI NƠI KHÁC HẲN NHAU ───
 *
 * `GIỌNG` — cùng dữ kiện, khác cách nói. Máy nói "Dạ mẫu này 499.000 ₫ ạ", người sửa thành
 *   "Dạ chị ơi, mẫu này bên em 499k thôi ạ ❤️". Không con số nào đổi. Đây là thứ mô hình HỌC
 *   ĐƯỢC và nên học: đưa lại vài cặp gần nhất làm ví dụ, câu sau nghe giống giọng shop hơn.
 *
 * `DỮ KIỆN` — người nói một điều máy KHÔNG nói: một con số khác, một size khác, một lời hứa mới.
 *   Đây KHÔNG phải lỗi giọng văn. Nó có nghĩa là `decide()` chọn sai việc, mẫu câu thiếu một
 *   thông tin, hoặc ERP chưa có dữ liệu mà người thì có.
 *
 * ─── VÌ SAO KHÔNG ĐƯỢC ĐƯA LOẠI THỨ HAI CHO MÔ HÌNH ───
 *
 * Cả dây chuyền này dựng trên MỘT luật: mô hình chỉ được đổi CÁCH NÓI, mọi con số do máy chủ
 * tính, và `guardGeneratedText()` vứt bản viết nào nhắc một con số lạ. Đưa các cặp sửa-dữ-kiện
 * vào làm ví dụ là dạy mô hình đúng cái nó đang bị cấm — và dạy bằng ví dụ thì hiệu quả hơn hẳn
 * một dòng lời dặn cấm đoán. Vài chục ví dụ kiểu "người đã thêm một con số" sẽ khiến nó tự tin
 * bịa số, rồi cái lưới chặn lại, rồi câu trả lời rơi về mẫu cứng — tệ hơn lúc chưa học.
 *
 * Nên loại `DỮ KIỆN` đi vào HÀNG ĐỢI VIỆC PHẢI SỬA, không đi vào prompt. Mỗi cặp là một chỗ ERP
 * còn thiếu, và sửa ở đó mới làm mọi hội thoại sau tốt lên — chứ không chỉ hội thoại giống nó.
 */
import { moneyMentions } from "@/lib/ai-workforce/agents/sales/generate";

export const EDIT_KINDS = ["SENT_AS_IS", "WORDING", "FACTS", "REWRITE"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export const EDIT_KIND_LABEL: Record<EditKind, string> = {
  SENT_AS_IS: "Gửi nguyên văn",
  WORDING: "Sửa cách nói",
  FACTS: "Sửa dữ kiện — ERP còn thiếu",
  REWRITE: "Viết lại hẳn",
};

/** Chỉ loại `WORDING` được đưa lại cho mô hình làm ví dụ. */
export function feedsTheModel(kind: EditKind): boolean {
  return kind === "WORDING";
}

/**
 * Viết lại hẳn = giữ nguyên dữ kiện nhưng gần như không còn chữ nào của máy.
 *
 * Tách khỏi `WORDING` vì hai cái nói hai điều: sửa vài chữ nghĩa là bản nháp gần đúng; viết lại
 * hẳn nghĩa là bản nháp sai giọng tới mức không cứu được. Gộp lại thì một bản nháp bị vứt trông
 * như một bản nháp "chỉ cần chỉnh nhẹ", và tỷ lệ dùng được nói dối về phía lạc quan.
 */
export const REWRITE_KEEP_RATIO = 0.3;

/** Chuẩn hoá để so CHỮ: bỏ dấu câu, emoji, khoảng trắng thừa, hạ chữ thường. */
function chuanHoa(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DỮ KIỆN của một câu: những thứ KHÔNG được đổi khi chỉ sửa giọng văn.
 *
 * Tiền lấy bằng CHÍNH `moneyMentions()` mà lưới chặn đang dùng — hai bộ đọc số khác nhau sẽ cho
 * hai kết luận khác nhau trên cùng một câu, và cái lỏng hơn sẽ thắng ở một nửa dữ liệu.
 */
export function factsOf(text: string): { money: number[]; sizes: string[]; phones: string[] } {
  const chu = ` ${chuanHoa(text)} `;
  const sizes = [...new Set([...chu.matchAll(/ (\d?x{0,3}(?:s|m|l|xl)|size \d{2,3}) /g)].map((m) => m[1].trim()))].sort();
  const phones = [...new Set([...text.matchAll(/\b0\d{9}\b/g)].map((m) => m[0]))].sort();
  return { money: [...new Set(moneyMentions(text))].sort((a, b) => a - b), sizes, phones };
}

function khacNhau<T>(a: T[], b: T[]): boolean {
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

/**
 * Tỷ lệ TỪ của bản máy còn sống sót trong câu người gửi.
 *
 * ─── CON SỐ KHÔNG PHẢI MỘT TỪ ───
 *
 * Bài kiểm bắt được chỗ này: "Dạ 499.000 ₫ ạ" → "Dạ 499k nha chị" bị chấm là VIẾT LẠI HẲN. Lý do
 * là `chuanHoa()` cắt `499.000` thành hai mẩu `499` và `000`, nên một câu bốn chữ có hai mẩu là số
 * — đổi cách viết tiền thôi đã quét sạch một nửa "số từ" của bản máy.
 *
 * Mà tiền, size và số điện thoại đã được `classifyEdit()` so RIÊNG, bằng chính bộ đọc của lưới
 * chặn, và nhánh này chỉ chạy khi chúng GIỐNG HỆT NHAU. Đếm chúng thêm lần nữa ở đây là để phép đo
 * GIỌNG VĂN bị điều khiển bởi thứ không phải giọng văn.
 *
 * Nên bỏ mẩu toàn chữ số trước khi đo. Tin nhắn chat vốn ngắn, nên mỗi mẩu tính sai kéo tỷ lệ đi
 * rất xa — đây không phải một chỗ làm đẹp con số mà là chỗ quyết định một bản nháp dùng được có bị
 * xếp nhầm vào nhóm "vứt đi" hay không.
 */
export function keepRatio(suggested: string, final: string): number {
  const laChu = (t: string) => Boolean(t) && !/^\d+$/.test(t);
  const tuMay = chuanHoa(suggested).split(" ").filter(laChu);
  if (!tuMay.length) return 0;
  const tuNguoi = new Set(chuanHoa(final).split(" ").filter(laChu));
  return tuMay.filter((t) => tuNguoi.has(t)).length / tuMay.length;
}

export type EditAnalysis = {
  kind: EditKind;
  keepRatio: number;
  /** Dữ kiện người THÊM vào mà máy không có — mỗi cái là một chỗ ERP còn thiếu. */
  factsAdded: string[];
  /** Dữ kiện máy nói mà người bỏ đi. */
  factsRemoved: string[];
  /** Câu đọc được, in thẳng lên màn hình. */
  reason: string;
};

/**
 * Chỗ sửa này dạy điều gì. HÀM THUẦN.
 *
 * Thứ tự các nhánh có chủ ý: DỮ KIỆN xét TRƯỚC độ dài sửa. Người đổi đúng một con số rồi giữ
 * nguyên cả câu là một chỗ sửa RẤT NHỎ về chữ nhưng RẤT LỚN về nghĩa — xếp nó vào "sửa nhẹ" là
 * đúng cách để một lỗ hổng dữ liệu không bao giờ được ai đi sửa.
 */
export function classifyEdit(suggested: string, final: string): EditAnalysis {
  const giu = keepRatio(suggested, final);
  if (!final.trim() || chuanHoa(suggested) === chuanHoa(final)) {
    return { kind: "SENT_AS_IS", keepRatio: 1, factsAdded: [], factsRemoved: [], reason: "Gửi nguyên văn — bản nháp dùng được" };
  }

  const a = factsOf(suggested);
  const b = factsOf(final);
  const them = [
    ...b.money.filter((x) => !a.money.includes(x)).map((x) => `tiền ${x}`),
    ...b.sizes.filter((x) => !a.sizes.includes(x)).map((x) => `size ${x}`),
    ...b.phones.filter((x) => !a.phones.includes(x)).map((x) => `SĐT ${x}`),
  ];
  const bo = [
    ...a.money.filter((x) => !b.money.includes(x)).map((x) => `tiền ${x}`),
    ...a.sizes.filter((x) => !b.sizes.includes(x)).map((x) => `size ${x}`),
    ...a.phones.filter((x) => !b.phones.includes(x)).map((x) => `SĐT ${x}`),
  ];

  if (khacNhau(a.money, b.money) || khacNhau(a.sizes, b.sizes) || khacNhau(a.phones, b.phones)) {
    return {
      kind: "FACTS",
      keepRatio: giu,
      factsAdded: them,
      factsRemoved: bo,
      reason:
        them.length > 0
          ? `Người nói thứ máy KHÔNG có (${them.join(", ")}) — ERP thiếu dữ liệu hoặc luật chọn sai việc, KHÔNG phải lỗi giọng văn`
          : `Người bỏ đi (${bo.join(", ")}) — máy nói thừa, xem lại mẫu câu`,
    };
  }

  if (giu < REWRITE_KEEP_RATIO) {
    return {
      kind: "REWRITE",
      keepRatio: giu,
      factsAdded: [],
      factsRemoved: [],
      reason: `Viết lại hẳn — chỉ còn ${Math.round(giu * 100)}% chữ của máy, bản nháp sai giọng tới mức không cứu được`,
    };
  }

  return {
    kind: "WORDING",
    keepRatio: giu,
    factsAdded: [],
    factsRemoved: [],
    reason: `Cùng dữ kiện, khác cách nói — đây là thứ mô hình học được`,
  };
}

/** Bao nhiêu cặp ví dụ đưa lại cho mô hình trong một lượt soạn. */
export const STYLE_EXAMPLES_MAX = 4;

/**
 * VÍ DỤ ĐI VÀO TIN NHẮN NGƯỜI DÙNG, KHÔNG VÀO PROMPT HỆ THỐNG.
 *
 * Prompt hệ thống ổn định thì đệm được, và đệm là thứ giữ hoá đơn ở mức thấp. Nhét vài cặp ví dụ
 * thay đổi theo ngày vào đó là làm rỗng đệm của MỌI phiên, mỗi ngày — đắt hơn nhiều so với cái
 * lợi của việc học giọng.
 */
export function styleExamplesBlock(pairs: { suggested: string; final: string }[]): string {
  if (!pairs.length) return "";
  const dong = pairs
    .slice(0, STYLE_EXAMPLES_MAX)
    .map((p, i) => `${i + 1}. Máy viết: ${p.suggested}\n   Shop sửa thành: ${p.final}`)
    .join("\n");
  return [
    "",
    "Vài lần trước shop đã sửa lại cách nói của bạn. Học GIỌNG VĂN từ đó — cách xưng hô, độ dài, dấu câu:",
    dong,
    "Những ví dụ này chỉ dạy CÁCH NÓI. Tuyệt đối không mượn con số, size hay lời hứa nào từ chúng.",
  ].join("\n");
}
