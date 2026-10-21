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
 * HANDOFF_UNANSWERED không ở đây: nó là ảnh chụp lúc chạy, luật ở lib/constants/handoff-reply.ts.
 */
import { createHash } from "node:crypto";
import type { SalesQualityCode } from "@/lib/constants/sales-quality";
import { addressKnowledge, addressReaskVerdict } from "@/lib/sales-chatbot/address-memory";
import { amountsIn } from "@/lib/sales-chatbot/cart-commitment";
import { CLAIM_SAFE_TEXT } from "@/lib/sales-chatbot/claim-guard";
import { classifyDeliveryQuestion } from "@/lib/sales-chatbot/delivery-intent";
import { EMPTY_REPLY_TEXT, SHOP_SAID } from "@/lib/sales-chatbot/engine";
import { customerComplaintSignal } from "@/lib/sales-chatbot/lifecycle";
import { classifySentence, splitSentences } from "@/lib/sales-chatbot/next-best-action";
import { fitsFocus, productFocusOf, quickReplyCovers, type FocusLine, type FocusProduct } from "@/lib/sales-chatbot/quick-reply-focus";
import { parsePlaceholders } from "@/lib/sales-chatbot/quick-replies-shared";
import { choiceAmountText, quantityOnlyAnswer } from "@/lib/sales-chatbot/round-check";
import { foldVi } from "@/lib/sales-chatbot/text";

export type QualityMsg = { seq: number; role: string; at: Date; content: unknown };
export type QualityTemplate = { title: string; answer: string; head: string };
export type QualityContext = { from: Date; to: Date; templates: readonly QualityTemplate[]; products: readonly FocusProduct[] };
export type QualityHit = { code: SalesQualityCode; at: Date };
/** Mẫu số trong kỳ: tin khách · tin bot · tin khách chỉ là câu trả lời số lượng (F) · tin hai ý số lượng + giao (G) · tin phàn nàn. */
export type QualityBases = { customerMessages: number; botMessages: number; quantityAnswers: number; deliverySecondAsks: number; complaints: number };
export type ThreadQuality = { hits: QualityHit[]; bases: QualityBases };

/** Băm ngắn mã hội thoại — cùng phép băm `hashConv` của scripts/conv-money-trace.ts. HÀM THUẦN. */
export const conversationHash = (id: string) => createHash("sha256")["update"](id).digest("hex").slice(0, 8);

type Block = { type?: unknown; text?: unknown; content?: unknown; isError?: unknown };
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
const CLAIM_SAFE = new Set<string>(Object.values(CLAIM_SAFE_TEXT));

/** Đi một hội thoại. Chỉ ĐẾM tin có mốc trong [from, to); tin trước `from` vẫn được đọc làm ngữ cảnh. HÀM THUẦN. */
export function scanThreadQuality(msgs: readonly QualityMsg[], ctx: QualityContext): ThreadQuality {
  const hits: QualityHit[] = [];
  const bases: QualityBases = { customerMessages: 0, botMessages: 0, quantityAnswers: 0, deliverySecondAsks: 0, complaints: 0 };
  const inWindow = (at: Date) => at.getTime() >= ctx.from.getTime() && at.getTime() < ctx.to.getTime();
  const hit = (code: SalesQualityCode, at: Date) => hits.push({ code, at });
  const lines: FocusLine[] = [];
  const customerTexts: string[] = [];
  const botTexts: string[] = [];
  const sentHeads = new Set<string>();
  let userSince = false;
  let qtyAnswer = false;
  let secondAsk = false;
  let complaint = false;
  let prevBot = "";
  let turn = 0;
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
      }
      for (const b of blocksOf(m.content)) {
        if (b.type !== "tool_result" || b.isError) continue;
        const sent = deliverOf(b.content);
        if (!sent) continue;
        userSince = false;
        checkD(sent, m.at);
        lines.push({ who: "SHOP", text: sent });
        botTexts.push(sent);
      }
      continue;
    }
    const t = textOf(m.content);
    if (!t) continue;
    if (t.startsWith(SHOP_SAID)) {
      lines.push({ who: "SHOP", text: t });
      prevBot = t.slice(SHOP_SAID.length).trim();
      botTexts.push(t);
      continue;
    }
    if (counted) {
      bases.botMessages += 1;
      const headF = foldVi(t).replace(/\s+/g, " ").trim().slice(0, 60);
      if (qtyAnswer && userSince && (QTY_REASK_RE.test(t) || sentHeads.has(headF))) hit("QTY_REASKED", m.at);
      if (secondAsk && userSince && !DELIVERY_WORDS_RE.test(foldVi(t))) hit("SECONDARY_INTENT_UNANSWERED", m.at);
      if (t === EMPTY_REPLY_TEXT) hit("CLARIFY_FALLBACK", m.at);
      if (CLAIM_SAFE.has(t)) hit("CLAIM_GUARD_BLOCK", m.at);
      if (complaint && userSince && splitSentences(t).some((s) => { const k = classifySentence(s); return k === "UPSELL" || k === "CROSS_SELL"; })) hit("COMPLAINT_WHILE_SELLING", m.at);
      if (customerTexts.length && addressReaskVerdict(t, addressKnowledge({}, customerTexts), turn, { botTexts }) !== null) hit("ADDRESS_REASK", m.at);
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
  return { hits, bases };
}
