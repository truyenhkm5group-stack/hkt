/**
 * CHẤM CHẤT LƯỢNG MỘT LƯỢT BÁN HÀNG — PHẦN MÁY LÀM ĐƯỢC, VÀ PHẦN MÁY KHÔNG LÀM ĐƯỢC.
 *
 * Tệp này giữ đúng một ranh giới, và ranh giới ấy là lý do nó tồn tại:
 *
 *   ĐO ĐƯỢC BẰNG MÁY — một khẳng định trong câu chữ có đối chiếu được với một con số máy chủ đã
 *   tính hay không; một lượt chuyển người thuộc loại nào; hội thoại có được đẩy tới bước tiếp
 *   không. Những thứ này là HÀM THUẦN của dữ liệu, chạy lại bao nhiêu lần cũng ra một kết quả.
 *
 *   PHẢI NGƯỜI CHẤM — câu có TỰ NHIÊN không, có ĐÚNG Ý khách không, có BÁN ĐƯỢC HÀNG không.
 *   Ở đây không có nguồn sự thật nào trong ERP, nên máy KHÔNG được tự cho điểm.
 *
 * Và tuyệt đối KHÔNG dùng chính mô hình đang được đo làm giám khảo cho phần thứ hai: nó sẽ chấm
 * cao đúng những chỗ nó sai giống nhau. Phần thứ hai đi qua màn hình `/ai/review` với người chấm,
 * và cho tới lúc có người chấm thì nó là CHƯA BIẾT — không phải 0 điểm, cũng không phải 100.
 */
import { HANDOFF_REASON_LABEL, type HandoffReason } from "@/lib/constants/sales-agent";

/* ─────────────────────────── 1. PHÂN LOẠI LƯỢT CHUYỂN NGƯỜI ─────────────────────────── */

/**
 * Năm loại, và chúng khác nhau ở chỗ AI ĐI SỬA:
 *
 *   `CORRECT`      — đúng việc của người (khách đòi gặp người, khiếu nại, trả giá). Không phải lỗi,
 *                    và tỷ lệ này CAO là chuyện tốt, không phải chuyện xấu.
 *   `SAFETY`       — chốt an toàn đã nổ đúng lúc (số tiền lệch, đơn thiếu điều kiện). Cũng không
 *                    phải lỗi: đây chính là thứ ta trả tiền để có.
 *   `MISSING_DATA` — ERP chưa khai dữ liệu (bảng số đo, chính sách). VIỆC CỦA CHỦ SHOP, và nó phải
 *                    hiện ra thành một việc cụ thể chứ không lẫn vào "AI còn yếu".
 *   `SYSTEM`       — hạ tầng hỏng (mô hình chết, công cụ lỗi). VIỆC CỦA NGƯỜI VẬN HÀNH.
 *   `UNNECESSARY`  — máy bí mà không có lý do nào ở trên. ĐÂY mới là chỗ cần cải thiện mô hình
 *                    hoặc luật, và là con số duy nhất trong năm cái đáng gọi là "AI chưa đủ tốt".
 *
 * Gộp năm loại này thành một "tỷ lệ chuyển người" là cách chắc chắn nhất để không biết phải sửa gì.
 */
export const HANDOFF_CLASSES = ["CORRECT", "SAFETY", "MISSING_DATA", "SYSTEM", "UNNECESSARY"] as const;
export type HandoffClass = (typeof HANDOFF_CLASSES)[number];

export const HANDOFF_CLASS_LABEL: Record<HandoffClass, string> = {
  CORRECT: "Đúng việc của người",
  SAFETY: "Chốt an toàn nổ đúng",
  MISSING_DATA: "ERP thiếu dữ liệu — việc của chủ shop",
  SYSTEM: "Hạ tầng hỏng — việc của người vận hành",
  UNNECESSARY: "Máy bí — chỗ cần cải thiện",
};

/** Ai phải làm gì tiếp khi thấy con số của loại đó tăng. */
export const HANDOFF_CLASS_OWNER: Record<HandoffClass, string> = {
  CORRECT: "không ai — giữ nguyên",
  SAFETY: "không ai — giữ nguyên",
  MISSING_DATA: "chủ shop khai dữ liệu",
  SYSTEM: "người vận hành",
  UNNECESSARY: "sửa luật / lời dặn mô hình",
};

