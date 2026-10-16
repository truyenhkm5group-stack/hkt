/**
 * ═══════════ KHÁCH BỰC / ĐƠN MÂU THUẪN ⇒ NGƯỜI, KHÔNG PHẢI MỘT CÂU XIN LỖI NỮA (P0 16/10/2026, #855) ═══════════
 *
 * Ca «ThuyNgo» (khách cũ HSLC): khách «Ship chị 1 mực giã tay», bot báo «1kg chả cá thu + 1kg chả mực» 680.000 ₫. Khách «Kg có order
 * chả cá thu nha» · «Chị order mực» · «Sao kg coi ở trên» · «Khách cũ mà hỏi gì» · «Địa chỉ coi lại» · «Robot hả» — bot xin lỗi rồi hỏi
 * lại địa chỉ, lượt này qua lượt khác. Mỗi lượt model đều được hỏi lại, và mỗi lượt nó lại có thể nói sai thêm một điều. Lời dặn trong
 * lời nhắc không dừng được vòng đó: máy chủ phải dừng.
 *
 * Tệp này quyết, TRƯỚC lượt AI, tin khách có phải lúc phải trả hội thoại cho người không:
 *  · `DENIED_BOT_ITEM` — khách phủ nhận ĐÚNG một món bot / shop đã đưa vào giỏ / báo giá / đơn nháp («không có order X», X có trong đề
 *    nghị) ⇒ đơn đang mâu thuẫn với lời khách: KHÔNG tự chốt, người gọi lại khách. «Không đặt thêm gì nữa» (từ chối lời mời) KHÔNG phải.
 *  · `ASKS_HUMAN` — khách xin gặp người («gặp nhân viên», «người thật», «nhân viên đâu»).
 *  · `COMPLAINT` — khách phàn nàn bot không đọc / hỏi lại («robot hả», «khách cũ mà hỏi gì», «sao không coi ở trên»).
 *  · `REPEATED_CORRECTION` — khách đã nói BOT SAI («sai rồi», «không phải», «chị đâu có đặt») từ `CORRECTION_HANDOFF_AT` lần trở lên trong
 *    lượt mua. Khách tự đổi ý («đổi 2kg», «à thôi 3kg») là mua bình thường, không đếm.
 *
 * Nơi gọi (engine) dùng ĐÚNG đường chuyển người sẵn có: `status = HANDOFF` với lý do KHÔNG thuộc nhóm tự hết hạn (`ai-hold-shared.ts`) ⇒
 * bot im tới khi nhân viên trả lại cho AI; follow-up chỉ chạy hội thoại `WAITING` nên cũng dừng. HÀM THUẦN — không CSDL, không mạng.
 */
