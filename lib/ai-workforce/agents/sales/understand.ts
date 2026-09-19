/**
 * BƯỚC 1 — HIỂU: bóc ý định và thực thể từ tin nhắn khách.
 *
 * Nấc LUẬT chạy trước và trong phần lớn trường hợp là đủ: SĐT, size, màu, số lượng, "chốt đơn",
 * "bao nhiêu tiền" đều là những thứ nhận ra được bằng luật, chắc chắn và miễn phí. Chỉ khi luật
 * KHÔNG đủ chắc mới leo lên mô hình.
 *
 * Đầu ra của mô hình BẮT BUỘC qua `UNDERSTANDING_SCHEMA`. Trả rác = không có kết quả, không phải
 * "gần đúng thì lấy tạm" — một thực thể bịa ở đây sẽ đi thẳng vào đơn hàng của khách.
 *
 * HÀM Ở ĐÂY LÀ HÀM THUẦN (trừ `understand` có thể gọi mô hình): không đọc CSDL, không đọc đồng hồ.
 */
import { z } from "zod";
import { normalize, stripHtml } from "@/lib/text";
import { normalizePhone, parseVariantText, productCodeFromText } from "@/lib/constants/landing";
import { CONFIDENCE_FLOOR } from "@/lib/constants/ai";

export const SALES_INTENTS = [
  "GREETING",
  "PRODUCT_QUESTION",
  "PRICE_QUESTION",
  "STOCK_QUESTION",
  "SIZE_QUESTION",
  "SHIPPING_QUESTION",
  "PURCHASE_INTENT",
  "PROVIDE_VARIANT",
  "PROVIDE_CONTACT",
  "PROVIDE_ADDRESS",
  "CONFIRM",
  "REJECT",
  "OBJECTION",
  "COMPLAINT",
  "ASK_HUMAN",
  "AFTER_SALES",
  "OTHER",
] as const;

export type SalesIntent = (typeof SALES_INTENTS)[number];


/**
 * Ô CHỮ TUỲ CHỌN — nhận `null`, `undefined` và chuỗi, luôn ra chuỗi.
 *
 * ĐO ĐƯỢC 15/09/2026 trên mẻ thật: `.default("")` của zod CHỈ áp khi khoá VẮNG MẶT, không áp khi
 * giá trị là `null`. Mô hình trả `"productText": null` — đúng cách JSON diễn đạt "trống" — nên
 * lược đồ báo `invalid_type`, MỌI lượt ECONOMY hỏng, leo lên STRONG, STRONG hỏng nốt, rồi cả dây
 * chuyền rơi về HUMAN.
 *
 * Hậu quả đo được: 25 lượt gọi mô hình, 48% đi lên model mạnh, và chỉ 1/18 hội thoại có kết quả
 * hiểu dùng được. Tức là trả tiền gấp đôi để nhận về con số không.
 *
 * Bắt mô hình phải gửi `""` thay vì `null` là bắt nó tuân một quy ước mà chính JSON không có. Chấp
 * nhận cả hai ở CỔNG VÀO rồi quy về một dạng là việc của lược đồ, không phải của lời dặn.
 */
const oChu = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? "");

/**
 * Ô SỐ TUỲ CHỌN — nhận số, chuỗi chứa số, `null`, `undefined`; luôn ra `number | null`.
 *
 * ĐO ĐƯỢC 15/09/2026 trên mẻ sạch: lỗi lược đồ còn lại duy nhất là `entities.quantity` —
 * `expected "number"`. Mô hình gửi một CHUỖI. Cũng như `null` ở ô chữ, đây là khác biệt về CÁCH
 * VIẾT, không phải về nghĩa: `"2"` và `2` là cùng một số lượng.
 *
 * NHƯNG CHỈ NHẬN SỐ THUẦN. `"2 cái"`, `"vài"`, `"1m58"` là chữ cần SUY DIỄN — ở đó câu trả lời
 * đúng là CHƯA BIẾT, để máy đi hỏi khách, chứ không phải một con số đoán ra rồi ghi vào đơn.
 *
 * Ngoài khoảng cho phép cũng ra CHƯA BIẾT chứ không làm hỏng cả lược đồ: một ô vô lý
 * (`quantity: 500`) không phải lý do để vứt toàn bộ phần hiểu của lượt đó rồi chuyển người.
 */
const oSo = (min: number, max: number, nguyen = false) =>
  z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined) return null;
      const so = typeof v === "number" ? v : /^-?\d+(?:[.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(",", ".")) : Number.NaN;
      if (!Number.isFinite(so)) return null;
      if (nguyen && !Number.isInteger(so)) return null;
      if (so < min || so > max) return null;
      return so;
    });