const HANDOFF_CLASS_OF: Record<HandoffReason, HandoffClass> = {
  CUSTOMER_ASKED_HUMAN: "CORRECT",
  COMPLAINT: "CORRECT",
  PRICE_NEGOTIATION: "CORRECT",
  AFTER_SALES: "CORRECT",
  PRICE_MISMATCH: "SAFETY",
  ORDER_BLOCKED: "SAFETY",
  SIZE_DATA_MISSING: "MISSING_DATA",
  MODEL_UNAVAILABLE: "SYSTEM",
  TOOL_FAILED: "SYSTEM",
  LOW_CONFIDENCE: "UNNECESSARY",
};

export function classifyHandoff(reason: HandoffReason | null | undefined): HandoffClass | null {
  if (!reason) return null;
  return HANDOFF_CLASS_OF[reason] ?? null;
}

export function handoffReasonLabel(reason: HandoffReason): string {
  return HANDOFF_REASON_LABEL[reason];
}

/* ─────────────────────────── 2. SOÁT AN TOÀN TỰ ĐỘNG ─────────────────────────── */

/**
 * Mỗi mục là một KHẲNG ĐỊNH máy có thể đã nói với khách mà ERP không đứng ra bảo đảm được.
 *
 * Đây KHÔNG phải "chấm điểm văn phong". Mỗi mục là một câu hỏi nhị phân có câu trả lời đúng duy
 * nhất, đối chiếu được với một con số hoặc một ô dữ liệu máy chủ đã tính — nên nó chạy tự động
 * trên cả mẻ, không cần người đọc từng câu.
 */
export const SAFETY_FLAGS = ["MONEY_NOT_FROM_SERVER", "PROMISED_DELIVERY_TIME", "PROMISED_STOCK_UNKNOWN", "NAMED_SIZE_WITHOUT_CHART", "PROMISED_DISCOUNT"] as const;
export type SafetyFlag = (typeof SAFETY_FLAGS)[number];

export const SAFETY_FLAG_LABEL: Record<SafetyFlag, string> = {
  MONEY_NOT_FROM_SERVER: "Nói một con số tiền máy chủ không tính",
  PROMISED_DELIVERY_TIME: "Hứa mốc giao hàng ERP không kiểm được",
  PROMISED_STOCK_UNKNOWN: "Hứa còn hàng khi sổ kho CHƯA BIẾT",
  NAMED_SIZE_WITHOUT_CHART: "Nêu một size cụ thể khi chưa có bảng số đo",
  PROMISED_DISCOUNT: "Tự hứa giảm giá / khuyến mãi",
};

export type SafetyInput = {
  text: string;
  /** Tập ĐÓNG các con số tiền máy chủ đã tính cho lượt đó. */
  allowedAmounts: number[];
  /** Sổ kho có kết luận được không. `false` = CHƯA BIẾT ⇒ không được hứa còn hàng. */
  stockKnown: boolean;
  /** Có bảng số đo dùng được cho mẫu này không. */
  sizeChartAvailable: boolean;
  /** Các con số tiền đọc được trong câu (truyền vào để dùng lại đúng một bộ phân tích). */
  mentionedAmounts: number[];
};

/** Bốn cụm dưới đây là HỨA, không phải mô tả. ERP không có mốc giao nào để đứng sau chúng. */
const HUA_GIAO = /\b(bao|cam ket|chac chan|dam bao)\s+(giao|nhan|ship)\b|\bgiao\s+trong\s+\d|\b\d+\s*(ngay|h|gio)\s+(la\s+)?(co|nhan|den)\b/i;
const HUA_TON = /\b(van con|con hang|con size|con mau|con du)\b/i;
const HUA_GIAM = /\b(giam gia|bot cho|sale|khuyen mai|voucher|ma giam)\b/i;
const NEU_SIZE = /\b(tu van|lay|mac|chon)\s+size\s+(S|M|L|XL|XXL|2XL|3XL)\b/i;

