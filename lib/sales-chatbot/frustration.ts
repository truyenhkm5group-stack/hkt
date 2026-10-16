/**
 * ═══════════ KHÁCH BỰC / ĐƠN MÂU THUẪN ⇒ NGƯỜI, KHÔNG PHẢI MỘT CÂU XIN LỖI NỮA (P0 16/10/2026, #855) ═══════════
 *
 * Ca «ThuyNgo» (khách cũ HSLC): khách «Ship chị 1 mực giã tay», bot báo «1kg chả cá thu + 1kg chả mực» 680.000 ₫. Khách «Kg có order
 * chả cá thu nha» · «Chị order mực» · «Sao kg coi ở trên» · «Khách cũ mà hỏi gì» · «Địa chỉ coi lại» · «Robot hả» — bot xin lỗi rồi hỏi
 * lại địa chỉ, lượt này qua lượt khác. Mỗi lượt model đều được hỏi lại, và mỗi lượt nó lại có thể nói sai thêm một điều. Lời dặn trong
 * lời nhắc không dừng được vòng đó: máy chủ phải dừng.
 *
 * Tệp này quyết, TRƯỚC lượt AI, tin khách có phải lúc phải trả hội thoại cho người không:
 *  · `DENIED_BOT_ITEM` — khách phủ nhận một món mà bot đã đưa vào giỏ / báo giá / đơn nháp («không có order X») ⇒ đơn đang mâu thuẫn với
 *    lời khách: KHÔNG tự chốt, người gọi lại khách.
 *  · `ASKS_HUMAN` — khách xin gặp người («gặp nhân viên», «người thật», «nhân viên đâu»).
 *  · `COMPLAINT` — khách phàn nàn bot không đọc / hỏi lại («robot hả», «khách cũ mà hỏi gì», «sao không coi ở trên»).
 *  · `REPEATED_CORRECTION` — khách đã SỬA đơn bot đề nghị từ `CORRECTION_HANDOFF_AT` lần trở lên trong lượt mua.
 *
 * Nơi gọi (engine) dùng ĐÚNG đường chuyển người sẵn có: `status = HANDOFF` với lý do KHÔNG thuộc nhóm tự hết hạn (`ai-hold-shared.ts`) ⇒
 * bot im tới khi nhân viên trả lại cho AI; follow-up chỉ chạy hội thoại `WAITING` nên cũng dừng. HÀM THUẦN — không CSDL, không mạng.
 */
