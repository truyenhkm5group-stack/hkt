/**
 * ═══════════ BỘ DÒ CHẤT LƯỢNG AI BÁN HÀNG — HÀM THUẦN (giai đoạn 2B, 21/10/2026) ═══════════
 *
 * Đi MỘT hội thoại theo thứ tự tin và trả các lần lỗi (mã ở lib/constants/sales-quality.ts). Không đọc CSDL, không đọc đồng hồ, 0 lời
 * gọi AI. Mọi luật là luật CÓ SẴN của lượt sống:
 *  · F QTY_REASKED · G SECONDARY_INTENT_UNANSWERED · D WRONG_PRODUCT_TEMPLATE · «nói rõ hơn» CLARIFY_FALLBACK — cùng định nghĩa với
 *    `scanPatterns` của scripts/conv-money-trace.ts (script là bản TỰ CHỨA vì ops lấy script từ main nhưng lib từ image đang chạy;
 *    tests/sales-quality-daily.test.ts chạy CẢ HAI trên cùng dữ liệu và so từng con số, nên hai bản không trôi xa nhau được).
 *  · ADDRESS_REASK — phát lại đúng hàng rào sống `addressReaskVerdict(addressKnowledge(…))`: câu đã GỬI mà hàng rào còn bắt được là
 *    câu hỏi lại đã lọt. Lịch sử không có trạng thái từng lượt (đơn nháp · khách đã lưu) ⇒ ít dữ kiện hơn lượt sống ⇒ số đếm là TRẦN
 *    DƯỚI, không bao giờ bắt nhầm hơn hàng rào.
 *  · COMPLAINT_WHILE_SELLING — tin khách `customerComplaintSignal` mà tin bot ngay sau có câu `classifySentence` UPSELL / CROSS_SELL.
 *  · CLAIM_GUARD_BLOCK — tin bot đúng một câu an toàn `CLAIM_SAFE_TEXT` (hàng rào đã thay câu model).
 *  · QUANTITY_UNIT_AMBIGUOUS · PACK_MULTIPLIER_MISMATCH · CART_TOTAL_CONFLICT · ORDER_UPDATED_WITHOUT_VERIFIED_CONSENT — kết quả công cụ
 *    ghi đơn bị hàng rào giá trị đơn từ chối (ô `guard`, lib/constants/sales-order-guard.ts); mẫu số = số lần bot gọi công cụ ghi đơn.
 *  · STAFF_AI_QUOTE_CONFLICT — tin nhân viên / page báo TỔNG khác mọi tổng bot đã báo trong hội thoại (`staffTotalConflict` + `totalClauses`).
 * HANDOFF_UNANSWERED không ở đây: nó là ảnh chụp lúc chạy, luật ở lib/constants/handoff-reply.ts.
 */
