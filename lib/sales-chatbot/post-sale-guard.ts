/**
 * ═══════════ HẬU MÃI: KHÔNG BÁN TIẾP, KHÔNG CHỐT LẠI, KHÔNG MỞ ĐƠN MỚI VÌ «LẦN SAU» — HÀM THUẦN (#871, ca «Nguyễn Hà» HSLC 16/10/2026) ═══════════
 *
 * Sự cố: khách đã cho đủ thông tin, đơn 280.000 ₫ đã chốt. Sau đó bot vẫn xin khách xác nhận đơn, hỏi lại địa chỉ, nhắc mua; khách hỏi
 * đơn tới đâu thì bot mời mua thêm. Lời nhắc hậu mãi (`postSalePrompt`) đã dặn đủ cả ba điều — nhưng lời dặn không phải hàng rào: máy chủ
 * không có chốt nào đứng giữa chữ model và khách ở giai đoạn này.
 *
 * Tệp này là chốt đó, từng câu:
 *  · `postSaleReplyGuard` — đơn đã chốt / khách ở giai đoạn sau bán ⇒ bỏ LỜI MỜI mua thêm KHÔNG ai hỏi (khách đang hỏi trạng thái, phàn
 *    nàn, huỷ hay chờ hàng thì mời mua là sai lúc) và câu HỎI xin khách xác nhận / chốt LẠI đơn. Phần còn lại của tin vẫn gửi.
 *    KHÔNG BAO GIỜ bỏ (review PR #878): câu KỂ / câu TRẢ LỜI («em đã thêm 1 hộp nem vào đơn», «combo 2kg giá 300.000đ ạ», «em đã chốt
 *    đơn cho chị nhé»); câu nào khi chính tin khách vừa hỏi về món / giá / đổi đơn / địa chỉ; câu xác nhận một THAY ĐỔI («chị xác nhận
 *    giúp em địa chỉ mới»). Tin mà MỌI câu đều là lời mời / xin chốt lại thì KHÔNG gửi (review PR #878 vòng 2): bản đầu «giữ nguyên
 *    tin» cho an toàn, nên tin CHỈ có lời mời — đúng triệu chứng «Nguyễn Hà» — vẫn tới khách. Khách không bị bỏ im: engine dùng
 *    `postSaleFallbackText` (hỏi trạng thái ⇒ câu trạng thái từ `get_order_status`, cảm ơn ⇒ câu cảm ơn, còn lại ⇒ câu trung tính).
 *  · `futurePurchaseOnly` — «mua tiếp lần sau», «hôm khác chị đặt» là ý định TƯƠNG LAI, không phải đơn: công cụ lên đơn từ chối — CHỈ
 *    sau chốt (nơi gọi kiểm `state.confirmed`). Có số lượng + lời mua («lấy 2kg») hay ngày giao muộn trên chính đơn («tuần sau giao»)
 *    thì KHÔNG phải «chỉ tương lai».
 *
 * GHI CHÚ TÍCH HỢP (#868): nhánh `claude/p0-868-smart-upsell` thêm `next-best-action.ts` với cửa sổ lời mời (`offerWindow` — CONFIRMED,
 * COMPLAINT…) cho MỌI giai đoạn. Lúc tệp này viết, #868 CHƯA vào main ⇒ đây là hàng rào TỐI THIỂU cho riêng giai đoạn sau chốt. Khi #868
 * vào main, hai lớp cùng chiều (đều CHẶN lời mời sau chốt) — không xung đột; gộp về một đường ở lượt dọn sau, không bỏ lớp này trước khi
 * `offerWindow` chạy trên đúng đường gửi chữ của engine.
 */
import { classifyDeliveryQuestion } from "@/lib/sales-chatbot/delivery-intent";
import { foldVi } from "@/lib/sales-chatbot/text";

export type PostSaleDrop = "UPSELL" | "RECONFIRM";

const fold = (s: string) => ` ${foldVi(s.normalize("NFC").toLowerCase()).replace(/[^a-z0-9?]+/g, " ").replace(/\s+/g, " ").trim()} `;