/** Lược đồ đầu ra — dùng cho CẢ nấc luật lẫn nấc mô hình, để hai nấc không bao giờ lệch hình dạng. */
export const UNDERSTANDING_SCHEMA = z.object({
  intents: z.array(z.enum(SALES_INTENTS)).min(1).max(4),
  entities: z.object({
    productText: oChu(200),
    productCode: oChu(20),
    size: oChu(10),
    color: oChu(40),
    quantity: oSo(1, 20, true),
    phone: oChu(20),
    address: oChu(400),
    province: oChu(80),
    heightCm: oSo(80, 230),
    weightKg: oSo(20, 200),
    bustCm: oSo(40, 200),
    waistCm: oSo(30, 200),
    hipCm: oSo(40, 220),
  }),
  confidence: z.number().min(0).max(1),
  /*
    CĂN CỨ — câu/cụm đã dẫn tới kết luận, để người đọc lại hiểu vì sao máy nghĩ vậy.

    NHẬN NHIỀU KIỂU rồi quy về chuỗi. Đo 15/09/2026: sau khi lược đồ đã nhận `null`, lỗi còn lại
    duy nhất là `evidence` — mô hình trả một MẢNG các cụm ("bao nhiêu", "em"), hợp lý với nghĩa
    "những cụm dẫn tới kết luận", nhưng lược đồ đòi một chuỗi.
    
    Đây là ô GIẢI THÍCH CHO NGƯỜI ĐỌC, không phải dữ liệu nghiệp vụ — không con số nào, không quyết
    định nào đọc nó. Nên quy đổi kiểu ở đây là an toàn, khác hẳn với việc nới lỏng một ô thực thể.
  */
  evidence: z
    .union([z.string(), z.array(z.union([z.string(), z.number()])), z.number()])
    .nullish()
    .transform((v) => (Array.isArray(v) ? v.join(" · ") : v === null || v === undefined ? "" : String(v)).slice(0, 300)),
});

export type Understanding = z.infer<typeof UNDERSTANDING_SCHEMA> & { tier: "RULE" | "ECONOMY" | "STRONG" };

const EMPTY_ENTITIES = {
  productText: "",
  productCode: "",
  size: "",
  color: "",
  quantity: null as number | null,
  phone: "",
  address: "",
  province: "",
  heightCm: null as number | null,
  weightKg: null as number | null,
  bustCm: null as number | null,
  waistCm: null as number | null,
  hipCm: null as number | null,
};

