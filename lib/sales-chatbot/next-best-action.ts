/**
 * ═══════════ VIỆC NÊN LÀM KẾ TIẾP CHO LỜI MỜI MUA THÊM — NEXT BEST ACTION (P0 #868, chủ shop 16/10/2026) — HÀM THUẦN ═══════════
 *
 * Chủ shop đổi luật 16/10/2026: GIỮ upsell / cross-sell nhưng làm cho THÔNG MINH — chốt đúng là việc đầu tiên, lời mời là CƠ HỘI
 * tăng giá trị đơn, KHÔNG BAO GIỜ là điều kiện để lên đơn và không được làm chậm một đơn hợp lệ. Trước bản này máy chủ TỪ CHỐI lên
 * đơn khi chưa gửi câu mẫu upsell (`tools.ts` create_draft_order, 02/10/2026) và lời nhắc B4 buộc gửi menu NGAY sau create_customer —
 * ca HSLC 16/10 (khách đã chọn 2kg chả cá thu): bot quảng cáo dài, hỏi lại «1kg hay 2kg», lặp menu rồi mới tóm tắt.
 *
 * Tệp này quyết ở MÁY CHỦ, mỗi lượt, lời mời nào được đi:
 *  · CỬA SỔ (`offerWindow`): tối đa MỘT lời mời mỗi LƯỢT MUA; khách đã từ chối ⇒ thôi; không mời khi khách đang gửi SĐT / địa chỉ,
 *    khi hồ sơ nhận hàng đã có (đơn đang lên — lời mời lúc này chỉ làm chậm một đơn hợp lệ), khi đã chốt, khách đang phàn nàn, đã
 *    chuyển người, sau lỗi ghi đơn / xin huỷ / từ chối / phản đối giá.
 *  · TỪNG CÂU (`guardReply`): câu mời gói lớn hơn (UPSELL) chỉ đi khi DANH MỤC có lý do giá thật (gói lớn rẻ hơn theo kg, hoặc giảm
 *    theo khối lượng shop khai) ở khối lượng LỚN HƠN số khách đã chọn; câu mời món kèm (CROSS_SELL) chỉ đi khi gọi tên món nằm trong
 *    danh sách mời kèm (`OfferFacts.crossSell` — còn bán, giá đã xác thực, còn hàng, shop khai bổ trợ: câu mẫu UPSELL của shop hoặc
 *    mẫu mã chỉ bán kèm). Câu sai lúc bị BỎ, phần còn lại của tin vẫn gửi — ở mức VẾ câu (review PR #876): chỉ phần LỜI MỜI bị bỏ,
 *    không bao giờ câu trả lời điều khách vừa hỏi, câu hỏi thông tin đơn cần, hay câu xác nhận thay đổi khách đã xin.
 *  · GIỌNG (`guardReply`): bỏ lời chào lặp lại, và bảng giá nhiều quy cách khi khách đã chọn quy cách mà không hỏi giá — nhưng không
 *    bao giờ bỏ HẾT một tin vì giọng (tin chỉ có lời chào vẫn đi).
 * Khách TỰ hỏi món khác / menu ⇒ là TƯ VẤN, không phải lời mời: câu trả lời về đúng món ấy không bị chặn, không bị đếm.
 * Không hàm nào ở đây đổi giỏ, số lượng hay tiền — lời mời chỉ là chữ; món mời vào đơn vẫn chỉ qua lời đồng ý tường minh của khách
 * (`lineBasisViolation`, cart-commitment.ts).
 */
