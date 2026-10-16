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
 *    mẫu mã chỉ bán kèm). Câu sai lúc bị BỎ, phần còn lại của tin vẫn gửi.
 *  · GIỌNG (`guardReply`): bỏ lời chào lặp lại, và bảng giá nhiều quy cách khi khách đã chọn quy cách mà không hỏi giá — nhưng không
 *    bao giờ bỏ HẾT một tin vì giọng (tin chỉ có lời chào vẫn đi).
 * Khách TỰ hỏi món khác / menu ⇒ là TƯ VẤN, không phải lời mời: câu trả lời về đúng món ấy không bị chặn, không bị đếm.
 * Không hàm nào ở đây đổi giỏ, số lượng hay tiền — lời mời chỉ là chữ; món mời vào đơn vẫn chỉ qua lời đồng ý tường minh của khách
 * (`lineBasisViolation`, cart-commitment.ts).
 */
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
export type OfferStateView = Pick<ChatState, "upsellSent" | "upsellDeclinedTurn" | "handoff" | "confirmed" | "declined" | "cancelRequest" | "priceDispute" | "customer" | "draft">;

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
  if (s.customer || s.draft || input.returningPending) return { open: false, reason: "ORDERING" };
  if (s.upsellDeclinedTurn !== undefined) return { open: false, reason: "DECLINED" };
  if (s.upsellSent) return { open: false, reason: "ALREADY_OFFERED" };
  return { open: true };
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
const GENERIC_MORE_RE = /(?:^| )(?:lay|mua|can|dat|ho tro|chon|dung) them (?:mon )?(?:gi|j|nua)(?: |$)|(?:^| )them (?:mon )?gi(?: |$)/g;
/** Câu xác nhận món KHÁCH vừa xin thêm («em thêm 1 hũ ruốc vào đơn rồi ạ») — không phải lời mời. */
const ACK_RE = /(?:^| )(?:vao don|len don|da them|em them|them vao|them cho minh roi)(?: |$)/;
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
  if (ACK_RE.test(f)) return null;
  if (SAVING_RE.test(f) && weights.size >= 1) return "UPSELL";
  if (CROSS_RE.test(f.replace(GENERIC_MORE_RE, " "))) return "CROSS_SELL";
  return null;
}

/** Có câu nào CẦN dữ kiện danh mục để kiểm không — `false` ⇒ nơi gọi khỏi đọc CSDL. HÀM THUẦN. */
export function needsOfferFacts(text: string): boolean {
  return splitSentences(text).some((s) => {
    const c = classifySentence(s);
    return c === "UPSELL" || c === "CROSS_SELL";
  });
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
 */
export function guardReply(text: string, input: ReplyGuardInput): ReplyGuardResult {
  const parts = splitSentences(text);
  const sizeChosen = explicitItems(input.cart).length > 0;
  const custF = foldVi(input.lastUserText);
  const priceAsked = PRICE_ASK_RE.test(custF);
  const names = input.facts?.catalogNames ?? [];
  // TƯ VẤN: khách tự gọi tên món ngoài giỏ / hỏi menu, món khác ⇒ câu về đúng món ấy là câu trả lời, không phải lời mời.
  const askedNames = names.length ? namedIn(input.lastUserText, names).filter((n) => !inCart(n, input.cart)) : [];
  const menuAsked = MENU_ASK_RE.test(custF);
  let window = input.window;
  let offered: OfferKind | null = null;
  const verdicts: ({ keep: true } | { keep: false; drop: ReplyDrop })[] = parts.map((raw) => {
    const cls = classifySentence(raw);
    if (!cls) return { keep: true };
    if (cls === "GREETING") return input.greetedBefore ? { keep: false, drop: { cls, reason: "STYLE" } } : { keep: true };
    if (cls === "PRICE_LIST") return sizeChosen && !priceAsked ? { keep: false, drop: { cls, reason: "STYLE" } } : { keep: true };
    if (cls === "SIZE_REASK") return sizeChosen ? { keep: false, drop: { cls, reason: "SIZE_CHOSEN" } } : { keep: true };
    const named = names.length ? namedIn(raw, names) : [];
    const others = named.filter((n) => !inCart(n, input.cart));
    // Câu «mời món kèm» chỉ gọi tên món ĐÃ trong giỏ («thêm 1kg chả cá nữa») là mời TĂNG khối lượng ⇒ xét như UPSELL.
    const kind: OfferKind = cls === "CROSS_SELL" && named.length > 0 && others.length === 0 ? "UPSELL" : cls;
    if (kind === "CROSS_SELL" && (menuAsked || (others.length > 0 && others.every((n) => askedNames.some((a) => labelsMatch(a, n)))))) return { keep: true };
    if (kind === "UPSELL" && priceAsked && !sizeChosen) return { keep: true };
    const block = (reason: OfferBlock) => ({ keep: false as const, drop: { cls, reason } });
    if (!window.open) return block(window.reason);
    if (!input.facts) return block(kind === "UPSELL" ? "NO_PRICE_REASON" : "NOT_ELIGIBLE");
    const f = foldVi(raw);
    // «Thêm … là được miễn ship» — miễn ship theo ngưỡng của shop là lý do giá thật (món khác gọi tên vẫn phải đủ điều kiện mời kèm).
    const freeShipReason = input.facts.freeShip && FREE_SHIP_RE.test(f);
    if (kind === "UPSELL") {
      if (!freeShipReason) {
        const target = named.find((n) => inCart(n, input.cart)) ?? named[0] ?? explicitItems(input.cart)[0]?.label ?? null;
        const reason = target ? input.facts.volume.find((v) => labelsMatch(v.name, target)) : undefined;
        if (!reason) return block("NO_PRICE_REASON");
        const chosen = chosenGrams(input.cart, target);
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
    return { keep: true };
  });
  if (verdicts.every((v) => v.keep)) return { text, offered, dropped: [] };
  // Câu bỏ vì GIỌNG chỉ bỏ khi còn lại ít nhất một câu có chữ — tin chỉ có lời chào / bảng giá vẫn đi.
  const keptAny = parts.some((p, i) => p.trim() && verdicts[i].keep);
  const final = verdicts.map((v) => (v.keep ? v : v.drop.reason === "STYLE" && !keptAny ? ({ keep: true } as const) : v));
  const out = parts.filter((_, i) => final[i].keep).join("").trim();
  return { text: out, offered, dropped: final.flatMap((v) => (v.keep ? [] : [v.drop])) };
}

/** Ghi một lần bỏ lời mời vào state (đo đạc, có trần). Trả mảng MỚI. HÀM THUẦN. */
export function withOfferDrops(prev: ChatState["offerDrops"], turn: number | undefined, drops: readonly ReplyDrop[], via: "TEXT" | "QUICK_REPLY"): NonNullable<ChatState["offerDrops"]> {
  const add = drops.filter((d) => d.reason !== "STYLE").map((d) => ({ turn: turn ?? null, cls: d.cls, reason: d.reason as OfferBlock, via }));
  return [...(prev ?? []), ...add].slice(-OFFER_DROPS_MAX);
}