// Từ khoá — viết ở dạng đã chuẩn hoá (không dấu, thường), so khớp TRỌN TỪ qua `normalize()`.
const KEYWORDS: Record<SalesIntent, string[]> = {
  GREETING: ["alo", "hello", "hi shop", "chao shop", "shop oi", "ad oi"],
  PRODUCT_QUESTION: ["mau nay", "san pham nay", "cai nay", "vay nay", "dam nay", "ao nay", "quan nay", "chat lieu", "vai gi", "cao bao nhieu mac vua",
    // ĐIỀU KIỆN MUA BÁN cũng là câu hỏi về sản phẩm. Thiếu chúng thì "Có được kiểm hàng không?"
    // rơi về OTHER và phải gọi mô hình cho một câu có sẵn đáp án trong hồ sơ.
    "kiem hang", "kiem tra hang", "xem hang", "dong kiem", "cod", "thanh toan", "tra tien",
    "chuyen khoan", "co lot", "co day khong", "bao hanh", "doi tra"],
  /*
    "BAO NHIEU" TRẦN LÀ CÂU HỎI GIÁ PHỔ BIẾN NHẤT — và bản trước không có nó.

    Đo 15/09/2026 trên mẻ thật: "Bao nhiêu em?", "bao nhiêu một áo", "bao nhiêu một đằm vậy",
    "báo giá" đều rơi về OTHER ở 0.2 và phải gọi mô hình. Danh sách cũ chỉ có các CỤM DÀI
    ("bao nhieu tien", "gia bao nhieu"), tức là đòi khách viết đủ câu.

    "cho xin gia" chuyển sang đây từ OBJECTION: xin báo giá KHÔNG phải chê đắt.
  */
  PRICE_QUESTION: ["bao nhieu", "bao gia", "bao nhieu tien", "gia bao nhieu", "gia the nao", "gia sao", "nhieu tien", "bn tien", "bnhieu", "may tien", "cho xin gia", "gia bn", "gia nhieu"],
  STOCK_QUESTION: ["con hang", "con size", "con mau", "con khong", "het hang", "con k", "con ko"],
  SIZE_QUESTION: ["size nao", "mac size", "lay size", "size gi", "bang size", "size bao nhieu", "cao 1m", "nang bao nhieu"],
  SHIPPING_QUESTION: ["phi ship", "tien ship", "freeship", "free ship", "ship bao nhieu", "bao lau nhan", "may ngay nhan", "giao bao lau", "ship covid"],
  /*
    "LẤY CHO CHỊ …" LÀ CÂU CHỐT ĐƠN PHỔ BIẾN NHẤT, VÀ NÓ TỪNG KHÔNG NẰM Ở ĐÂY.

    Shop thời trang xưng hô "chị / anh / mình", nên câu mua hàng thật hiếm khi là "mua" — nó là
    "lấy cho chị màu đỏ đô size XL". Bản trước chỉ bắt "lay 1" / "lay cai nay" / "em lay", nên câu
    ấy chỉ ra đúng `PROVIDE_VARIANT`: máy biết khách chọn gì mà KHÔNG biết khách muốn mua. Giai
    đoạn đứng nguyên ở `PRODUCT_IDENTIFIED`, và bảng việc của giai đoạn ấy trả về HỎI MÀU — đúng
    cái màu khách vừa nói. Ca hồi quy `seed-i-lay-cho-chi` khoá lại chỗ này.

    Nhận rộng ở đây KHÔNG mở đường cho một đơn ma: ý muốn mua chỉ đẩy giai đoạn đi tiếp, còn lên
    đơn vẫn phải qua xác nhận CÓ NGỮ CẢNH và đủ năm điều kiện máy chủ.
  */
  PURCHASE_INTENT: ["chot don", "chot cho em", "lay 1", "lay 2", "lay cai nay", "dat hang", "dat 1", "mua", "order", "ship cho em", "gui cho em", "lay em", "em lay", "lay cho chi", "lay cho anh", "lay cho em", "lay cho minh", "cho chi lay", "chi lay", "dat giup", "dat cho chi", "dat cho em", "chot mau"],
  PROVIDE_VARIANT: [],
  PROVIDE_CONTACT: ["so dien thoai", "sdt cua em", "sdt em", "lien he em"],
  PROVIDE_ADDRESS: ["dia chi", "gui ve", "giao ve", "so nha", "thon", "xa", "phuong", "quan", "huyen", "tinh", "thanh pho"],
  /*
    BỎ "duoc" · "dung" · "van" KHỎI DANH SÁCH XÁC NHẬN.

    Chúng là từ thường trong câu tiếng Việt, không phải tiếng đồng ý. Đo được: "Có được kiểm hàng
    không?" khớp "duoc" và ra CONFIRM ở 0.8 — một CÂU HỎI bị đọc thành XÁC NHẬN CHỐT ĐƠN. Đó đúng
    là loại dương tính giả mà cả nền tảng này sinh ra để chặn.

    Giữ lại các tiếng đồng ý thật ("vang", "ukm", "um", "dung roi", "chuan roi"): chúng hiếm khi
    xuất hiện ngoài nghĩa đồng ý. Và bộ gác ngữ cảnh (`checkContextualConfirmation`) vẫn là lớp
    chặn cuối — nhưng một lớp chặn không phải lý do để tầng dưới nó được sai.
  */
  CONFIRM: ["ok", "oke", "okie", "dong y", "dung roi", "chuan roi", "vang", "ukm", "um", "chot", "yes", "xac nhan"],
  REJECT: ["thoi", "khong lay nua", "ko lay nua", "khong mua", "ko mua", "de sau", "huy", "khong can", "ko can"],
  OBJECTION: ["dat qua", "mac qua", "sao dat the", "giam gia", "bot chut", "re hon", "cho re", "shop khac re"],
  /*
    "HÀNG BỊ LỖI, TÔI MUỐN TRẢ LẠI" — câu khiếu nại phổ biến nhất, và nó từng không khớp gì cả.

    ĐO 19/09/2026 trên dây chuyền thật chạy cục bộ: câu ấy chuẩn hoá thành " hang bi loi toi muon
    tra lai ". Danh sách cũ có "hang loi" (tiếng Việt chen chữ "bị" vào giữa) và "tra hang" (người
    ta nói "trả lại", không nói "trả hàng"). Hai từ khoá, hai lần trượt, và kết quả là máy chuyển
    người với lý do LOW_CONFIDENCE — "không hiểu khách muốn gì".

    Chuyển người vẫn đúng, nên KHÔNG có khách nào bị trả lời sai. Nhưng lý do thì sai, và lý do là
    thứ quyết định việc chạy về phòng nào và nằm ở ô nào trong báo cáo. Một ca khiếu nại đội lốt
    "máy không hiểu" sẽ được đọc như một lỗi của mô hình thay vì một việc của đội chăm sóc.

    Chỉ thêm những cụm KHÔNG THỂ hiểu nhầm. Cố ý BỎ "sai màu" / "sai size": khách tự nhận "em chọn
    sai size rồi" lúc đang chọn mẫu mã là một câu bán hàng bình thường, và đọc nó thành khiếu nại
    sẽ ném một đơn sắp chốt sang hàng đợi chăm sóc.
  */
  COMPLAINT: ["kem chat luong", "lua dao", "hang loi", "hang bi loi", "bi loi", "hang hong", "hang bi hong", "giao sai", "gui sai", "rach", "ban qua", "that vong", "bao xau", "khieu nai"],
  ASK_HUMAN: ["gap nhan vien", "nguoi that", "cho gap ad", "noi chuyen voi nguoi", "bot a", "may tra loi"],
  AFTER_SALES: ["doi size", "doi mau", "tra hang", "tra lai", "muon tra", "doi tra", "doi hang", "muon doi hang", "hoan tien", "don cua em dau", "khi nao giao", "chua nhan duoc", "van don", "buu ta", "shipper"],
  OTHER: [],
};