/** Câu nói về MUA THÊM / món khác (đã gập dấu, có khoảng trắng hai đầu) — mới là ĐỀ TÀI, chưa phải lời mời (xem `INVITING_RE`). */
const UPSELL_RE = [
  / (?:lay|mua|chon|dat|order|an|dung|xem|thu) them /,
  / them (?:mon|vai|it|1|mot|hai|2|hop|goi|kg|ky|phan|set|combo|hu|lo|tui) /,
  / moi (?:anh |chi |minh |ban |a |c |e |em )?(?:thu|them|tham khao|xem|mua|dat|dung) /,
  / (?:combo|set qua|mon (?:khac|kem|moi|ban chay)|san pham (?:khac|kem|moi|ban chay)|an kem|dung kem|ban chay nhat|menu) /,
  / (?:uu dai|khuyen mai|giam gia|freeship|mien ship) (?:cho |neu |khi |them |hom nay |dot nay )/,
];
/**
 * LỜI MỜI (câu hỏi / chào mời), không phải câu kể: dấu «?», tiểu từ mời / hỏi ở CUỐI câu («… nhé», «… nè», «… không ạ»), hay động từ
 * mời («mời chị thử», «chị có muốn», «tham khảo»). «Dạ combo 2kg bên em giá 300.000đ ạ» kết bằng «ạ» — câu TRẢ LỜI, không phải lời mời.
 */
const INVITING_RE = /\?| (?:nhe|nha|ne|nhen|nghen|di|khong|ko|chua|a nhe|a nha|nha a|nhe a|luon nhe|luon nha|khong a|ko a|chua a)\s*$| moi (?:anh |chi |minh |ban |a |c |e |em )?(?:thu|them|tham khao|xem|mua|dat|dung) | co muon | tham khao /;
/** Câu XIN XÁC NHẬN / CHỐT (LẠI) đơn hay thông tin nhận hàng. */
const RECONFIRM_RE = [
  / (?:xac nhan|chot)(?: lai)?(?: giup em| giup| cho em| voi em)? (?:don|dia chi|thong tin|sdt|so dien thoai|giup em|lai) /,
  / (?:em|shop|minh) (?:len|gui|chot|xac nhan) don(?: cho (?:anh|chi|minh|ban))?(?: luon)? (?:nhe|nha|nha|a|duoc khong|khong) /,
  / (?:co )?(?:muon )?(?:tiep tuc )?(?:chot|dat|lay) (?:don )?(?:khong|ko|chua) /,
  / lay them gi (?:nua )?(?:khong|ko) /,
];
/**
 * Dấu hiệu câu HỎI / NHỜ (không phải câu kể): dấu «?», tiểu từ hỏi / nhờ ở CUỐI câu, hay «giúp em / cho em». «không» GIỮA câu không tính
 * («Đã chốt đơn (thử — không tạo đơn thật), tổng thu …» là câu kể).
 */
const ASKING_RE = /\?| (?:nhe|nha|khong|ko|chua|duoc khong|a nhe|a nha|voi a)\s*$| (?:giup em|cho em|giup minh) /;
/**
 * Câu KỂ việc đã làm / đã ghi nhận («em ĐÃ thêm», «em VỪA chốt», «em GHI NHẬN chị lấy thêm», «nhân viên sẽ CẬP NHẬT») — trên chữ CÓ DẤU,
 * vì bản gập dấu không tách được «đã» khỏi «dạ» mở đầu mọi câu.
 */
const STATEMENT_RE = /(?:^|[\s,.(])(?:đã|em vừa|shop vừa|ghi nhận|cập nhật|báo nhân viên)(?=[\s,.!?)]|$)/u;
/** Câu xác nhận một THAY ĐỔI khách vừa xin («địa chỉ MỚI», «ĐỔI sang 2 hộp», «huỷ đơn») — không phải xin chốt LẠI đơn cũ. Bản gập dấu. */
const CHANGE_RE = / (?:moi|doi|thay doi|cap nhat|sua|huy|bot|them) /;
/** Tin KHÁCH vừa hỏi về món / giá / đổi đơn / địa chỉ ⇒ câu trả lời về món / xác nhận là ĐÚNG lúc, không lọc gì. Bản gập dấu. */
const CUSTOMER_ASKED_RE = / (?:them|doi|sua|thay|bot|huy|chuyen|dia chi|sdt|so dien thoai|nguoi nhan|gia|bao nhieu|bn|may tien|mon|combo|loai|con hang|san pham|menu) | [0-9]+ ?(?:kg|hop|goi|cai|hu|phan|set) /;

