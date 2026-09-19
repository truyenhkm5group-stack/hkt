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
import { ORDER_REQUIREMENT_LABEL, type OrderRequirement } from "@/lib/constants/order-draft";

/*
  HAI DANH SÁCH, VÌ VỚI MỘT SỐ TỪ THÌ CHÍNH CÁI DẤU LÀ NGHĨA.

  Bản trước có đúng MỘT danh sách và so trên chuỗi ĐÃ BỎ DẤU. Trong danh sách ấy có `"vang"`.
  `normalize("vàng")` cũng ra `"vang"`. Nên **khách chọn MÀU VÀNG bị đọc là khách ĐỒNG Ý CHỐT ĐƠN**
  — và đây là chốt chặn cuối cùng trước khi ERP tạo đơn. Cùng lỗi ấy còn ba chỗ nữa:

    "vàng" · "váng" · "vắng"  →  "vang"  →  trùng "vâng"
    "vẫn"  · "văn"  · "vân"   →  "van"   →  trùng một mục vốn không nên tồn tại
    "đã"   · "da"   · "dã"    →  "da"    →  trùng "dạ"      ("em đã xem" = một câu kể)
    "ư"    · "u"    · "ủ"     →  "u"     →  trùng "ừ"

  Nên: từ nào KHÔNG có dấu (`ok`, `chot`, `duoc`, `dc`, `yes`…) thì so trên chuỗi đã bỏ dấu như cũ;
  từ nào CÓ dấu và cái dấu ấy phân biệt nó với một từ khác thì đòi ĐÚNG CHÍNH TẢ CÓ DẤU.

  HỆ QUẢ CÓ CHỦ Ý: khách gõ "vang" không dấu sẽ KHÔNG được tính là đồng ý — vì máy không phân biệt
  được "vâng" với "vàng", và nói rằng mình phân biệt được là nói dối. Máy hỏi lại một câu; đó là
  cái giá rẻ. Chiều ngược lại — chốt một đơn khách chưa đồng ý — là một kiện hàng có thật gửi đi
  cho một người không đặt, cộng tiền cước hoàn về.

  Cố tình HẸP ở cả hai danh sách: thà bỏ sót một lần chốt (khách sẽ nhắc lại) còn hơn tạo một đơn ma.
*/
const AFFIRMATIVE = [
  "ok", "oke", "okie", "okey", "okay", "oki", "okla", "dong y", "dong ý", "dung roi", "chuan roi", "chuan", "chinh xac",
  "um", "uhm", "uh", "ukm", "uk", "chot", "chot don", "chot di", "chot nhe",
  "duoc", "duoc roi", "dc", "dc roi", "yes", "xac nhan", "lay nhe", "gui di", "gui nhe", "gui cho em di", "ship di", "dat di",
];

/**
 * Từ đồng ý PHẢI ĐỌC CÓ DẤU. Mỗi mục ở đây đều có ít nhất một từ tiếng Việt khác trùng với nó sau
 * khi bỏ dấu, và từ kia KHÔNG phải một lời đồng ý — xem khối chú thích ngay trên.
 */
const AFFIRMATIVE_MARKED = ["vâng", "dạ", "dạ vâng", "vâng ạ", "ừ", "ừa", "ừm", "ờ"];

/** Bỏ mọi thứ không phải chữ/số nhưng GIỮ NGUYÊN DẤU, rồi bọc khoảng trắng để so trọn từ. */
function padKeepMarks(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/** Phủ định / hoãn — thấy là DỪNG, kể cả khi trong câu cũng có một chữ đồng ý. */
const NEGATIVE = ["khong", "ko", "k ", "chua", "de sau", "thoi", "huy", "doi da", "cho da", "tu tu", "nghi da", "de em xem", "de em nghi"];

/**
 * Câu hỏi — "ok chưa shop?", "ok không ạ?" là HỎI, không phải đồng ý.
 *
 * Tiểu từ cuối câu phải đọc trên chữ CÓ DẤU: "ạ" là lễ phép ("vâng ạ" = đồng ý), còn "à" / "ả"
 * là hỏi ("ok à?"). `normalize()` bỏ dấu nên cả hai đều thành "a" — xét trên chuỗi đã bỏ dấu thì
 * mọi câu đồng ý lễ phép của khách Việt đều bị đọc nhầm thành câu hỏi.
 *
 * ═══ LỚP KÝ TỰ CŨ BẮT NHẦM HAI THỨ, VÀ MỘT TRONG HAI RẤT RỘNG ═══
 *
 * Bản trước dùng `[àảáừửhả]` ở cuối câu. Lớp ấy chứa `h` TRƠ TRỌI, nên MỌI câu kết thúc bằng
 * chữ "h" đều bị đọc là câu hỏi — "em lấy màu xanh", "chốt cho anh", "đặt nhanh nhé". Nó cũng
 * chứa `ừ`, mà "ừ" là một lời ĐỒNG Ý, không phải câu hỏi: khách gõ đúng một chữ "ừ" thì bị chốt
 * chặn này loại thẳng.
 *
 * Nay liệt kê TIỂU TỪ HỎI như những TỪ TRỌN VẸN đứng cuối câu, không phải như những ký tự lẻ.
 * Không dùng `\b` trước chữ có dấu: trong JS không cờ `u`, `\b` tính theo bảng chữ ASCII nên
 * giữa một khoảng trắng và chữ "à" KHÔNG có ranh giới nào — mệnh đề ấy im lặng không bao giờ khớp.
 */
const TIEU_TU_HOI = /(?:^|\s)(?:à|ả|ư|hả|hử|hở|nhỉ|nhở|chứ)\s*$/i;

function looksLikeQuestion(raw: string, normalized: string): boolean {
  const text = raw.trim();
  if (/\?\s*$/.test(text)) return true;
  if (TIEU_TU_HOI.test(text)) return true;
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
  if (AFFIRMATIVE.some((word) => n.includes(` ${normalize(word).trim()} `))) return true;
  const coDau = padKeepMarks(text);
  return AFFIRMATIVE_MARKED.some((word) => coDau.includes(` ${word} `));
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