import { purchaseRoundStart } from "@/lib/sales-chatbot/purchase-round";
import { resolveRecipientPlace } from "@/lib/address/vn-address";
import { amountsIn, declinesAddOnOnly, labelsMatch, namedProductsIn, type CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import { foldVi } from "@/lib/sales-chatbot/text";
import type { ChatState } from "@/lib/sales-chatbot/tools";

export type OfferKind = "UPSELL" | "CROSS_SELL";

/** Lý do một lời mời KHÔNG được đi. Khoá ổn định — ops `upsell-offer-audit` và `state.offerDrops` lưu chúng. */
export const OFFER_BLOCKS = ["HANDOFF", "ORDER_PROBLEM", "COMPLAINT", "CONFIRMED", "CONTACT_INFO", "ORDERING", "DECLINED", "ALREADY_OFFERED", "SIZE_CHOSEN", "NO_PRICE_REASON", "NOT_ELIGIBLE"] as const;
export type OfferBlock = (typeof OFFER_BLOCKS)[number];

export const OFFER_BLOCK_LABEL: Record<OfferBlock, string> = {
  HANDOFF: "hội thoại đã chuyển nhân viên",
  ORDER_PROBLEM: "khách đang xin huỷ / từ chối / phản đối giá, hoặc lượt này ghi đơn lỗi",
  COMPLAINT: "khách đang phàn nàn — giải quyết trước, không mời",
  CONFIRMED: "đơn đã chốt — không mời thêm (khách tự hỏi món khác thì tư vấn bình thường)",
  CONTACT_INFO: "khách đang gửi SĐT / địa chỉ — chốt đơn trước, không chen lời mời",
  ORDERING: "đã có thông tin nhận hàng, đơn đang lên — lời mời lúc này làm chậm một đơn hợp lệ",
  DECLINED: "khách đã từ chối lời mời trong lượt mua này",
  ALREADY_OFFERED: "đã mời một lần trong lượt mua này",
  SIZE_CHOSEN: "khách đã chọn quy cách / số lượng — không hỏi lại, không mời gói khác khi không lợi hơn",
  NO_PRICE_REASON: "không có lý do giá thật trong danh mục để mời gói lớn hơn",
  NOT_ELIGIBLE: "món không thuộc danh sách mời kèm (còn bán · còn hàng · giá đã xác thực · shop khai bổ trợ)",
};

/** Số dòng bỏ lời mời nhớ trong `state.offerDrops` (đo đạc — ops đọc). */
export const OFFER_DROPS_MAX = 20;

/** Phần state mà cửa sổ đọc (type-only — tệp này không đọc CSDL). */
export type OfferStateView = Pick<ChatState, "upsellSent" | "upsellDeclinedTurn" | "handoff" | "confirmed" | "declined" | "cancelRequest" | "priceDispute" | "customer" | "draft" | "pastOrders">;

export type OfferWindow = { open: true } | { open: false; reason: OfferBlock };

const PHONE_RE = /(?:\+?84|0)(?:[\s.-]?\d){8,10}(?!\d)/;
/** Chữ chỉ có trong một dòng ĐỊA CHỈ (đã bỏ dấu). Cần ≥ 2 chữ khác nhau — một chữ («quận», «xa») dễ lẫn với câu thường. */
const ADDRESS_CUE_RE = /(?:^| )(so nha|ngo|ngach|hem|kiet|duong|phuong|xa|thi tran|quan|huyen|thi xa|tinh|thanh pho|tp|thon|ap|xom|khu pho|to dan pho|chung cu|toa|so \d+|p \d+|q \d+)(?= |$)/g;

/** Câu khách đang gửi THÔNG TIN NHẬN HÀNG (SĐT, hoặc dòng địa chỉ đọc được tỉnh / có ≥ 2 chữ địa chỉ). HÀM THUẦN. */
export function contactInfoIn(text: string): boolean {
  if (PHONE_RE.test(text)) return true;
  const f = foldVi(text);
  const cues = new Set([...f.matchAll(ADDRESS_CUE_RE)].map((m) => m[1]));
  if (cues.size >= 2) return true;
  return cues.size >= 1 && Boolean(resolveRecipientPlace({ address: text, province: "" }).province);
}

/**
 * Cửa sổ lời mời của LƯỢT này — một lời mời (câu mẫu UPSELL hay câu model) chỉ đi khi mở. `complaint` = câu khách là than phiền
 * (`customerComplaintSignal`, lifecycle.ts — nơi gọi tính); `orderError` = lượt này ghi đơn lỗi; `returningPending` = khách cũ đang
 * xác nhận địa chỉ lần trước (khối KHÁCH CŨ) khi giỏ đã có món — lượt đó là lượt lên đơn. HÀM THUẦN.
 */
export function offerWindow(input: { state: OfferStateView; lastUserText: string; complaint: boolean; orderError?: boolean; returningPending?: boolean }): OfferWindow {
  const s = input.state;
  if (s.handoff) return { open: false, reason: "HANDOFF" };
  if (input.orderError || s.cancelRequest || s.declined || s.priceDispute?.open) return { open: false, reason: "ORDER_PROBLEM" };
  if (input.complaint) return { open: false, reason: "COMPLAINT" };
  if (s.confirmed) return { open: false, reason: "CONFIRMED" };
  if (contactInfoIn(input.lastUserText)) return { open: false, reason: "CONTACT_INFO" };
  if (customerThisRound(s) || s.draft || input.returningPending) return { open: false, reason: "ORDERING" };
  if (s.upsellDeclinedTurn !== undefined) return { open: false, reason: "DECLINED" };
  if (s.upsellSent) return { open: false, reason: "ALREADY_OFFERED" };
  return { open: true };
}

/**
 * Hồ sơ nhận hàng thuộc LƯỢT MUA HIỆN TẠI (review PR #876): lượt mua mới (engine — đơn cũ sang `pastOrders`) xoá nháp nhưng GIỮ
 * `customer` (gợi ý khách cũ), nên «có `customer`» đóng cửa sổ ORDERING mãi mãi sau đơn đầu. Mốc là lúc lượt mua bắt đầu (lúc chốt
 * của đơn gần nhất trong `pastOrders`, cùng mốc `purchaseRoundStart` — purchase-round.ts, gồm cả `roundStartAt`): hồ sơ ghi TRƯỚC mốc đó (hay không có mốc ghi) là
 * của lượt mua cũ. HÀM THUẦN.
 */
function customerThisRound(s: Pick<ChatState, "customer" | "pastOrders" | "roundStartAt">): boolean {
  if (!s.customer) return false;
  const start = purchaseRoundStart(s)?.getTime() ?? NaN;
  if (!Number.isFinite(start)) return true;
  const at = s.customer.at ? Date.parse(s.customer.at) : NaN;
  return Number.isFinite(at) && at > start;
}

/**
 * Khách TỪ CHỐI lời mời — chỉ xét ở lượt khách NGAY SAU lời mời (nơi gọi kiểm). «không», «thôi», «không cần / không lấy (thêm)»,
 * «để lần sau», «2kg thôi», «đủ rồi». Câu đồng ý («ok lấy thêm», «lấy 1 hũ») không phải. HÀM THUẦN.
 */
export function offerDeclinedBy(text: string): boolean {
  if (declinesAddOnOnly(text)) return true;
  const f = foldVi(text);
  if (!f) return false;
  if (/^(?:da |vang |u |uhm |thoi )?(?:khong|ko|k|hong|hok|khoi|chua)(?: |$)/.test(f)) return true;
  if (/^thoi(?: (?:em|e|a|nhe|nha|shop|chi|anh|minh|khoi|vay|de sau))*$/.test(f)) return true;
  if (/(?:^| )(?:khong|ko|k|hong|chua) (?:can|lay|mua|dat|an|dung|thich)(?: |$)/.test(f)) return true;
  return /(?:^| )(?:thoi|du roi|khoi)$/.test(f);
}

/** Lớp của MỘT câu bot. `null` = câu thường (không mời, không vướng giọng). */
export type SentenceClass = "UPSELL" | "CROSS_SELL" | "SIZE_REASK" | "PRICE_LIST" | "GREETING";

const SIZE_WORD = String.raw`\d+(?: \d+)? ?(?:kg|kgs|ki|ky|g|gr|gram|lang|can)`;
const SIZE_REASK_RE = new RegExp(`(?:^| )${SIZE_WORD} hay (?:la )?${SIZE_WORD}(?: |$)`);
const SAVING_RE = /(?:^| )(?:re hon|tiet kiem|loi hon|hoi hon|duoc giam|giam (?:con|them|ngay|\d+)|chi con|uu dai|nang len|doi sang|chuyen sang|lay luon|lay han|mua han)(?: |$)/;
const CROSS_RE = /(?:^| )(?:dung kem|an kem|cham kem|mua kem|lay kem|dat kem|kem theo|kem them|kem voi|mua them|lay them|dat them|chon them|thu them|xem them|dung them|an them|bo sung|them (?:mon|mot|1|it|vai|hu|chai|hop|goi|tui|phan)|mon khac|combo|menu|thuc don)(?: |$)/;
/** «Mình lấy thêm gì không» — câu hỏi CHUNG của bước chốt, không gọi tên món nào ⇒ không phải lời mời. */
const GENERIC_MORE_RE = /(?:^| )(?:lay|mua|can|dat|ho tro|chon|dung) them (?:mon )?(?:gi|j|nua|nao)(?: |$)|(?:^| )them (?:mon )?(?:gi|nao)(?: |$)/g;
/**
 * Câu xác nhận món KHÁCH vừa xin thêm («em thêm 1 hũ ruốc vào đơn rồi ạ») — không phải lời mời. CHỈ khi câu ở dạng ĐÃ XONG và không
 * phải câu hỏi (review PR #876): «Chị lấy thêm 1 hũ ruốc cá vào đơn cho đủ bữa nhé ạ?» cũng có «vào đơn» mà là lời mời.
 */
const ACK_RE = /(?:^| )(?:vao don|len don|da them|em them|them vao|them cho minh roi)(?: |$)/;
/** Động từ ĐỔI ĐƠN («đổi sang», «nâng lên»…) — dạng đã xong là câu xác nhận thay đổi, không phải lời mời gói lớn. Bản gập dấu. */
const CHANGE_VERB_RE = /(?:^| )(?:doi sang|doi thanh|doi lai|chuyen sang|nang len|lay luon|sua thanh|sua lai|cap nhat)(?: |$)/;
/** Câu kể việc ĐÃ làm («em đã thêm», «… rồi ạ», «em vừa đổi») — trên chữ CÓ DẤU, vì bản gập dấu không tách «đã» khỏi «dạ». */
const COMPLETED_RE = /(?:^|[\s,.(])(?:đã|rồi|em vừa|shop vừa)(?=[\s,.!?)…]|$)/u;
const INVITE_VERB_RE = /(?:^| )(?:co muon|moi (?:anh |chi |minh |ban |a |c )?(?:thu|xem|tham khao|dung|mua|dat))(?: |$)/;
const clauseFolds = (raw: string) => raw.split(/[,;.!…\n]+/).map((c) => foldVi(c)).filter(Boolean);
/** Câu HỎI: «?», động từ mời («có muốn», «mời chị thử»), hay một vế kết bằng «không / chưa». HÀM THUẦN. */
function asking(raw: string): boolean {
  return raw.includes("?") || INVITE_VERB_RE.test(foldVi(raw)) || clauseFolds(raw).some((c) => /(?:^| )(?:khong|ko|chua)(?: a)?$/.test(c));
}
/** Lời MỜI: câu hỏi, hay một vế kết bằng tiểu từ mời «nhé / nha / nè». «Dạ 2kg là 540.000đ ạ» là câu TRẢ LỜI. HÀM THUẦN. */
function inviting(raw: string): boolean {
  return asking(raw) || clauseFolds(raw).some((c) => /(?:^| )(?:nhe|nha|ne|nhen|nghen)(?: a)?$/.test(c));
}
/** Câu ở dạng ĐÃ XONG và không hỏi — câu kể / câu xác nhận. HÀM THUẦN. */
const doneStatement = (raw: string) => COMPLETED_RE.test(raw.normalize("NFC").toLowerCase()) && !asking(raw);
const GREETING_RE = /^(?:da |vang |xin )?(?:em |shop |ben em )?(?:xin )?chao (?:anh|chi|ban|minh|quy khach|ca nha|a|c|e|nang)(?: |$)|^(?:da )?(?:em |shop )?cam on (?:anh|chi|ban|minh|quy khach|a|c)(?: \S+)? (?:da )?(?:quan tam|nhan tin|lien he|ung ho|ghe)(?: |$)/;
const SUMMARY_RE = /(?:^| )(?:tong|don|ship|cod|thanh toan|phi)(?: |$)/;
const VND_RE = /\d[\d.,]*\s*(?:đ|₫|k(?![\p{L}])|nghìn|ngàn|vnđ|vnd|tr(?![\p{L}]))/giu;

function isQuestion(raw: string, f: string): boolean {
  return raw.includes("?") || /(?:^| )(?:a|ak|nhe|nha|nhen|vay|khong|ko|chi|anh|em|minh|nao)$/.test(f);
}

/** Lớp của một câu bot (đã cắt câu). HÀM THUẦN. */
export function classifySentence(raw: string): SentenceClass | null {
  const f = foldVi(raw);
  if (!f) return null;
  // Chỉ câu CHÀO thuần (không kèm câu hỏi, ngắn) — «Dạ em chào chị, chị cần món gì ạ?» mang một câu hỏi, không phải lời chào lặp.
  if (GREETING_RE.test(f) && !raw.includes("?") && f.split(" ").length <= 12) return "GREETING";
  if (SIZE_REASK_RE.test(f) && isQuestion(raw, f)) return "SIZE_REASK";
  const weights = new Set(amountsIn(raw).filter((a) => a.unit === "g").map((a) => a.value));
  const money = raw.match(VND_RE)?.length ?? 0;
  if (money >= 2 && weights.size >= 2 && !SUMMARY_RE.test(f)) return "PRICE_LIST";
  // Câu kể việc ĐÃ xong không phải lời mời — nhưng miễn trừ chỉ phủ VẾ đã-xong (review PR #876): vế mời đi kèm trong cùng câu
  // («Dạ em đã đổi sang 2kg rồi, chị lấy luôn 3kg cho rẻ hơn ạ») vẫn là lời mời, và cả câu mang lớp của nó để hàng rào cắt đúng vế đó.
  if ((ACK_RE.test(f) || CHANGE_VERB_RE.test(f)) && doneStatement(raw)) return riderAfterDone(raw);
  if (SAVING_RE.test(f) && weights.size >= 1) return "UPSELL";
  if (CROSS_RE.test(f.replace(GENERIC_MORE_RE, " "))) return "CROSS_SELL";
  return null;
}

const OFFER_CLASSES: readonly (SentenceClass | null)[] = ["UPSELL", "CROSS_SELL"];

/**
 * Vế MỜI đi ké một câu đã-xong. Vế đã-xong đầu tiên (`doneStatement`) là phần được miễn; một vế mời là đi ké khi nó đứng SAU vế đó,
 * hay không mang động từ thêm / đổi nào (nên không thể là một nửa của câu xác nhận). Vế mời đứng TRƯỚC và mang động từ đổi
 * («Dạ em đổi sang 2kg cho chị, em xác nhận rồi ạ») là chính việc được kể. HÀM THUẦN.
 */
function riderAfterDone(raw: string): SentenceClass | null {
  const cs = clausesOf(raw);
  if (cs.length < 2) return null;
  const done = cs.findIndex((c) => doneStatement(c));
  for (let i = 0; i < cs.length; i++) {
    if (i === done) continue;
    const k = classifySentence(cs[i]);
    if (!OFFER_CLASSES.includes(k)) continue;
    const f = foldVi(cs[i]);
    if ((done >= 0 && i > done) || !(ACK_RE.test(f) || CHANGE_VERB_RE.test(f))) return k;
  }
  return null;
}

/**
 * Có câu (hay VẾ câu) nào CẦN dữ kiện danh mục để kiểm không — `false` ⇒ nơi gọi khỏi đọc CSDL. Câu hỏi lại quy cách / bảng giá chỉ
 * cần danh mục khi giỏ đã có món khách chọn (`cart`): phải biết câu đang nói về MÓN NÀO mới biết quy cách của món ấy đã chọn chưa
 * (review PR #876 — «chả mực 500g hay 1kg» khi giỏ chỉ có chả cá). HÀM THUẦN.
 */
export function needsOfferFacts(text: string, cart?: CartCommitment): boolean {
  const chosen = explicitItems(cart).length > 0;
  const needs = (s: string) => {
    const c = classifySentence(s);
    return c === "UPSELL" || c === "CROSS_SELL" || (chosen && (c === "SIZE_REASK" || c === "PRICE_LIST"));
  };
  return splitSentences(text).some((s) => needs(s) || clausesOf(s).some(needs));
}

/**
 * Cắt một câu thành VẾ theo «, » / «; » (có khoảng trắng sau — «300,000đ» không bị cắt), và theo « và » khi phần sau tự nó là một lời
 * mời («Em đã thêm vào đơn rồi và chị mua thêm chả mực … ạ») — «2kg chả cá và 1 hũ ruốc» thì không cắt. HÀM THUẦN.
 */
function clausesOf(sentence: string): string[] {
  return sentence.split(/\s*[,;]\s+/).flatMap(splitOfferAnd).map((x) => x.trim()).filter(Boolean);
}

function splitOfferAnd(clause: string): string[] {
  const re = /\s+và\s+/gu;
  for (const m of clause.matchAll(re)) {
    const before = clause.slice(0, m.index).trim();
    const after = clause.slice((m.index ?? 0) + m[0].length).trim();
    if (before && after && OFFER_CLASSES.includes(classifySentence(after))) return [before, after];
  }
  return [clause];
}

/**
 * Cắt chữ thành câu, GIỮ NGUYÊN mọi ký tự (nối lại các mảnh ra đúng chữ gốc). Hết câu = «. ! ? …» theo sau là khoảng trắng / hết chữ,
 * hoặc xuống dòng — «540.000đ» không bị cắt. Không dùng nhìn-ngược (Safari < 16.4). HÀM THUẦN.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    cur += ch;
    const next = text[i + 1];
    if (ch === "\n" || (/[.!?…]/.test(ch) && (next === undefined || /\s/.test(next)))) {
      while (i + 1 < text.length && /[ \t]/.test(text[i + 1])) cur += text[++i];
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Dữ kiện danh mục cho lời mời (nơi gọi đọc CSDL — `offer-facts.ts`). `crossSell` = TÊN sản phẩm được phép mời kèm; `volume` = sản
 * phẩm có lý do giá thật để mời khối lượng lớn hơn, kèm khối lượng nhỏ nhất bắt đầu được lợi (gram); `menu` = shop có câu mẫu UPSELL
 * đang bật (lời mời «xem menu» không gọi tên món là của chính shop); `freeShip` = shop bật miễn ship theo ngưỡng (lý do giá thật của
 * câu «thêm … là được miễn ship»).
 */
export type OfferFacts = { catalogNames: readonly string[]; crossSell: readonly string[]; volume: readonly { name: string; saveFromGrams: number }[]; menu: boolean; freeShip: boolean };

export type ReplyGuardInput = {
  window: OfferWindow;
  cart?: CartCommitment;
  lastUserText: string;
  /** Shop / bot đã nói ít nhất một câu trước lượt này (lời chào mở đầu, câu page…) ⇒ lời chào mới là lặp. */
  greetedBefore: boolean;
  /** `null` = chưa đọc (không câu mời nào cần kiểm) — câu mời gặp `null` bị bỏ: không kiểm được thì không gửi. */
  facts: OfferFacts | null;
};

export type ReplyDrop = { cls: SentenceClass; reason: OfferBlock | "STYLE" };
export type ReplyGuardResult = { text: string; offered: OfferKind | null; dropped: ReplyDrop[] };

const FREE_SHIP_RE = /(?:^| )(?:mien (?:phi )?ship|free ?ship|mien phi van chuyen|mien phi giao(?: hang)?)(?: |$)/;
const MENU_RE = /(?:^| )(?:menu|thuc don)(?: |$)/;
const PRICE_ASK_RE = /(?:^| )(?:gia|bao nhieu|bn|bnhieu|nhieu tien|may tien|tinh sao|het bao)(?: |$)/;
const MENU_ASK_RE = /(?:^| )(?:menu|thuc don|mon khac|mon gi|con gi|co gi|co ban|ban gi|xem them|them mon|lay them|mua them|kem)(?: |$)/;
/** Khách hỏi QUY CÁCH / LOẠI («chả mực có mấy loại em», «size nào») — câu trả lời kể quy cách, giá từng loại. Bản gập dấu. */
const OPTIONS_ASK_RE = /(?:^| )(?:may loai|loai nao|loai gi|nhung loai|bao nhieu loai|co loai|may size|size nao|co size|quy cach|may kg|may ky|may goi|goi nao|may hop)(?: |$)/;
/** Khách XIN ĐỔI đơn («đổi sang 2kg», «nâng lên 3kg», «chuyển giao địa chỉ khác») — câu xác nhận đổi là đúng lúc. Bản gập dấu. */
const CHANGE_ASK_RE = /(?:^| )(?:(?:doi|chuyen) (?:sang|thanh|lai|qua|ve|giao|dia chi|\d)|nang len|tang len|sua (?:lai|thanh|don|dia chi)|thay (?:doi|bang|dia chi)|cap nhat)(?: |$)/;
/** Vế XIN THÔNG TIN nhận hàng — đơn cần nó, không bao giờ bị bỏ theo một vế mời đứng trước. Bản gập dấu. */
const INFO_ASK_RE = /(?:^| )(?:xin|sdt|so dien thoai|dia chi|so nha|ho ten|nguoi nhan|thong tin nhan)(?: |$)/;
/** Vế kể TỔNG TIỀN / phí ship / COD của đơn. Bản gập dấu. */
const TOTAL_RE = /(?:^| )(?:tong|tong cong|ship|phi ship|cod|thanh toan)(?: |$)/;
/** Vế chỉ là tiếng đệm («Dạ», «vâng ạ», «chị ơi») — đứng một mình thì không phải nội dung. Bản gập dấu. */
const FILLER_RE = /^(?:(?:da|vang|a|oi|chi|anh|em|minh|ban|c|e|nhe|nha|ok|okie|uh|u)(?: |$))*$/;

/** Câu gọi tên một món trong giỏ bằng HAI chữ đầu của nhãn («chả mực» cho «Chả mực giã tay») — đủ để nhận dòng tóm tắt đơn. HÀM THUẦN. */
function mentionsLabel(raw: string, label: string): boolean {
  const head = foldVi(label.replace(/\s*\([^)]*\)\s*$/, "")).split(" ").slice(0, 2).join(" ");
  return Boolean(head) && ` ${foldVi(raw)} `.includes(` ${head} `);
}