import { createHash } from "node:crypto";
import { parseCustomerAddress, wardFromCustomerWords } from "@/lib/address/customer-address";
import { MACHINE_ADDRESS_NOTE_PREFIX, orderReviewOf } from "@/lib/constants/order-review";
import type { SalesQualityCode } from "@/lib/constants/sales-quality";
import { addressAskAfterText, addressKnowledge, addressReaskVerdict, KNOWN_REASK_CODES } from "@/lib/sales-chatbot/address-memory";
import { amountsIn, labelsMatch, piecesOf, productName } from "@/lib/sales-chatbot/cart-commitment";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { classifyDeliveryQuestion } from "@/lib/sales-chatbot/delivery-intent";
import { EMPTY_REPLY_TEXT, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { customerComplaintSignal } from "@/lib/sales-chatbot/lifecycle";
import { classifySentence, splitSentences } from "@/lib/sales-chatbot/next-best-action";
import { fitsFocus, productFocusOf, quickReplyCovers, type FocusLine, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
import { parsePlaceholders } from "@/lib/sales-chatbot/quick-replies-shared";
import { choiceAmountText, quantityOnlyAnswer } from "@/lib/sales-chatbot/round-check";
import { calledByName, mentionsProduct } from "@/lib/sales-chatbot/cart-commitment";
import { extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";
import { isShortAccept } from "@/lib/sales-chatbot/short-accept";
import { staffTotalConflict, totalClauses } from "@/lib/sales-chatbot/cancel-recovery";
import { ORDER_GUARD_CODES, type OrderGuardCode } from "@/lib/constants/sales-order-guard";
import { foldVi } from "@/lib/sales-chatbot/text";

export type QualityMsg = { seq: number; role: string; at: Date; content: unknown };
export type QualityTemplate = { title: string; answer: string; head: string };
/**
 * `automationTexts` = chữ (đã trim) các tin page do MẪU TỰ ĐỘNG Pancake gửi (`sales_chat_inbound.sender_kind = PANCAKE_AUTOMATION`) — tin page
 * chép vào lịch sử không mang người gửi, nên nơi gọi (đọc được CSDL) nạp tập chữ này để bộ dò tách nhánh «mẫu tự động page».
 */
export type QualityContext = { from: Date; to: Date; templates: readonly QualityTemplate[]; products: readonly FocusProduct[]; automationTexts?: ReadonlySet<string> };
/** `source` = nhánh của mã (hiện chỉ STAFF_AI_QUOTE_CONFLICT: tổng lệch đến từ MẪU TỰ ĐỘNG của page, không phải nhân viên gõ). */
export type QualityHit = { code: SalesQualityCode; at: Date; source?: "PAGE_AUTOMATION" };
/** Mẫu số trong kỳ: tin khách · tin bot · tin khách chỉ là câu trả lời số lượng (F) · tin hai ý số lượng + giao (G) · tin phàn nàn. */
/** `orderWrites` = lần bot gọi công cụ ghi đơn (tạo / sửa đơn nháp) · `staffTotals` = tin nhân viên / page có câu báo tổng. */
export type QualityBases = { customerMessages: number; botMessages: number; quantityAnswers: number; deliverySecondAsks: number; complaints: number; offerAccepts: number; orderWrites: number; staffTotals: number };
export type ThreadQuality = { hits: QualityHit[]; bases: QualityBases };

/** Băm ngắn mã hội thoại — cùng phép băm `hashConv` của scripts/conv-money-trace.ts. HÀM THUẦN. */
export const conversationHash = (id: string) => createHash("sha256")["update"](id).digest("hex").slice(0, 8);

type Block = { type?: unknown; text?: unknown; content?: unknown; isError?: unknown; name?: unknown; id?: unknown; toolUseId?: unknown };
const ORDER_WRITE_TOOLS = new Set(["create_draft_order", "update_draft_order"]);
const GUARD_CODES = new Set<string>(ORDER_GUARD_CODES);

/** Dòng hàng trong kết quả công cụ ghi đơn THÀNH CÔNG (`cartView`: tên mẫu mã + số lượng). Không đọc được ⇒ []. HÀM THUẦN. */
function writtenLinesOf(raw: unknown): { name: string; quantity: number }[] {
  try {
    const p = JSON.parse(String(raw)) as { lines?: unknown };
    if (!Array.isArray(p.lines)) return [];
    return (p.lines as { name?: unknown; quantity?: unknown }[]).filter((l) => typeof l.name === "string" && typeof l.quantity === "number").map((l) => ({ name: String(l.name), quantity: Number(l.quantity) }));
  } catch {
    return [];
  }
}

/**
 * PACK_MULTIPLIER_LEAKED (P0 22/10/2026 — «lọt tới khách» của sales-qty-unit-guard, ca #8037F35A): đơn ĐÃ GHI có dòng của mẫu mã «Hộp N cái»
 * (N > 1) mà số HỘP bằng đúng số khách nói KHÔNG kèm đơn vị / đếm bằng CÁI («thêm 10 nem», «10 cái nem»), số đó là bội của N ⇒ số hộp đúng
 * là số / N. Chỉ món khách GỌI TÊN trong tin của lượt. «10 hộp» (khách nói rõ hộp) không bao giờ bắt. Trả các dòng lọt. HÀM THUẦN.
 */
export function packMultiplierLeaks(customerText: string, lines: readonly { name: string; quantity: number }[], catalogNames: readonly string[]): { name: string; quantity: number; perPack: number }[] {
  if (!customerText.trim() || !lines.length) return [];
  const said = amountsIn(customerText, catalogNames).filter((a) => a.unit === "pack" && (a.bare || a.pieces) && a.label);
  const out: { name: string; quantity: number; perPack: number }[] = [];
  for (const l of lines) {
    const n = piecesOf(l.name);
    if (n === null || n <= 1 || l.quantity < n || l.quantity % n !== 0) continue;
    if (said.some((a) => a.value === l.quantity && labelsMatch(a.label, productName(l.name)))) out.push({ name: productName(l.name), quantity: l.quantity, perPack: n });
  }
  return out;
}
/** Mã hàng rào giá trị đơn trong một kết quả công cụ bị từ chối (`{ error, guard }`). HÀM THUẦN. */
function guardOf(raw: unknown): OrderGuardCode | null {
  try {
    const p = JSON.parse(String(raw)) as Record<string, unknown>;
    return typeof p.guard === "string" && GUARD_CODES.has(p.guard) ? (p.guard as OrderGuardCode) : null;
  } catch {
    return null;
  }
}
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
const textOf = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();

/** Câu mẫu gửi qua công cụ (`__deliver` trong kết quả công cụ) — một tin bot tới khách. HÀM THUẦN. */
function deliverOf(raw: unknown): string | null {
  try {
    const p = JSON.parse(String(raw)) as Record<string, unknown>;
    return typeof p.__deliver === "string" ? p.__deliver : null;
  } catch {
    return null;
  }
}

/** Phần chữ CỐ ĐỊNH đầu câu mẫu (trước ô điền đầu tiên) — cùng định nghĩa `quickReplyHead` của conv-money-trace. HÀM THUẦN. */
export function templateHead(answer: string): string {
  const ph = parsePlaceholders(answer)[0];
  const head = ph ? answer.slice(0, answer.indexOf(ph.raw)) : answer;
  return foldVi(head).replace(/\s+/g, " ").trim().slice(0, 40);
}

/** D — câu bot trùng đầu câu mẫu mà MỌI câu mẫu trùng đều nói về món khác món đang bàn. Cùng định nghĩa `wrongProductTemplate`. HÀM THUẦN. */
export function wrongTemplateOf<T extends QualityTemplate>(sent: string, lines: readonly FocusLine[], templates: readonly T[], products: readonly FocusProduct[]): T | null {
  const head = foldVi(sent).replace(/\s+/g, " ").trim().slice(0, 40);
  const hits = templates.filter((t) => t.head.length >= 12 && head.startsWith(t.head));
  if (!hits.length) return null;
  const focus = productFocusOf(lines, products);
  if (!focus.focus.length && !focus.declined.length) return null;
  const wrong = hits.filter((t) => !fitsFocus(quickReplyCovers(t, products), focus));
  return wrong.length === hits.length ? wrong[0] : null;
}

const QTY_REASK_RE = /\d+(?:[.,]\d+)?\s?kg\s+hay\s+\d+(?:[.,]\d+)?\s?kg|muốn (?:mua|lấy) \d/iu;
const DELIVERY_WORDS_RE = /(?:^| )(?:giao|nhan|ngay|dia chi|ship|van chuyen)(?= |$)/;
// Câu ghi nhận `ORDER_RECEIVED` là câu THƯỜNG của đơn tự chốt khi địa chỉ chờ xác minh nội bộ (22/10/2026) — không phải lần chặn khẳng định.
const CLAIM_SAFE = new Set<string>(Object.values(CLAIM_SAFE_TEXT).filter((t) => t !== CLAIM_SAFE_TEXT.ORDER_RECEIVED));
/** Câu bot hỏi lại / bắt khách nhắn tên món sau lời đồng ý. */
const REASK_AFTER_ACCEPT_RE = /nhắn (?:giúp |lại )?(?:em|shop)|đúng không ạ\?|món nào|muốn thêm .* không ạ\?/iu;
/** Câu bot báo đã thêm / tổng mới — dấu vết món đã vào đơn khi bước máy chủ thêm (không có kết quả công cụ trong lịch sử). */
const ATTACHED_SAY_RE = /tổng đơn mới|đã thêm|thêm .* vào đơn (?:rồi|cho mình)/iu;

/**
 * Lời mời MỘT món trong câu bot, đọc trên LỊCH SỬ (không có bảng giá từng lượt): câu mời («?» hoặc lấy / thêm / nha / nhé) gọi tên ĐÚNG MỘT
 * sản phẩm của danh mục và có số tiền — cùng hình dạng `proposalOf` (short-accept.ts) dùng trong lượt sống. `null` = không phải. HÀM THUẦN.
 */
export function oneProductInvite(text: string, products: readonly FocusProduct[]): string | null {
  const f = ` ${foldVi(text).replace(/[^a-z0-9]+/g, " ")} `;
  if (!/[?？]/.test(text) && !/ (?:lay|them|nha|nhe) /.test(f)) return null;
  if (!extractVndAmounts(text).length) return null;
  const named = products.filter((p) => mentionsProduct(p.name, text) || calledByName(p.name, text));
  return named.length === 1 ? named[0].name : null;
}

/** Đi một hội thoại. Chỉ ĐẾM tin có mốc trong [from, to); tin trước `from` vẫn được đọc làm ngữ cảnh. HÀM THUẦN. */
export function scanThreadQuality(msgs: readonly QualityMsg[], ctx: QualityContext): ThreadQuality {
  const hits: QualityHit[] = [];
  const bases: QualityBases = { customerMessages: 0, botMessages: 0, quantityAnswers: 0, deliverySecondAsks: 0, complaints: 0, offerAccepts: 0, orderWrites: 0, staffTotals: 0 };
  /** Mọi tổng BOT đã báo trong hội thoại — tổng nhân viên / page khác hết chúng ⇒ STAFF_AI_QUOTE_CONFLICT. */
  const botTotals: number[] = [];
  const inWindow = (at: Date) => at.getTime() >= ctx.from.getTime() && at.getTime() < ctx.to.getTime();
  const hit = (code: SalesQualityCode, at: Date, source?: QualityHit["source"]) => hits.push({ code, at, ...(source ? { source } : {}) });
  const lines: FocusLine[] = [];
  const customerTexts: string[] = [];
  /** Tin khách kèm mốc — vế 3.12b của ADDRESS_REASK (chữ địa chỉ trong cùng lượt mua, ≤ 3 ngày trước tin bot). */
  const customerTimed: { text: string; at: number }[] = [];
  const botTexts: string[] = [];
  const sentHeads = new Set<string>();
  let userSince = false;
  let qtyAnswer = false;
  let secondAsk = false;
  let complaint = false;
  let prevBot = "";
  let turn = 0;
  // Lời mời một món đang chờ trả lời (tên món) · lời đồng ý đang chờ dấu vết món vào đơn.
  let offer: string | null = null;
  // PACK_MULTIPLIER_LEAKED: tin khách của lượt · công cụ ghi đơn theo mã lời gọi · mỗi (món, số) chỉ bắt MỘT lần mỗi hội thoại.
  let turnCustomerText = "";
  const writeCalls = new Set<string>();
  const leaked = new Set<string>();
  const catalogNames = ctx.products.map((p) => p.name);
  let accept: { name: string; at: Date; counted: boolean; attached: boolean; botSeen: boolean } | null = null;
  const closeAccept = () => {
    if (accept && accept.counted && !accept.attached) hit("UPSELL_ACCEPTED_NOT_ATTACHED", accept.at);
    accept = null;
  };
  const checkD = (sent: string, at: Date) => {
    if (inWindow(at) && wrongTemplateOf(sent, lines, ctx.templates, ctx.products)) hit("WRONG_PRODUCT_TEMPLATE", at);
  };
  for (const m of [...msgs].sort((a, b) => a.seq - b.seq)) {
    if (m.at.getTime() >= ctx.to.getTime()) break;
    const counted = inWindow(m.at);
    if (m.role === "user") {
      const said = textOf(m.content);
      if (said) {
        turn += 1;
        qtyAnswer = quantityOnlyAnswer(said, []) || choiceAmountText(said, prevBot) !== null;
        secondAsk = amountsIn(said).length > 0 && classifyDeliveryQuestion(said)?.intent === "DELIVERY_TIME";
        complaint = customerComplaintSignal(said);
        if (counted) {
          bases.customerMessages += 1;
          if (qtyAnswer) bases.quantityAnswers += 1;
          if (secondAsk) bases.deliverySecondAsks += 1;
          if (complaint) bases.complaints += 1;
        }
        userSince = true;
        lines.push({ who: "CUSTOMER", text: said });
        customerTexts.push(said);
        customerTimed.push({ text: said, at: m.at.getTime() });
        turnCustomerText = said;
        closeAccept();
        if (offer && isShortAccept(said)) {
          accept = { name: offer, at: m.at, counted, attached: false, botSeen: false };
          if (counted) bases.offerAccepts += 1;
        }
        offer = null;
      }
      for (const b of blocksOf(m.content)) {
        if (b.type === "tool_result" && b.isError) {
          const g = guardOf(b.content);
          if (g && counted) hit(g, m.at);
          continue;
        }
        if (b.type !== "tool_result") continue;
        // Đơn đã ghi mang số hộp = số cái / số trần khách nói ⇒ lọt tới khách (mốc = lượt ghi đơn).
        if (typeof b.toolUseId === "string" && writeCalls.has(b.toolUseId)) {
          for (const x of packMultiplierLeaks(turnCustomerText, writtenLinesOf(b.content), catalogNames)) {
            const key = `${x.name}|${x.quantity}`;
            if (leaked.has(key)) continue;
            leaked.add(key);
            if (counted) hit("PACK_MULTIPLIER_LEAKED", m.at);
          }
        }
        if (accept && foldVi(String(b.content)).includes(foldVi(accept.name))) accept.attached = true;
        const sent = deliverOf(b.content);
        if (!sent) continue;
        userSince = false;
        checkD(sent, m.at);
        lines.push({ who: "SHOP", text: sent });
        botTexts.push(sent);
      }
      continue;
    }
    for (const b of blocksOf(m.content)) {
      if (b.type !== "tool_use" || !ORDER_WRITE_TOOLS.has(String(b.name))) continue;
      if (typeof b.id === "string") writeCalls.add(b.id);
      if (counted) bases.orderWrites += 1;
    }
    const t = textOf(m.content);
    if (!t) continue;
    if (t.startsWith(SHOP_SAID)) {
      const said = t.slice(SHOP_SAID.length);
      if (totalClauses(said).length) {
        if (counted) bases.staffTotals += 1;
        // Mẫu tự động của page in một tổng CỐ ĐỊNH (ca #8037F35A: mẫu Pancake luôn in 400.000 ₫) — cùng mã, nhánh nguồn riêng để thấy ngay khi mẫu còn chạy.
        if (counted && staffTotalConflict([said], botTotals) !== null) hit("STAFF_AI_QUOTE_CONFLICT", m.at, ctx.automationTexts?.has(said.trim()) ? "PAGE_AUTOMATION" : undefined);
      }
      lines.push({ who: "SHOP", text: t });
      prevBot = t.slice(SHOP_SAID.length).trim();
      botTexts.push(t);
      continue;
    }
    if (accept && !accept.botSeen) {
      accept.botSeen = true;
      if (ATTACHED_SAY_RE.test(t)) accept.attached = true;
      else if (accept.counted && REASK_AFTER_ACCEPT_RE.test(t)) hit("UPSELL_ACCEPTED_BUT_REASKED", m.at);
    }
    for (const amounts of totalClauses(t)) botTotals.push(...amounts);
    offer = oneProductInvite(t, ctx.products);
    if (counted) {
      bases.botMessages += 1;
      const headF = foldVi(t).replace(/\s+/g, " ").trim().slice(0, 60);
      if (qtyAnswer && userSince && (QTY_REASK_RE.test(t) || sentHeads.has(headF))) hit("QTY_REASKED", m.at);
      if (secondAsk && userSince && !DELIVERY_WORDS_RE.test(foldVi(t))) hit("SECONDARY_INTENT_UNANSWERED", m.at);
      if (t === EMPTY_REPLY_TEXT) hit("CLARIFY_FALLBACK", m.at);
      if (CLAIM_SAFE.has(t)) hit("CLAIM_GUARD_BLOCK", m.at);
      if (complaint && userSince && splitSentences(t).some((s) => { const k = classifySentence(s); return k === "UPSELL" || k === "CROSS_SELL"; })) hit("COMPLAINT_WHILE_SELLING", m.at);
      /*
        ĐỊNH NGHĨA ĐỔI 23/10/2026 (khoá mã giữ nguyên — SALES_QUALITY_SPEC.ADDRESS_REASK.definitionChangedAt):
         · ADDRESS_REASK = hỏi lại thứ khách ĐÃ cho — vế 3.12b (`addressAskAfterText`, cùng hàm với điểm chặn engine) HOẶC hàng rào
           #855 ra một mã «đã biết» (KNOWN_REASK_CODES).
         · Xin LẶP thứ khách CHƯA từng cho (mã REPEAT_ASK — ca theo dõi tự động 16:24Z 22/10, hslc) là chuyện khác ⇒ REPEAT_ASK_UNANSWERED.
           Trước đây nó bị đếm dưới nhãn «hỏi lại thứ đã cho» và mở lại sổ tái diễn #972 sai.
      */
      const reask = customerTexts.length ? addressReaskVerdict(t, addressKnowledge({}, customerTexts), turn, { botTexts }) : null;
      const knownReask = Boolean(reask?.codes.some((c) => KNOWN_REASK_CODES.includes(c)));
      if (addressAskAfterText(customerTimed, t, m.at.getTime()) === true || knownReask) hit("ADDRESS_REASK", m.at);
      else if (reask?.codes.includes("REPEAT_ASK")) hit("REPEAT_ASK_UNANSWERED", m.at);
    }
    checkD(t, m.at);
    sentHeads.add(foldVi(t).replace(/\s+/g, " ").trim().slice(0, 60));
    secondAsk = false;
    qtyAnswer = false;
    complaint = false;
    prevBot = t;
    lines.push({ who: "SHOP", text: t });
    botTexts.push(t);
    userSince = false;
  }
  closeAccept();
  return { hits, bases };
}

/** Một đơn bot chốt, đọc cho mã ADDRESS_RECEIVED_BUT_NOT_APPLIED. */
export type AddressAppliedOrder = { raw: unknown; shipAddress: string; shipProvince: string; shipCommune: string };

/**
 * ADDRESS_RECEIVED_BUT_NOT_APPLIED (P0 22/10/2026, HSLC #8037F35A): đơn mang dòng cờ «địa chỉ chưa ghép» do MÁY dựng, mà (a) đơn ĐÃ có xã /
 * phường — cờ không được xét lại; hoặc (b) tin khách đã nêu phường của ĐÚNG địa chỉ đơn (`wardFromCustomerWords` — cùng luật đường ghi đơn)
 * mà đơn để trống. Dòng «khách đổi địa chỉ» (người phải xác minh) KHÔNG tính. HÀM THUẦN.
 */
export function addressNotApplied(o: AddressAppliedOrder, customerTexts: readonly string[]): boolean {
  const open = orderReviewOf(o.raw)?.entries ?? [];
  if (!open.some((e) => e.code === "ADDRESS_UNRESOLVED" && e.note.startsWith(MACHINE_ADDRESS_NOTE_PREFIX))) return false;
  if (o.shipCommune.trim()) return true;
  return wardFromCustomerWords(parseCustomerAddress(o.shipAddress, o.shipProvince), o.shipAddress, customerTexts) !== null;
}