/** Ý định BẮT BUỘC chuyển người — máy không được tự xử, bất kể nó tự tin đến đâu. */
export const HUMAN_ONLY_INTENTS = new Set<SalesIntent>(["COMPLAINT", "ASK_HUMAN", "AFTER_SALES"]);

/** `normalize()` bọc chuỗi bằng khoảng trắng nên so khớp TRỌN TỪ chỉ là so chuỗi con của dạng đã bọc. */
function hits(normalized: string, words: string[]): string | null {
  for (const word of words) if (normalized.includes(` ${word} `)) return word;
  return null;
}

/** SĐT Việt Nam trong một câu tự do. Nhận cả dạng có dấu chấm / khoảng trắng giữa các cụm số. */
export function findPhone(text: string): string {
  const candidates = text.match(/(?:\+?84|0)[\s.\-]?\d(?:[\s.\-]?\d){8,9}/g) ?? [];
  for (const raw of candidates) {
    const phone = normalizePhone(raw);
    if (/^0\d{9}$/.test(phone)) return phone;
  }
  return "";
}

/** Chiều cao / cân nặng khách tự khai: "1m58 47kg", "158cm 47 kg", "cao 1.58 nặng 47". */
export function findBody(text: string): { heightCm: number | null; weightKg: number | null } {
  const flat = text.toLowerCase().replace(/,/g, ".");
  let heightCm: number | null = null;
  let weightKg: number | null = null;
  const mMeter = /(\d)\s*m\s*(\d{1,2})\b/.exec(flat);
  const mDecimal = /\b(1\.[4-9]\d?)\s*m?\b/.exec(flat);
  const mCm = /\b(1[3-9]\d|2[0-2]\d)\s*cm\b/.exec(flat);
  if (mMeter) heightCm = Number(mMeter[1]) * 100 + Number(mMeter[2].padEnd(2, "0"));
  else if (mCm) heightCm = Number(mCm[1]);
  else if (mDecimal) heightCm = Math.round(Number(mDecimal[1]) * 100);
  const mKg = /\b(\d{2,3})\s*(?:kg|ki|can)\b/.exec(flat) ?? /\bnang\s*(\d{2,3})\b/.exec(normalize(flat));
  if (mKg) weightKg = Number(mKg[1]);
  return {
    heightCm: heightCm !== null && heightCm >= 80 && heightCm <= 230 ? heightCm : null,
    weightKg: weightKg !== null && weightKg >= 20 && weightKg <= 200 ? weightKg : null,
  };
}

/**
 * Vòng ngực / eo / mông khách tự khai: "vòng ngực 88", "eo 68 mông 92".
 * Không bắt được thì `null` = CHƯA BIẾT — máy gợi ý size sẽ đòi thêm, không tự điền.
 */
export function findCircumferences(text: string): { bustCm: number | null; waistCm: number | null; hipCm: number | null } {
  const n = normalize(text);
  const read = (pattern: RegExp, min: number, max: number): number | null => {
    const m = pattern.exec(n);
    if (!m) return null;
    const value = Number(m[1]);
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
  };
  return {
    bustCm: read(/\b(?:vong )?nguc\s*(\d{2,3})\b/, 40, 200),
    waistCm: read(/\b(?:vong )?eo\s*(\d{2,3})\b/, 30, 200),
    hipCm: read(/\b(?:vong )?mong\s*(\d{2,3})\b/, 40, 220),
  };
}