/**
 * Sản phẩm được gọi tên trong câu (`namedProductsIn`), bỏ tên chỉ khớp MỘT PHẦN khi có tên khác khớp TRỌN: «cá thu một nắng» không
 * được tính là gọi «Chả cá thu» (đủ hai từ «cá thu» nhưng thiếu «chả»). HÀM THUẦN.
 */
export function namedIn(text: string, names: readonly string[]): string[] {
  const found = namedProductsIn(text, names);
  const said = ` ${foldVi(text)} `;
  const full = (n: string) => foldVi(n.replace(/\s*\([^)]*\)\s*$/, "")).split(" ").every((w) => said.includes(` ${w} `));
  return found.some(full) ? found.filter(full) : found;
}

const explicitItems = (cart?: CartCommitment) => cart?.selectedItems.filter((x) => x.customerExplicit) ?? [];
const inCart = (name: string, cart?: CartCommitment) => (cart?.selectedItems ?? []).some((x) => (x.label && labelsMatch(x.label, name)) || (x.match && labelsMatch(x.match, name)));

/** Khối lượng (gram) khách đã chọn TƯỜNG MINH cho một món — `undefined` = chưa chọn; `null` = đã chọn mà không quy ra gram được. */
function chosenGrams(cart: CartCommitment | undefined, name: string | null): number | null | undefined {
  const items = explicitItems(cart);
  const it = name ? items.find((x) => (x.label && labelsMatch(x.label, name)) || (x.match && labelsMatch(x.match, name))) : items.length === 1 ? items[0] : undefined;
  if (!it) return undefined;
  if (it.unit === "g") return it.quantity;
  return it.packGrams ? it.quantity * it.packGrams : null;
}