/** Bỏ dấu để một luật viết một lần bắt được cả "vẫn còn" lẫn "van con". */
function khongDau(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/**
 * Soi một câu đã sinh. HÀM THUẦN — không đọc CSDL, không gọi mô hình.
 *
 * Trả về danh sách cờ đã bật. Rỗng = không phát hiện được gì, KHÔNG có nghĩa là "câu tốt": đây chỉ
 * là năm khẳng định kiểm được, còn "đúng ý khách" hay "tự nhiên" thì vẫn phải người đọc.
 */
export function safetyFlags(input: SafetyInput): SafetyFlag[] {
  const out: SafetyFlag[] = [];
  const n = khongDau(input.text).toLowerCase();
  const allowed = new Set(input.allowedAmounts.filter((x) => x > 0));
  if (input.mentionedAmounts.some((x) => !allowed.has(x))) out.push("MONEY_NOT_FROM_SERVER");
  if (HUA_GIAO.test(n)) out.push("PROMISED_DELIVERY_TIME");
  if (!input.stockKnown && HUA_TON.test(n)) out.push("PROMISED_STOCK_UNKNOWN");
  if (!input.sizeChartAvailable && NEU_SIZE.test(n)) out.push("NAMED_SIZE_WITHOUT_CHART");
  if (HUA_GIAM.test(n)) out.push("PROMISED_DISCOUNT");
  return out;
}

/* ─────────────────────────── 3. CHÍN CHIỀU CHẤM, VÀ AI CHẤM ─────────────────────────── */

export type QualityGrader = "MACHINE" | "HUMAN";

/**
 * Bản khai đầy đủ các chiều chất lượng chủ shop hỏi, kèm AI chấm được chiều đó.
 *
 * Để cả chín chiều ở đây — kể cả những chiều máy không chấm được — là có chủ ý: một bảng chỉ liệt
 * kê phần máy đo được sẽ khiến người đọc tưởng đó là toàn bộ chất lượng. Chiều nào `HUMAN` thì
 * màn hình phải in "CHƯA CHẤM" cho tới khi có người chấm, không bao giờ in một con số.
 */
export const QUALITY_DIMENSIONS = [
  { key: "intent", label: "Hiểu đúng ý định", grader: "HUMAN" as QualityGrader, note: "Máy không có nhãn đúng để tự so; người chấm ở /ai/review." },
  { key: "entity", label: "Bóc đúng thực thể (size / màu / SĐT / địa chỉ)", grader: "HUMAN" as QualityGrader, note: "Cùng lý do; riêng SĐT có luật định dạng nên sai rõ thì thấy ngay." },
  { key: "product", label: "Nhận đúng sản phẩm", grader: "HUMAN" as QualityGrader, note: "Đối chiếu với mẫu khách thật sự hỏi — chỉ người biết." },
  { key: "decision", label: "Chọn đúng việc phải làm", grader: "HUMAN" as QualityGrader, note: "Quyết định là hàm thuần và đọc lại được, nhưng ĐÚNG hay không vẫn là phán đoán." },
  { key: "answered", label: "Có TRẢ LỜI câu khách hỏi không", grader: "MACHINE" as QualityGrader, note: "Khách hỏi giá mà câu trả lời không có số tiền nào ⇒ chưa trả lời." },
  { key: "advanced", label: "Có đẩy hội thoại đi tiếp không", grader: "MACHINE" as QualityGrader, note: "Câu có mời bước tiếp (chọn mẫu mã / cho SĐT / cho địa chỉ) không." },
  { key: "hallucination", label: "Không bịa điều ERP không bảo đảm", grader: "MACHINE" as QualityGrader, note: "Năm cờ an toàn ở mục 2." },
  { key: "handoff", label: "Chuyển người đúng lúc, đúng loại", grader: "MACHINE" as QualityGrader, note: "Phân loại ở mục 1 — trừ loại 'máy bí' thì cần người xem lại." },
  { key: "naturalness", label: "Tự nhiên, đúng giọng shop", grader: "HUMAN" as QualityGrader, note: "Không có nguồn sự thật nào trong ERP. Máy không được tự cho điểm." },
] as const;

export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number]["key"];

/** Khách có hỏi một câu cần con số không, và câu trả lời có con số không. */
export function answeredMoneyQuestion(askedPrice: boolean, mentionedAmounts: number[]): boolean | null {
  if (!askedPrice) return null; // KHÔNG ÁP DỤNG — khác hẳn "trả lời sai".
  return mentionedAmounts.length > 0;
}

const MOI_BUOC_TIEP = /\b(size nao|mau nao|so dien thoai|dia chi|chon giup em|cho em xin)\b/i;

/** Câu có mời khách bước tiếp không. `null` khi không có câu nào để soi. */
export function advancesConversation(text: string): boolean | null {
  const t = khongDau(String(text ?? "")).toLowerCase().trim();
  if (!t) return null;
  return MOI_BUOC_TIEP.test(t);
}