import { classifyCartMessage, DENIAL_RE, labelsMatch, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { foldVi } from "@/lib/sales-chatbot/text";

export type FrustrationKind = "DENIED_BOT_ITEM" | "ASKS_HUMAN" | "COMPLAINT" | "REPEATED_CORRECTION";
export type FrustrationSignal = { kind: FrustrationKind; reason: string };

/** Tiền tố lý do chuyển người — một chỗ khai (nhật ký, hàng đợi người đọc theo tiền tố). */
export const FRUSTRATION_HANDOFF_PREFIX = "Khách cần người — đơn mâu thuẫn / khách phàn nàn";

/** Số lượt khách sửa đơn bot đề nghị (trong một lượt mua) thì chuyển người. */
export const CORRECTION_HANDOFF_AT = 2;

/** Khách xin gặp người. Không bắt «nhân viên giao hàng», «người nhận». */
const ASKS_HUMAN_RE =
  /(?:^| )(?:(?:cho|muon|can|xin)(?: (?:chi|em|anh|minh|toi|c|a|e))? (?:gap|noi chuyen voi|lien he|goi|chuyen)|gap|noi chuyen voi|goi cho) (?:nhan vien|nguoi that|chu shop|admin|quan ly|tu van vien)(?: |$)|(?:^| )(?:nhan vien|nguoi that|admin|chu shop) (?:dau|oi|dau roi|dau het roi)(?: |$)|(?:^| )co (?:ai|nguoi)(?: that)?(?: o)?(?: (?:do|day))? (?:khong|ko|k)$|(?:^| )nguoi that(?: |$)/;

/**
 * Khách phàn nàn bot không đọc / hỏi lại / là máy. KHÔNG bắt «bot» / «máy» đứng một mình (gập dấu thì «bớt» = «bot», «mấy» = «may»);
 * «xem lại» chỉ tính khi cả tin là lời bảo SHOP xem lại («Địa chỉ coi lại») — «để chị xem lại» là khách tự xem.
 */
const COMPLAINT_RE = [
  /(?:^| )(?:robot|ro bot|robo)(?: |$)/,
  /(?:^| )tra loi (?:nhu may|tu dong)(?: |$)/,
  /(?:^| )khach cu(?: (?:ma|roi|ma con|roi ma))? (?:hoi|con hoi|lai hoi|hoi lai)(?: |$)/,
  /(?:^| )sao (?:khong |ko |k |kg |hong |hok )?(?:coi|xem|doc) (?:o tren|tren|lai|ky|tin)(?: |$)/,
  /(?:^| )hoi (?:hoai|mai|lai hoai|gi hoai|gi nua|di hoi lai)(?: |$)/,
  /^(?:(?:dia chi|don|don hang|tin nhan|tin|em|shop|ban|e|ad) )?(?:coi|xem|doc) lai(?: (?:di|dum|giup|ho|nha|nhe|em|e|tin|o tren|giup chi|di em))*$/,
];

/** Câu khách là một lời phàn nàn (bot không đọc / hỏi lại / là máy). HÀM THUẦN. */
export function isComplaint(text: string): boolean {
  const f = foldVi(text);
  return COMPLAINT_RE.some((re) => re.test(f));
}

/** Câu khách xin gặp người. HÀM THUẦN. */
export function asksForHuman(text: string): boolean {
  return ASKS_HUMAN_RE.test(foldVi(text));
}

/** Kiểu câu sửa giỏ — lượt khách SỬA đơn bot đã đề nghị. */
const CORRECTION_KINDS = new Set(["SET", "REDUCE", "REMOVE", "KEEP"]);

export type FrustrationInput = {
  text: string;
  /** Giỏ có thẩm quyền TRƯỚC / SAU khi áp tin này (engine). */
  before: CartCommitment | undefined;
  after: CartCommitment | undefined;
  /** Bot đã đề nghị một đơn / báo giá cho khách chưa (đơn nháp, báo giá, tổng đã báo). */
  hasOffer: boolean;
  /** Số lượt khách đã SỬA đơn trong lượt mua (trước tin này). */
  corrections: number;
  turn: number;
  catalog?: readonly string[];
};

/** Lượt này có phải một lần khách SỬA đơn bot đã đề nghị không (đếm cho `REPEATED_CORRECTION`). HÀM THUẦN. */
export function isCorrectionTurn(i: Pick<FrustrationInput, "text" | "before" | "after" | "hasOffer" | "turn" | "catalog">): boolean {
  if (!i.hasOffer) return false;
  if (DENIAL_RE.test(foldVi(i.text))) return true;
  const kind = classifyCartMessage(i.text, i.catalog).kind;
  if (CORRECTION_KINDS.has(kind) && i.after !== i.before) return true;
  // Câu có dấu hiệu sửa mà máy chưa áp được (giỏ «nới» ở đúng lượt này) cũng là một lần khách phải đính chính.
  return Boolean(i.after && i.after.relaxedTurn === i.turn && i.after !== i.before);
}

/**
 * Tin khách này có buộc chuyển người không. Thứ tự: phủ nhận món bot đưa ra (mâu thuẫn đơn — nặng nhất) → xin người → phàn nàn → sửa
 * đơn lần thứ `CORRECTION_HANDOFF_AT`. `null` = để lượt AI chạy như thường. HÀM THUẦN.
 */
export function frustrationSignal(i: FrustrationInput): FrustrationSignal | null {
  const f = foldVi(i.text);
  const quote = i.text.trim().slice(0, 120);
  // Phủ nhận món khi bot ĐÃ đề nghị một đơn / báo giá / giỏ: đơn đang mâu thuẫn với lời khách. Chưa có đề nghị nào («không đặt chả cá,
  // lấy chả mực» ngay tin đầu) ⇒ chỉ là lời chọn món, lượt AI chạy như thường.
  if (DENIAL_RE.test(f) && (i.hasOffer || Boolean(i.before?.selectedItems.length))) {
    const said = classifyCartMessage(i.text, i.catalog);
    const label = said.kind === "REMOVE" ? (said.label ?? "") : "";
    const hit = label ? (i.before?.selectedItems ?? []).find((x) => labelsMatch(label, x.label || x.match)) : undefined;
    const what = hit ? hit.label || hit.match : label;
    return { kind: "DENIED_BOT_ITEM", reason: `khách phủ nhận món bot đưa vào đơn${what ? ` («${what}»)` : ""}: «${quote}» — KHÔNG tự chốt, gọi lại khách xác nhận đúng món` };
  }
  if (asksForHuman(i.text)) return { kind: "ASKS_HUMAN", reason: `khách xin gặp nhân viên: «${quote}»` };
  if (isComplaint(i.text)) return { kind: "COMPLAINT", reason: `khách phàn nàn bot không đọc / hỏi lại: «${quote}»` };
  if (isCorrectionTurn(i) && i.corrections + 1 >= CORRECTION_HANDOFF_AT) return { kind: "REPEATED_CORRECTION", reason: `khách đã sửa đơn ${i.corrections + 1} lần: «${quote}» — người xác nhận lại đơn` };
  return null;
}