import { deniedItemLabel, labelsMatch, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { foldVi } from "@/lib/sales-chatbot/text";

export type FrustrationKind = "DENIED_BOT_ITEM" | "ASKS_HUMAN" | "COMPLAINT" | "REPEATED_CORRECTION";
/** `inDraft` (chỉ `DENIED_BOT_ITEM`) = món bị phủ nhận đang nằm trong đơn nháp ⇒ gắn cờ cần người kiểm lên đơn. */
export type FrustrationSignal = { kind: FrustrationKind; reason: string; inDraft?: boolean };

/** Tiền tố lý do chuyển người — một chỗ khai (nhật ký, hàng đợi người đọc theo tiền tố). */
export const FRUSTRATION_HANDOFF_PREFIX = "Khách cần người — đơn mâu thuẫn / khách phàn nàn";

/** Số lượt khách sửa đơn bot đề nghị (trong một lượt mua) thì chuyển người. */
export const CORRECTION_HANDOFF_AT = 2;

/** Khách xin gặp người. Không bắt «nhân viên giao hàng» / shipper / bưu cục, «người nhận». */
const ASKS_HUMAN_RE =
  /(?:^| )(?:(?:cho|muon|can|xin)(?: (?:chi|em|anh|minh|toi|c|a|e))? (?:gap|noi chuyen voi|lien he|goi|chuyen)|gap|noi chuyen voi|goi cho) (?:nhan vien(?! (?:giao|ship|van chuyen|buu cuc|buu dien))|nguoi that|chu shop|admin|quan ly|tu van vien)(?: |$)|(?:^| )(?:nhan vien|nguoi that|admin|chu shop) (?:dau|oi|dau roi|dau het roi)(?: |$)|(?:^| )co (?:ai|nguoi)(?: that)?(?: o)?(?: (?:do|day))? (?:khong|ko|k)$|(?:^| )nguoi that(?: |$)/;

/**
 * Khách phàn nàn bot không đọc / hỏi lại / là máy. KHÔNG bắt «bot» / «máy» đứng một mình (gập dấu thì «bớt» = «bot», «mấy» = «may»);
 * «xem lại» chỉ tính khi cả tin là lời bảo SHOP xem lại («Địa chỉ coi lại») — «để chị xem lại» là khách tự xem.
 */
const COMPLAINT_RE = [
  /(?:^| )(?:robot|ro bot|robo)(?: |$)/,
  /(?:^| )tra loi (?:nhu may|tu dong)(?: |$)/,
  /(?:^| )khach cu(?: (?:ma|roi|ma con|roi ma))? (?:hoi|con hoi|lai hoi|hoi lai)(?: |$)/,
  /(?:^| )sao (?:khong |ko |k |kg |hong |hok )?(?:coi|xem|doc) (?:o tren|tren|lai|ky|tin)(?: |$)/,
  /(?:^| )hoi (?:hoai|mai|lai hoai|gi hoai|di hoi lai)(?: |$)/,
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

/**
 * Lời khách nói BOT SAI (review PR #862 — chỉ những lần này mới đếm cho `REPEATED_CORRECTION`): «sai rồi», «em ghi sai», «nhầm rồi»,
 * «không phải», «chị đâu có đặt», «có đặt đâu». Khách TỰ đổi ý («đổi 2kg», «à thôi 3kg») là mua bình thường, KHÔNG đếm.
 */
const BOT_WRONG_RE = /(?:^| )(?:sai roi|sai r|sai het|ghi sai|len sai|tinh sai|nham roi|nham r|em nham|khong phai|ko phai|k phai|kg phai|hong phai|chi dau co (?:dat|lay|order|noi)|dau co (?:dat|lay|order)|co (?:dat|lay|order) dau|dat (?:bao gio|luc nao))(?: |$)/;

export type FrustrationInput = {
  text: string;
  /** Giỏ có thẩm quyền TRƯỚC / SAU khi áp tin này (engine). */
  before: CartCommitment | undefined;
  after: CartCommitment | undefined;
  /** Bot đã đề nghị một đơn / báo giá cho khách chưa (đơn nháp, báo giá, tổng đã báo). */
  hasOffer: boolean;
  /** Chữ bot / shop đã gửi gần đây (đề nghị gần nhất: tóm tắt, báo giá) — để biết món khách phủ nhận có phải món bot đưa ra không. */
  offeredTexts?: readonly string[];
  /** Có đơn nháp đang mở — món phủ nhận đã gắn mã từ đơn ⇒ cờ cần người kiểm. */
  hasDraft?: boolean;
  /** Số lượt khách đã nói bot SAI trong lượt mua (trước tin này). */
  corrections: number;
  turn: number;
};

/** Lượt này khách có nói BOT SAI không (đếm cho `REPEATED_CORRECTION`). Khách tự đổi ý / lượt «nới» KHÔNG đếm. HÀM THUẦN. */
export function isCorrectionTurn(i: Pick<FrustrationInput, "text" | "hasOffer">): boolean {
  return i.hasOffer && BOT_WRONG_RE.test(foldVi(i.text));
}

/**
 * Món khách phủ nhận có phải món bot / shop ĐÃ ĐƯA RA không: khớp một món trong giỏ (kể cả món bot tự thêm — `customerExplicit = false`),
 * hoặc nằm trong chữ đề nghị gần đây của bot. `inDraft` = món đó đã gắn mã từ đơn nháp đang mở. HÀM THUẦN.
 */
function offeredMatch(label: string, i: FrustrationInput): { what: string; inDraft: boolean } | null {
  const item = (i.before?.selectedItems ?? []).find((x) => labelsMatch(label, x.label || x.match));
  if (item) return { what: item.label || item.match, inDraft: Boolean(i.hasDraft && item.productId) };
  const said = (i.offeredTexts ?? []).some((t) => ` ${foldVi(t)} `.includes(` ${label} `));
  return said ? { what: label, inDraft: false } : null;
}

/**
 * Tin khách này có buộc chuyển người không. Thứ tự: phủ nhận món bot đưa ra (mâu thuẫn đơn — nặng nhất) → xin người → phàn nàn → nói bot
 * sai lần thứ `CORRECTION_HANDOFF_AT`. `null` = để lượt AI chạy như thường. HÀM THUẦN.
 */
export function frustrationSignal(i: FrustrationInput): FrustrationSignal | null {
  const quote = i.text.trim().slice(0, 120);
  // Phủ nhận một món mà bot / shop ĐÃ đưa ra (giỏ, đơn nháp, báo giá / tóm tắt gần đây): đơn đang mâu thuẫn với lời khách. «Không đặt thêm
  // gì nữa», «không đặt cọc», hay phủ nhận một món chưa ai đưa ra ⇒ không phải mâu thuẫn, lượt AI chạy như thường.
  const label = deniedItemLabel(i.text);
  const hit = label ? offeredMatch(label, i) : null;
  if (hit) return { kind: "DENIED_BOT_ITEM", reason: `khách phủ nhận món bot đưa vào đơn («${hit.what}»): «${quote}» — KHÔNG tự chốt, gọi lại khách xác nhận đúng món`, inDraft: hit.inDraft };
  if (asksForHuman(i.text)) return { kind: "ASKS_HUMAN", reason: `khách xin gặp nhân viên: «${quote}»` };
  if (isComplaint(i.text)) return { kind: "COMPLAINT", reason: `khách phàn nàn bot không đọc / hỏi lại: «${quote}»` };
  if (isCorrectionTurn(i) && i.corrections + 1 >= CORRECTION_HANDOFF_AT) return { kind: "REPEATED_CORRECTION", reason: `khách nói bot sai ${i.corrections + 1} lần: «${quote}» — người xác nhận lại đơn` };
  return null;
}