/** Số lượng khách nói: "lấy 2 cái", "cho em 3 bộ". Không bắt được thì null = CHƯA BIẾT, không phải 1. */
export function findQuantity(text: string): number | null {
  const n = normalize(text);
  const m = /\b(?:lay|mua|dat|order|cho em|gui)\s*(\d{1,2})\b/.exec(n) ?? /\b(\d{1,2})\s*(?:cai|bo|chiec|san pham|sp|chiec)\b/.exec(n);
  if (!m) return null;
  const value = Number(m[1]);
  return value >= 1 && value <= 20 ? value : null;
}

/**
 * MÀU SẮC — ĐỌC TRÊN CHỮ CÓ DẤU, VÌ BỎ DẤU LÀ TỰ TẠO RA VA CHẠM.
 *
 * SỰ CỐ ĐO ĐƯỢC BẰNG BỘ CA HỒI QUY (19/09/2026, ca `seed-d-vang-khong-mat-mau-ma`): khách chốt
 * "màu đỏ đô size XL" rồi nhắn "vâng". `normalize()` bỏ dấu nên "vâng" thành "vang", trùng khít
 * với "vàng" — máy ghi nhận khách vừa ĐỔI SANG MÀU VÀNG, đẩy `PROVIDE_VARIANT` vào ý định và nâng
 * độ tin lên 0,85. Mẫu mã đã chốt bị xoá vì không còn màu nào khớp. Một chữ đồng ý biến thành một
 * kiện hàng sai màu.
 *
 * Đó không phải một va chạm lẻ. Bỏ dấu còn cho: "đó" → "do" (= đỏ) · "đến" → "den" (= đen) ·
 * "nâu" ↔ "nấu" · "tìm" → "tim" (= tím). Toàn từ thường gặp trong chat bán hàng.
 *
 * LUẬT THAY THẾ, hai đường và chỉ hai:
 *   1. Có CHỈ DẤU "màu" / "color" đứng trước ⇒ nhận cả cách viết không dấu ("màu do", "mau den").
 *      Chỉ dấu là bằng chứng khách đang nói về màu, nên không còn chỗ cho va chạm.
 *   2. Không có chỉ dấu ⇒ đòi ĐÚNG CHÍNH TẢ CÓ DẤU ("đỏ", "vàng"). "vâng" không bao giờ là "vàng".
 *
 * Viết tắt không dấu mà không có chỉ dấu ⇒ trả rỗng = CHƯA BIẾT, và máy đi hỏi lại. Nhánh sai rơi
 * về phía HỎI THÊM: hỏi lại màu tốn một lượt, gửi nhầm màu tốn một kiện hàng và một lần hoàn.
 *
 * TRẢ VỀ MÀU GỐC, KHÔNG KÈM TỪ BỔ NGHĨA. Bản trước dùng thẳng `parseVariantText()` — hàm viết cho
 * Ô BIẾN THỂ của Google Sheet, nơi đầu vào là "Size M | Màu Đỏ Đô". Trên câu chat tự do, biểu thức
 * `([^,;|]+)` của nó nuốt trọn phần đuôi: "màu đỏ đô size XL" ra màu `"đỏ đô size XL"`, và không
 * mẫu mã nào trong ERP mang cái tên ấy — hội thoại đứng luôn ở bước chọn mẫu mã. Trả "Đỏ" thì phép
 * khớp mẫu mã (`v.color.includes(state.color)`) vẫn tìm đúng "Đỏ đô", rồi `applyUnderstanding` ghi
 * lại tên màu ĐÚNG THEO DANH MỤC. Danh mục là nơi giữ chính tả của màu, không phải câu của khách.
 */
const COLOR_WORDS = ["den", "trang", "do", "nau", "xanh", "vang", "hong", "tim", "be", "kem", "xam", "cam", "ghi", "reu", "navy"];
const COLOR_LABEL: Record<string, string> = {
  den: "Đen", trang: "Trắng", do: "Đỏ", nau: "Nâu", xanh: "Xanh", vang: "Vàng", hong: "Hồng",
  tim: "Tím", be: "Be", kem: "Kem", xam: "Xám", cam: "Cam", ghi: "Ghi", reu: "Rêu", navy: "Navy",
};

/** Chính tả CÓ DẤU của từng màu — đường nhận màu khi câu không có chỉ dấu "màu". */
const COLOR_SPELLINGS: [string, string][] = [
  ["đen", "Đen"], ["trắng", "Trắng"], ["đỏ", "Đỏ"], ["nâu", "Nâu"], ["xanh", "Xanh"],
  ["vàng", "Vàng"], ["hồng", "Hồng"], ["tím", "Tím"], ["kem", "Kem"], ["xám", "Xám"],
  ["cam", "Cam"], ["ghi", "Ghi"], ["rêu", "Rêu"], ["navy", "Navy"],
];