/**
 * HÀNG RÀO LỜI MỜI + GIỌNG cho MỘT đoạn chữ bot sắp gửi. Không câu nào bị bỏ ⇒ trả NGUYÊN VĂN chữ gốc. `offered` = loại lời mời
 * ĐẦU TIÊN được đi (nơi gọi ghi `upsellSent` / `upsellTurn` — tối đa một lời mời mỗi lượt mua, câu mời thứ hai trong cùng tin cũng bị
 * bỏ). Câu bỏ vì GIỌNG không bao giờ làm tin rỗng. HÀM THUẦN.
 *
 * NGUYÊN TẮC (review PR #876): hàng rào chỉ được bỏ phần LỜI MỜI. Không bao giờ bỏ (a) câu trả lời đúng điều khách vừa hỏi (giá /
 * quy cách / loại), (b) câu hỏi thông tin đơn cần (SĐT · địa chỉ · quy cách của món khách VỪA xin), (c) câu xác nhận thay đổi khách
 * đã xin. Làm ở mức VẾ câu (như `post-sale-guard.ts`): câu một hơi «xin SĐT và địa chỉ, chị có muốn lấy thêm … không ạ?» chỉ mất vế
 * mời. Không đọc được danh mục (`facts: null`) ⇒ không bỏ câu trả lời / câu hỏi; chỉ bỏ lời mời không ai hỏi.
 */
