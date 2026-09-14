/**
 * XÁC NHẬN CÓ NGỮ CẢNH — chốt chặn giữa "khách gõ ok" và "ERP tạo đơn".
 *
 * Một chữ "ok" KHÔNG BAO GIỜ tự nó tạo đơn. Trong chat bán hàng, "ok" là câu đệm phổ biến nhất
 * tiếng Việt: khách "ok" sau khi nghe giá, "ok" sau khi nghe còn hàng, "ok" để kết thúc câu
 * chuyện rồi biến mất. Tính mỗi chữ đó là một lần chốt thì shop gửi đi những kiện hàng không ai
 * đặt, và tiền cước hoàn về là tiền thật.
 *
 * SÁU ĐIỀU PHẢI ĐỦ, thiếu một là KHÔNG xác nhận:
 *   1. Có một bản chốt đơn ĐÃ GỬI (`pending`) — chưa đọc đơn cho khách thì không có gì để đồng ý.
 *   2. Tin của khách đến SAU lúc gửi bản chốt.
 *   3. Bản chốt còn HẠN (mặc định 24 giờ) — đồng ý với một bản chốt của tuần trước là vô nghĩa.
 *   4. Bản chốt còn NGUYÊN: mẫu mã / số lượng / SĐT / địa chỉ / giá chưa đổi kể từ lúc gửi.
 *   5. Câu trả lời là ĐỒNG Ý thật, không phải câu hỏi có chứa chữ "ok", không phải phủ định.
 *   6. Đơn đủ điều kiện máy chủ (mẫu mã, số lượng, SĐT, địa chỉ, giá) — đồng ý với một đơn thiếu
 *      địa chỉ vẫn là một đơn không gửi được.
 */