function sentencesOf(text: string): string[] {
  return text
    .replace(/([.!?…])\s+/g, "$1\n")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Loại câu cần bỏ ở giai đoạn sau chốt (`null` = giữ). `lastCustomerText` = tin khách vừa gửi (hỏi về món / đổi đơn ⇒ không bỏ gì). HÀM THUẦN. */
export function postSaleSentenceDrop(sentence: string, lastCustomerText = ""): PostSaleDrop | null {
  if (lastCustomerText && CUSTOMER_ASKED_RE.test(fold(lastCustomerText))) return null;
  const f = fold(sentence);
  if (STATEMENT_RE.test(sentence.normalize("NFC").toLowerCase())) return null;
  if (UPSELL_RE.some((re) => re.test(f))) return INVITING_RE.test(f) ? "UPSELL" : null;
  if (RECONFIRM_RE.some((re) => re.test(f)) && ASKING_RE.test(f) && !CHANGE_RE.test(f)) return "RECONFIRM";
  return null;
}

/** Mọi câu sẽ bị lọc (kể cả khi cả tin đều bị lọc) — cho câu mẫu: câu mẫu chỉ là một lời mời thì không gửi. HÀM THUẦN. */
export function postSaleDropsIn(text: string, lastCustomerText = ""): PostSaleDrop[] {
  return sentencesOf(text).flatMap((s) => postSaleSentenceDrop(s, lastCustomerText) ?? []);
}

/**
 * Chữ model gửi khách khi đơn ĐÃ CHỐT (hoặc khách ở giai đoạn sau bán): bỏ lời mời mua thêm không ai hỏi + câu hỏi xin xác nhận / chốt lại.
 * Mọi câu đều bị lọc ⇒ `text: ""` + `emptied: true` — tin chỉ toàn lời mời / xin chốt lại KHÔNG tới khách (luật chủ shop: không bán tiếp
 * sau chốt). Câu kể / câu trả lời / xác nhận thay đổi không bao giờ bị lọc (`postSaleSentenceDrop`), nên «rỗng» chỉ xảy ra khi tin thật sự
 * không có gì khác; nơi gọi phải thay bằng `postSaleFallbackText` để khách không bị bỏ im. HÀM THUẦN.
 */
export function postSaleReplyGuard(text: string, lastCustomerText = ""): { text: string; dropped: PostSaleDrop[]; emptied?: true } {
  const kept: string[] = [];
  const dropped: PostSaleDrop[] = [];
  for (const s of sentencesOf(text)) {
    const d = postSaleSentenceDrop(s, lastCustomerText);
    if (d) dropped.push(d);
    else kept.push(s);
  }
  if (!dropped.length) return { text, dropped };
  if (!kept.length) return { text: "", dropped, emptied: true };
  return { text: kept.join(" "), dropped };
}

/** Câu cảm ơn khi khách chỉ cảm ơn / chào sau chốt và tin model chỉ là lời mời. */
export const POST_SALE_THANKS_TEXT = "Dạ em cảm ơn mình ạ.";
/** Câu trung tính sau chốt — không mời mua, không xin chốt lại (có kiểm thử: `postSaleDropsIn` của câu này rỗng). */
export const POST_SALE_NEUTRAL_TEXT = "Dạ vâng ạ, mình cần hỗ trợ gì về đơn cứ nhắn em nhé.";
const THANKS_RE = / (?:cam on|camon|thank|thanks|tks|thank you) /;

/**
 * Câu trạng thái trong MỘT kết quả `get_order_status` (chuỗi JSON công cụ trả): câu DIRECT về lịch giao máy chủ đã quyết, nếu không thì
 * «status» của đơn mới nhất (đơn cần người ⇒ hỏi khách có cần nhân viên hỗ trợ — đúng lời dặn của lời nhắc). Không đọc được ⇒ `null`. HÀM THUẦN.
 */
export function orderStatusSayOf(content: string): string | null {
  let p: { orders?: unknown; delivery_answer?: { kind?: unknown; say?: unknown } };
  try {
    p = JSON.parse(content) as typeof p;
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || !Array.isArray(p.orders)) return null;
  if (p.delivery_answer?.kind === "DIRECT" && typeof p.delivery_answer.say === "string" && p.delivery_answer.say.trim()) return p.delivery_answer.say.trim();
  const first = p.orders[0] as { status?: unknown; order_code?: unknown; needs_staff?: unknown } | undefined;
  if (!first || typeof first.status !== "string" || !first.status.trim()) return null;
  const code = typeof first.order_code === "string" && first.order_code.trim() ? ` ${first.order_code.trim()}` : "";
  const line = `Dạ đơn${code} của mình: ${first.status.trim().replace(/[.!\s]+$/u, "")} ạ.`;
  return first.needs_staff === true ? `${line} Mình có cần nhân viên shop hỗ trợ thêm không ạ?` : line;
}

type TurnBlock = { type: string; text?: string; content?: string };

/** Câu trạng thái từ kết quả `get_order_status` của LƯỢT hiện tại (đọc ngược tới tin khách gần nhất có chữ). HÀM THUẦN. */
export function turnOrderStatusSay(history: readonly { role: string; content: readonly TurnBlock[] }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    if (m.content.some((b) => b.type === "text" && (b.text ?? "").trim())) return null;
    for (const b of m.content) {
      if (b.type !== "tool_result" || typeof b.content !== "string") continue;
      const say = orderStatusSayOf(b.content);
      if (say) return say;
    }
  }
  return null;
}