export function guardReply(text: string, input: ReplyGuardInput): ReplyGuardResult {
  const parts = splitSentences(text);
  const cart = input.cart;
  const custF = foldVi(input.lastUserText);
  const priceAsked = PRICE_ASK_RE.test(custF);
  const optionsAsked = OPTIONS_ASK_RE.test(custF);
  // Khách vừa hỏi giá / quy cách / có mấy loại ⇒ câu kể giá, giảm theo gói là câu TRẢ LỜI, kể cả khi đơn đang lên hay đã chọn quy cách.
  const asked = priceAsked || optionsAsked;
  const changeAsked = CHANGE_ASK_RE.test(custF);
  const custGrams = new Set(amountsIn(input.lastUserText).filter((a) => a.unit === "g").map((a) => a.value));
  const gramsOf = (t: string) => amountsIn(t).filter((a) => a.unit === "g").map((a) => a.value);
  /** Mọi khối lượng chữ nêu nằm trong số khách vừa xin (khách không nêu khối lượng ⇒ không ràng). */
  const gramsAsked = (t: string) => !custGrams.size || gramsOf(t).every((g) => custGrams.has(g));
  /**
   * VẾ là chính THAY ĐỔI khách vừa xin (review PR #876): không hỏi, có động từ đổi hay nêu khối lượng, và khối lượng nằm trong số khách
   * vừa xin («đổi sang 2kg» ⇒ «em đổi sang 2kg chả cá thu» là xác nhận; «lấy luôn 3kg cho rẻ hơn», «chị lấy thêm chả mực» là lời mời).
   */
  const requestedChange = (c: string) => !asking(c) && gramsAsked(c) && (CHANGE_VERB_RE.test(foldVi(c)) || gramsOf(c).length > 0);
  /** Miễn trừ «xác nhận thay đổi» chỉ phủ vế là thay đổi được xin — câu còn một vế mời khác ⇒ không miễn, hàng rào cắt vế mời. */
  const changeConfirm = (raw: string) =>
    changeAsked && !asking(raw) && gramsAsked(raw) && !clausesOf(raw).some((c) => !requestedChange(c) && OFFER_CLASSES.includes(classifySentence(c)));
  const catalog = input.facts?.catalogNames ?? [];
  // Tên món trong giỏ luôn biết (kể cả khi chưa đọc danh mục) — để nhận câu nói về món đã chọn.
  const cartLabels = (cart?.selectedItems ?? []).map((x) => x.label).filter((x): x is string => Boolean(x));
  const names = [...catalog, ...cartLabels.filter((l) => !catalog.some((n) => labelsMatch(n, l)))];
  // Chưa đọc được danh mục ⇒ chỉ nhận tên món TRONG GIỎ theo hai chữ đầu nhãn: so khớp đầu-từ của `namedIn` trên danh mục một món
  // nhận «chả mực» là «Chả cá thu» (chung chữ «chả»).
  const namedOf = (t: string) => (input.facts ? (names.length ? namedIn(t, names) : []) : cartLabels.filter((l) => mentionsLabel(t, l)));
  const custNamed = namedOf(input.lastUserText);
  // TƯ VẤN: khách tự gọi tên món ngoài giỏ / hỏi menu, món khác ⇒ câu về đúng món ấy là câu trả lời, không phải lời mời.
  const askedNames = custNamed.filter((n) => !inCart(n, cart));
  const menuAsked = MENU_ASK_RE.test(custF);
  /**
   * Quy cách đã chọn CHO MÓN CÂU ĐANG NÓI (review PR #876): «chả mực 500g hay 1kg» khi giỏ chỉ có chả cá thu là hỏi quy cách món khách
   * VỪA xin — phải giữ. Câu không gọi tên món: khách vừa gọi tên một món chưa chọn quy cách ⇒ chưa chọn; không đọc được danh mục ⇒
   * không biết câu nói món nào ⇒ coi như chưa chọn (không bỏ câu hỏi đơn cần).
   */
  const sizeChosenFor = (named: string[]): boolean => {
    if (named.length) return named.every((n) => chosenGrams(cart, n) !== undefined);
    if (!input.facts || custNamed.some((n) => chosenGrams(cart, n) === undefined)) return false;
    return chosenGrams(cart, null) !== undefined;
  };
  let window = input.window;
  let offered: OfferKind | null = null;
  type Verdict = { keep: true } | { keep: false; drop: ReplyDrop };
  const KEEP: Verdict = { keep: true };
  const judge = (raw: string, cls: SentenceClass): Verdict => {
    const block = (reason: OfferBlock | "STYLE"): Verdict => ({ keep: false, drop: { cls, reason } });
    if (cls === "GREETING") return input.greetedBefore ? block("STYLE") : KEEP;
    const named = namedOf(raw);
    if (cls === "PRICE_LIST") {
      if (asked) return KEEP;
      // Dòng tóm tắt ĐƠN liệt kê ≥ 2 món trong giỏ kèm giá — không phải bảng giá nhiều quy cách.
      if (cartLabels.filter((l) => mentionsLabel(raw, l)).length >= 2) return KEEP;
      // Chỉ bảng giá của MÓN ĐÃ CHỌN quy cách mới thừa — bảng giá món khác vẫn đi.
      return sizeChosenFor(named) ? block("STYLE") : KEEP;
    }
    if (cls === "SIZE_REASK") return sizeChosenFor(named) && !optionsAsked ? block("SIZE_CHOSEN") : KEEP;
    const others = named.filter((n) => !inCart(n, cart));
    // Câu «mời món kèm» chỉ gọi tên món ĐÃ trong giỏ («thêm 1kg chả cá nữa») là mời TĂNG khối lượng ⇒ xét như UPSELL.
    const kind: OfferKind = cls === "CROSS_SELL" && named.length > 0 && others.length === 0 ? "UPSELL" : cls;
    if (kind === "CROSS_SELL" && (menuAsked || (others.length > 0 && others.every((n) => askedNames.some((a) => labelsMatch(a, n)))))) return KEEP;
    if (kind === "UPSELL" && priceAsked && !sizeChosenFor(named)) return KEEP;
    // Câu TRẢ LỜI giá / quy cách khách vừa hỏi («Dạ 2kg là 540.000đ, rẻ hơn 20.000đ ạ») hay xác nhận THAY ĐỔI khách vừa xin («Dạ em đổi
    // sang 2kg cho chị nhé, tổng …») — không phải lời mời, không bị đếm.
    if (kind === "UPSELL" && ((asked && !inviting(raw)) || changeConfirm(raw))) return KEEP;
    if (!window.open) return block(window.reason);
    if (!input.facts) return block(kind === "UPSELL" ? "NO_PRICE_REASON" : "NOT_ELIGIBLE");
    const f = foldVi(raw);
    // «Thêm … là được miễn ship» — miễn ship theo ngưỡng của shop là lý do giá thật (món khác gọi tên vẫn phải đủ điều kiện mời kèm).
    const freeShipReason = input.facts.freeShip && FREE_SHIP_RE.test(f);
    if (kind === "UPSELL") {
      if (!freeShipReason) {
        const target = named.find((n) => inCart(n, cart)) ?? named[0] ?? explicitItems(cart)[0]?.label ?? null;
        const reason = target ? input.facts.volume.find((v) => labelsMatch(v.name, target)) : undefined;
        if (!reason) return block("NO_PRICE_REASON");
        const chosen = chosenGrams(cart, target);
        if (chosen === null || (chosen !== undefined && chosen >= reason.saveFromGrams)) return block("SIZE_CHOSEN");
      }
    } else if (others.length) {
      const allowed = input.facts.crossSell;
      if (!others.every((n) => allowed.some((a) => labelsMatch(a, n)))) return block("NOT_ELIGIBLE");
    } else if (!freeShipReason && !(input.facts.menu && MENU_RE.test(f))) {
      // Mời chung chung không gọi tên món nào («mình dùng thêm nước chấm không ạ») — không kiểm được món có bán / còn hàng ⇒ bỏ.
      return block("NOT_ELIGIBLE");
    }
    offered = kind;
    window = { open: false, reason: "ALREADY_OFFERED" };
    return KEEP;
  };
  /**
   * Câu bị bỏ ⇒ thử giữ các VẾ không phải lời mời: vế mời / hỏi lại quy cách / mảnh bảng giá bị bỏ, cùng vế mời treo NGAY SAU một vế đã
   * bỏ («…, cho đủ bữa nhé ạ?») — trừ vế xin thông tin nhận hàng. Còn vế có nội dung ⇒ ghép lại (vế cuối gốc bị bỏ ⇒ kết bằng «.»);
   * không còn gì ngoài tiếng đệm, hay không vế nào bị bỏ (câu chỉ sai khi đọc cả câu) ⇒ `null`: bỏ cả câu.
   */
  const keptClauses = (raw: string, parent: SentenceClass): { text: string; drops: ReplyDrop[] } | null => {
    const body = raw.replace(/\s+$/u, "");
    const tail = raw.slice(body.length);
    const clauses = clausesOf(body);
    if (clauses.length < 2) return null;
    const keep: boolean[] = [];
    const drops: ReplyDrop[] = [];
    clauses.forEach((c) => {
      const cc = classifySentence(c);
      const f = foldVi(c);
      let v: Verdict = KEEP;
      if (cc) v = judge(c, cc);
      else if (parent === "PRICE_LIST" && (c.match(VND_RE)?.length ?? 0) > 0) v = { keep: false, drop: { cls: "PRICE_LIST", reason: "STYLE" } };
      // Vế đứng SAU một vế mời đã bỏ là phần đuôi của lời mời («…, cho đủ bữa nhé ạ?», «…, ngon lắm ạ») — trừ vế xin thông tin nhận
      // hàng và vế tổng tiền / ship (đơn cần chúng).
      else if (drops.length && !INFO_ASK_RE.test(f) && !TOTAL_RE.test(f)) v = { keep: false, drop: drops[drops.length - 1] };
      keep.push(v.keep);
      if (!v.keep && v.drop !== drops[drops.length - 1]) drops.push(v.drop);
    });
    const kept = clauses.filter((_, i) => keep[i]);
    if (kept.length === clauses.length || kept.every((p) => FILLER_RE.test(foldVi(p)))) return null;
    let out = kept.map((p) => p.replace(/[,;]+$/u, "")).join(", ");
    if (!keep[keep.length - 1]) out = `${out.replace(/[\s.!?…,;]+$/u, "")}.`;
    return { text: `${out.charAt(0).toLocaleUpperCase("vi")}${out.slice(1)}${tail}`, drops };
  };
  type Item = { text: string | null; drops: ReplyDrop[]; style: boolean };
  const items: Item[] = parts.map((raw) => {
    const cls = classifySentence(raw);
    if (!cls) return { text: raw, drops: [], style: false };
    const v = judge(raw, cls);
    if (v.keep) return { text: raw, drops: [], style: false };
    const partial = cls === "GREETING" ? null : keptClauses(raw, cls);
    if (partial) return { text: partial.text, drops: partial.drops, style: false };
    return { text: null, drops: [v.drop], style: v.drop.reason === "STYLE" };
  });
  if (items.every((x) => !x.drops.length)) return { text, offered, dropped: [] };
  // Câu bỏ vì GIỌNG chỉ bỏ khi còn lại ít nhất một câu có chữ — tin chỉ có lời chào / bảng giá vẫn đi.
  const keptAny = items.some((x) => x.text !== null && x.text.trim());
  const final = items.map((x, i) => (x.text === null && x.style && !keptAny ? { text: parts[i], drops: [], style: false } : x));
  const out = final.map((x) => x.text ?? "").join("").trim();
  return { text: out, offered, dropped: final.flatMap((x) => x.drops) };
}

/** Ghi một lần bỏ lời mời vào state (đo đạc, có trần). Trả mảng MỚI. HÀM THUẦN. */
export function withOfferDrops(prev: ChatState["offerDrops"], turn: number | undefined, drops: readonly ReplyDrop[], via: "TEXT" | "QUICK_REPLY"): NonNullable<ChatState["offerDrops"]> {
  const add = drops.filter((d) => d.reason !== "STYLE").map((d) => ({ turn: turn ?? null, cls: d.cls, reason: d.reason as OfferBlock, via }));
  return [...(prev ?? []), ...add].slice(-OFFER_DROPS_MAX);
}