import { normalize } from "@/lib/text";
import { addressIssue, normalizePhone } from "@/lib/constants/landing";
import { CONFIRMATION_TTL_HOURS } from "@/lib/constants/sales-agent";
import { confirmationFingerprint, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import { ORDER_REQUIREMENT_LABEL, type OrderRequirement } from "@/lib/ai-workforce/tools/erp";

/** Từ đồng ý. Cố tình HẸP: thà bỏ sót một lần chốt (khách sẽ nhắc lại) còn hơn tạo một đơn ma. */
const AFFIRMATIVE = [
  "ok", "oke", "okie", "okey", "okay", "dong y", "dong ý", "dung roi", "chuan roi", "chuan", "chinh xac",
  "vang", "van", "da", "da vang", "u", "um", "ukm", "uk", "chot", "chot don", "chot di", "chot nhe",
  "duoc", "duoc roi", "dc", "dc roi", "yes", "xac nhan", "lay nhe", "gui di", "gui cho em di", "dat di",
];

/** Phủ định / hoãn — thấy là DỪNG, kể cả khi trong câu cũng có một chữ đồng ý. */
const NEGATIVE = ["khong", "ko", "k ", "chua", "de sau", "thoi", "huy", "doi da", "cho da", "tu tu", "nghi da", "de em xem", "de em nghi"];

/**
 * Câu hỏi — "ok chưa shop?", "ok không ạ?" là HỎI, không phải đồng ý.
 *
 * Tiểu từ cuối câu phải đọc trên chữ CÓ DẤU: "ạ" là lễ phép ("vâng ạ" = đồng ý), còn "à" / "ả"
 * là hỏi ("ok à?"). `normalize()` bỏ dấu nên cả hai đều thành "a" — xét trên chuỗi đã bỏ dấu thì
 * mọi câu đồng ý lễ phép của khách Việt đều bị đọc nhầm thành câu hỏi.
 */
function looksLikeQuestion(raw: string, normalized: string): boolean {
  const text = raw.trim();
  if (/\?\s*$/.test(text)) return true;
  if (/[àảáừửhả]\s*$/i.test(text) || /\b(hả|hử|à)\s*$/i.test(text)) return true;
  return /\b(chua|khong|ko|ha|sao|nao|gi|ntn|the nao)\s*$/.test(normalized.trim());
}

export type ConfirmationCheck =
  | { confirmed: true; quote: string; reviewSentAt: string; customerRepliedAt: string }
  | { confirmed: false; reason: string; blocking: OrderRequirement[] };

export type ConfirmationInput = {
  state: SalesState;
  /** Tin nhắn của khách đang xét. */
  message: { text: string; sentAt: Date | null };
  /** Đồng hồ truyền vào để hàm vẫn THUẦN và kiểm thử được tới từng giây. */
  now: Date;
};

/** Đơn còn thiếu điều kiện máy chủ nào. Rỗng = đủ điều kiện lên đơn. */
export function missingOrderRequirements(state: SalesState): OrderRequirement[] {
  const missing: OrderRequirement[] = [];
  if (!state.variantId) missing.push("VARIANT");
  if (!Number.isInteger(state.quantity) || state.quantity < 1) missing.push("QUANTITY");
  if (!/^0\d{9}$/.test(normalizePhone(state.phone))) missing.push("PHONE");
  if (addressIssue(state.address, state.province)) missing.push("ADDRESS");
  // Giá phải do MÁY CHỦ tính. `null` = chưa tính ⇒ chưa được lên đơn.
  if (state.quotedTotal === null || state.quotedTotal <= 0) missing.push("PRICE");
  return missing;
}

/** Câu này có phải một lời đồng ý thuần tuý không (chưa xét ngữ cảnh). */
export function isAffirmativeText(raw: string): boolean {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  const n = normalize(text);
  if (NEGATIVE.some((word) => n.includes(` ${word.trim()} `))) return false;
  if (looksLikeQuestion(text, n)) return false;
  return AFFIRMATIVE.some((word) => n.includes(` ${normalize(word).trim()} `));
}

/**
 * Khách đã xác nhận CÓ NGỮ CẢNH chưa. Hàm thuần: không đọc CSDL, không đọc `Date.now()`.
 */
export function checkContextualConfirmation(input: ConfirmationInput): ConfirmationCheck {
  const { state, message, now } = input;
  const pending = state.pending;
  if (!pending) {
    return { confirmed: false, reason: "Chưa gửi bản chốt đơn nào cho khách — một chữ đồng ý lúc này không gắn với đơn nào", blocking: [] };
  }
  const sentAt = new Date(pending.sentAt);
  if (Number.isNaN(sentAt.getTime())) {
    return { confirmed: false, reason: "Bản chốt đơn hỏng mốc thời gian", blocking: [] };
  }
  const repliedAt = message.sentAt;
  if (!repliedAt) {
    return { confirmed: false, reason: "Tin nhắn không có mốc thời gian — không chứng minh được khách trả lời SAU bản chốt", blocking: [] };
  }
  if (repliedAt.getTime() < sentAt.getTime()) {
    return { confirmed: false, reason: "Tin này có trước bản chốt đơn — không phải câu trả lời cho bản chốt", blocking: [] };
  }
  const ageHours = (now.getTime() - sentAt.getTime()) / 3_600_000;
  if (ageHours > CONFIRMATION_TTL_HOURS) {
    return { confirmed: false, reason: `Bản chốt đơn đã quá ${CONFIRMATION_TTL_HOURS} giờ — phải đọc lại đơn cho khách`, blocking: [] };
  }
  const fingerprint = confirmationFingerprint(state);
  if (fingerprint !== pending.fingerprint) {
    return { confirmed: false, reason: "Đơn đã đổi (mẫu mã / số lượng / SĐT / địa chỉ / giá) kể từ lúc gửi bản chốt — phải chốt lại", blocking: [] };
  }
  if (!isAffirmativeText(message.text)) {
    return { confirmed: false, reason: "Câu trả lời của khách không phải một lời đồng ý rõ ràng", blocking: [] };
  }
  const blocking = missingOrderRequirements(state);
  if (blocking.length) {
    return {
      confirmed: false,
      reason: `Khách đồng ý nhưng đơn còn thiếu: ${blocking.map((b) => ORDER_REQUIREMENT_LABEL[b]).join(", ")}`,
      blocking,
    };
  }
  return {
    confirmed: true,
    quote: message.text.slice(0, 500),
    reviewSentAt: sentAt.toISOString(),
    customerRepliedAt: repliedAt.toISOString(),
  };
}