/**
 * Hạ chữ thường và tách từ NHƯNG GIỮ NGUYÊN DẤU. Khác `normalize()` đúng ở chỗ đó, và đó là toàn
 * bộ lý do hàm này tồn tại.
 *
 * "be" cố ý KHÔNG nằm trong bảng chính tả có dấu: nó trùng với "bé" chỉ sau khi bỏ dấu, nhưng bản
 * thân "be" cũng là một tiếng đệm quá phổ biến. Màu Be chỉ nhận qua đường có chỉ dấu ("màu be").
 */
function padKeepMarks(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

export function findColor(text: string): string {
  const padded = padKeepMarks(text);
  // 1. Có chỉ dấu ⇒ lấy ĐÚNG MỘT từ ngay sau nó, rồi tra bảng. Một từ, không phải phần đuôi câu.
  const marked = / (?:màu|mau|color) ([^ ]+) /u.exec(padded)?.[1] ?? "";
  if (marked) {
    const bare = normalize(marked).trim();
    if (COLOR_WORDS.includes(bare)) return COLOR_LABEL[bare];
  }
  // 2. Không có chỉ dấu ⇒ đòi đúng chính tả có dấu.
  for (const [spelling, label] of COLOR_SPELLINGS) if (padded.includes(` ${spelling} `)) return label;
  return "";
}

/**
 * SIZE — và "G" cắt ra từ "size gì" KHÔNG phải một size.
 *
 * SỰ CỐ ĐO ĐƯỢC (ca `seed-b-hoi-size-co-bang`): khách hỏi "mặc size gì em". `parseVariantText()`
 * chạy biểu thức `size\s*[:：]?\s*([A-Za-z0-9]{1,4})` — lớp ký tự ấy không nhận chữ "ì" có dấu nên
 * nó dừng lại sau một ký tự và trả về size `"G"`. Máy ghi nhận khách vừa chọn size G, một size
 * không tồn tại trong bất kỳ danh mục nào; phép khớp mẫu mã sau đó không bao giờ ra kết quả.
 *
 * Không sửa `parseVariantText()`: hàm ấy phục vụ Ô BIẾN THỂ của Google Sheet, nơi đầu vào là chuỗi
 * có cấu trúc và nó đang đúng. Chỗ phải chặn là ĐẦU RA khi đọc câu chat tự do — một chuỗi chỉ được
 * nhận là size khi nó THẬT SỰ là một size.
 */
const SIZE_WORDS = ["xs", "s", "m", "l", "xl", "xxl", "xxxl", "2xl", "3xl", "4xl"];

/** Size hàng may mặc: hoặc một size chữ, hoặc một size số (28–60 — quần, giày, áo dài). */
function isRealSize(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return false;
  if (SIZE_WORDS.includes(v)) return true;
  const n = Number(v);
  return /^\d{2}$/.test(v) && n >= 20 && n <= 60;
}

/**
 * TỪ DẪN cho size MỘT CHỮ CÁI. "l" và "m" đứng trơ trọi giữa câu thì không phân biệt được với chữ
 * viết tắt; đứng ngay sau một trong những từ này thì không còn mơ hồ.
 */
const TU_DAN_SIZE = ["size", "so", "lay", "mac", "chon", "doi", "sang", "mua"];

export function findSize(text: string): string {
  const explicit = parseVariantText(text).size;
  if (isRealSize(explicit)) return explicit.toUpperCase();
  const n = normalize(text);
  // "m" và "l" là chữ cái thường gặp; chỉ nhận khi đứng một mình hoặc sau chữ "size"/"số".
  const m = /\bsize\s+([a-z0-9]{1,4})\b/.exec(n) ?? /\bso\s+([a-z0-9]{1,4})\b/.exec(n);
  if (m && isRealSize(m[1])) return m[1].toUpperCase();
  const words = n.trim().split(/\s+/);
  if (words.length === 1 && isRealSize(words[0])) return words[0].toUpperCase();

  /*
    "LẤY XL" — CÂU CHỌN SIZE NGẮN NHẤT, VÀ NÓ TỪNG KHÔNG ĐƯỢC ĐỌC.

    Bản trước chỉ nhận size khi có chữ "size"/"số" đứng trước, hoặc khi cả tin nhắn CHỈ có đúng một
    từ. "lấy XL" có hai từ và không có chữ "size", nên nó rơi ra: máy ghi nhận khách chưa chọn size
    và đi hỏi lại đúng cái size khách vừa nói.

    HAI ĐƯỜNG, và chúng khác nhau vì mức mơ hồ khác nhau:

    1. Size NHIỀU CHỮ CÁI (xs · xl · xxl · 2xl …) đứng ở đâu cũng nhận. Không từ tiếng Việt nào
       trùng với chúng, nên không có gì để nhầm.

    2. Size MỘT CHỮ CÁI (s · m · l) đòi một TỪ DẪN ngay trước. "l" giữa câu có thể là bất cứ thứ gì;
       "sang l" thì không.

    CỐ Ý KHÔNG nhận size SỐ ở đường này. Size số (28 · 30 · 42) chỉ nhận qua chữ "size"/"số" đứng
    trước, vì một số hai chữ số trôi nổi trong câu thường là tiền hoặc cân nặng: "giá 50 nghìn" mà
    đọc thành size 50 thì máy ghi một lựa chọn khách chưa hề đưa ra.
  */
  const nhieuChu = words.find((w) => w.length >= 2 && SIZE_WORDS.includes(w));
  if (nhieuChu) return nhieuChu.toUpperCase();
  const motChu = words.findIndex((w, i) => i > 0 && SIZE_WORDS.includes(w) && TU_DAN_SIZE.includes(words[i - 1]));
  if (motChu > 0) return words[motChu].toUpperCase();
  return "";
}

/**
 * NHẬN DẠNG BẰNG LUẬT. Trả về độ tin: 1 từ khoá mạnh là chắc; không khớp gì là 0 và phải leo nấc.
 */
export function understandByRule(rawText: string): Understanding {
  const text = stripHtml(rawText);
  const n = normalize(text);
  const intents: SalesIntent[] = [];
  const evidence: string[] = [];
  for (const intent of SALES_INTENTS) {
    if (intent === "OTHER") continue;
    const hit = hits(n, KEYWORDS[intent]);
    if (hit) {
      intents.push(intent);
      evidence.push(hit);
    }
  }

  /*
    MỘT CÂU HỎI KHÔNG BAO GIỜ LÀ MỘT LỜI XÁC NHẬN.

    Bỏ từ khoá mơ hồ khỏi CONFIRM đã chặn phần lớn, nhưng không chặn được mọi cách đặt câu hỏi.
    Dấu hiệu nghi vấn ("...không?", "...chưa?", dấu hỏi cuối câu) là bằng chứng ĐỘC LẬP với danh
    sách từ khoá, nên nó bắt được cả những câu chưa ai nghĩ tới.
  */
  // "a" (ạ) KHÔNG nằm trong danh sách: nó là tiếng lịch sự cuối câu tiếng Việt, có mặt ở cả câu
  // hỏi lẫn câu khẳng định. Đưa nó vào thì "vâng ạ" — một tiếng đồng ý rõ ràng — bị đọc thành câu
  // hỏi và mất luôn ý định CONFIRM.
  const laCauHoi = /\?\s*$/.test(text.trim()) || /\b(khong|ko|chua)\s*\?*\s*$/.test(n.trim());
  if (laCauHoi) {
    const i = intents.indexOf("CONFIRM");
    if (i >= 0) {
      intents.splice(i, 1);
      evidence.splice(i, 1);
    }
  }

  const phone = findPhone(text);
  const size = findSize(text);
  const color = findColor(text);
  const quantity = findQuantity(text);
  const body = findBody(text);
  const circumferences = findCircumferences(text);
  const productCode = productCodeFromText(text);

  if (phone && !intents.includes("PROVIDE_CONTACT")) intents.push("PROVIDE_CONTACT");
  // Khách nhắn "size L" / "màu đỏ" / "lấy 2 cái" là đang CHỌN MẪU MÃ. Không có từ khoá nào bắt
  // được việc đó — chính THỰC THỂ bóc ra mới là bằng chứng, nên ý định phải suy từ thực thể.
  if ((size || color || quantity !== null) && !intents.includes("PROVIDE_VARIANT")) intents.push("PROVIDE_VARIANT");
  const hasMeasurement = Boolean(body.heightCm || body.weightKg || circumferences.bustCm || circumferences.waistCm || circumferences.hipCm);
  if (hasMeasurement && !intents.includes("SIZE_QUESTION")) intents.push("SIZE_QUESTION");
  // Địa chỉ: ba mảnh trở lên phân tách bởi dấu phẩy và có chữ số nhà là dấu hiệu đủ mạnh.
  const looksLikeAddress = text.split(",").length >= 3 && /\d/.test(text) && text.trim().length >= 15;
  if (looksLikeAddress && !intents.includes("PROVIDE_ADDRESS")) intents.push("PROVIDE_ADDRESS");

  if (!intents.length) intents.push("OTHER");

  // Độ tin: từ khoá càng rõ, thực thể càng cứng (SĐT) thì càng chắc. "OTHER" trơ trọi là KHÔNG chắc.
  let confidence = 0;
  if (phone) confidence = Math.max(confidence, 0.95);
  if (evidence.length >= 2) confidence = Math.max(confidence, 0.9);
  else if (evidence.length === 1) confidence = Math.max(confidence, 0.8);
  if (looksLikeAddress) confidence = Math.max(confidence, 0.85);
  // Thực thể bóc được là bằng chứng MẠNH HƠN từ khoá: "size L" không khớp từ khoá nào nhưng nói
  // rõ hơn mọi từ khoá rằng khách đang chọn gì. Chấm điểm theo từ khoá thôi thì câu ấy rơi xuống
  // "không hiểu" và cả cuộc bán hàng bị chuyển người ngay ở lượt thứ hai.
  if (size || color) confidence = Math.max(confidence, 0.85);
  if (quantity !== null) confidence = Math.max(confidence, 0.8);
  if (hasMeasurement) confidence = Math.max(confidence, 0.85);
  if (intents.length === 1 && intents[0] === "OTHER") confidence = 0.2;

  return {
    intents: intents.slice(0, 4),
    entities: {
      ...EMPTY_ENTITIES,
      productText: text.slice(0, 200),
      productCode,
      size,
      color,
      quantity,
      phone,
      address: looksLikeAddress ? text.trim().slice(0, 400) : "",
      province: "",
      heightCm: body.heightCm,
      weightKg: body.weightKg,
      ...circumferences,
    },
    confidence,
    evidence: evidence.join(", ").slice(0, 300),
    tier: "RULE",
  };
}

/** Luật đã đủ chắc để KHỎI gọi mô hình chưa. */
export function ruleIsEnough(understanding: Understanding): boolean {
  return understanding.confidence >= CONFIDENCE_FLOOR.RULE;
}

/**
 * Gộp kết quả của mô hình lên trên kết quả luật: LUẬT THẮNG ở những thực thể cứng
 * (SĐT, size, màu, số lượng) vì chúng nhận ra được chắc chắn; mô hình chỉ bổ sung phần luật để
 * trống. Không bao giờ để mô hình ghi đè một SĐT mà luật đã đọc được từ chính tin nhắn.
 */
export function mergeUnderstanding(rule: Understanding, model: z.infer<typeof UNDERSTANDING_SCHEMA>, tier: "ECONOMY" | "STRONG"): Understanding {
  return {
    intents: model.intents.length ? model.intents : rule.intents,
    entities: {
      productText: rule.entities.productText || model.entities.productText,
      productCode: rule.entities.productCode || model.entities.productCode,
      size: rule.entities.size || model.entities.size,
      color: rule.entities.color || model.entities.color,
      quantity: rule.entities.quantity ?? model.entities.quantity,
      phone: rule.entities.phone || normalizePhone(model.entities.phone),
      address: rule.entities.address || model.entities.address,
      province: rule.entities.province || model.entities.province,
      heightCm: rule.entities.heightCm ?? model.entities.heightCm,
      weightKg: rule.entities.weightKg ?? model.entities.weightKg,
      bustCm: rule.entities.bustCm ?? model.entities.bustCm,
      waistCm: rule.entities.waistCm ?? model.entities.waistCm,
      hipCm: rule.entities.hipCm ?? model.entities.hipCm,
    },
    confidence: Math.max(rule.confidence, model.confidence),
    evidence: [rule.evidence, model.evidence].filter(Boolean).join(" · ").slice(0, 300),
    tier,
  };
}

/** Lời dặn cho mô hình ở bước hiểu. KHÔNG chứa bí mật, không chứa giá, không chứa tồn kho. */
export function understandSystemPrompt(): string {
  return [
    "Bạn là bộ bóc ý định cho một shop thời trang Việt Nam bán qua Facebook.",
    "Đọc MỘT tin nhắn của khách và trả về JSON thuần theo đúng lược đồ, không thêm lời dẫn.",
    `Trường "intents": mảng, mỗi phần tử là một trong ${SALES_INTENTS.join(", ")}.`,
    'Trường "entities": productText, productCode, size, color, quantity, phone, address, province, heightCm, weightKg, bustCm, waistCm, hipCm.',
    'Trường "confidence": số 0–1. Không chắc thì để thấp, KHÔNG đoán bừa.',
    'Trường "evidence": trích đúng cụm chữ trong tin nhắn đã dẫn tới kết luận.',
    "TUYỆT ĐỐI không bịa số điện thoại, địa chỉ, giá tiền hay tồn kho. Không có thì để rỗng / null.",
  ].join("\n");
}