/** Khách vừa hỏi trạng thái đơn / lịch giao (cùng bộ phân loại với công cụ `get_order_status`). HÀM THUẦN. */
export function asksOrderStatus(lastCustomerText: string): boolean {
  return classifyDeliveryQuestion(lastCustomerText) !== null;
}

/**
 * Câu gửi khách khi bộ lọc hậu mãi đã bỏ HẾT tin của model (chỉ toàn lời mời / xin chốt lại). Khách hỏi trạng thái ⇒ câu trạng thái từ
 * `get_order_status` (`statusSay`); chưa có thì `null` — nơi gọi phải tra đơn (hoặc chuyển người), KHÔNG được thay bằng câu chung. Khách
 * cảm ơn ⇒ câu cảm ơn; còn lại ⇒ câu trung tính. Không câu nào mời mua / xin chốt lại. HÀM THUẦN.
 */
export function postSaleFallbackText(lastCustomerText: string, statusSay: string | null): string | null {
  if (asksOrderStatus(lastCustomerText)) return statusSay;
  return THANKS_RE.test(fold(lastCustomerText)) ? POST_SALE_THANKS_TEXT : POST_SALE_NEUTRAL_TEXT;
}

/** Mốc TƯƠNG LAI không xác định («lần sau», «hôm khác», «dịp khác», «tháng sau»…). */
const FUTURE_RE = / (?:lan sau|lan toi|hom khac|bua khac|dip khac|dot sau|dot toi|khi khac|sau nay|thang sau|tuan sau|nam sau|khi nao can|luc nao can|lan khac) /;
/**
 * Lời mua NGAY gắn món / số lượng («lấy luôn», «đặt ngay», «lấy 2kg», «thêm 1 hộp») — khi có, tin không chỉ là ý định tương lai. «2kg»
 * viết liền vẫn là số lượng (review PR #878).
 */
const BUY_NOW_RE = / (?:luon|ngay|bay gio|hom nay|bh) | (?:lay|them|dat|mua|cho)(?: (?:chi|em|anh|minh|toi|c|e|a))? (?:\d|(?:mot|hai|ba|bon|nam|nua) )/;
/** Ngày giao muộn trên chính đơn («tuần sau giao», «giao tháng sau») — mong muốn giờ giao, không phải «mua lần sau». */
const LATER_DELIVERY_RE = / (?:giao|ship|gui|nhan|phat)(?: [a-z0-9]+){0,3} (?:thang sau|tuan sau|tuan toi|thang toi) | (?:thang sau|tuan sau|tuan toi|thang toi)(?: [a-z0-9]+){0,1} (?:giao|ship|gui|nhan|phat) /;

/**
 * Tin khách chỉ là Ý ĐỊNH MUA TƯƠNG LAI («mua tiếp lần sau nhé», «hôm khác chị đặt tiếp») — không có lời mua ngay, không phải lời hẹn
 * ngày giao. CHỈ dùng sau chốt (nơi gọi kiểm). HÀM THUẦN.
 */
export function futurePurchaseOnly(text: string): boolean {
  const f = fold(text);
  return FUTURE_RE.test(f) && !BUY_NOW_RE.test(f) && !LATER_DELIVERY_RE.test(f);
}
