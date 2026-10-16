/**
 * ═══════════ ĐƯỜNG MÁY CHỦ CHO CÂU HUỶ + LỜI NHÂN VIÊN LỆCH ĐƠN NHÁP (P0 #863) ═══════════
 *
 * Engine gọi `serverCancelStep` TRƯỚC lượt AI (sau các nhánh máy chủ chuyển người có sẵn: chuyển khoản · khiếu nại · đòi người · phản đối giá).
 * Trả `null` ⇒ lượt AI chạy như cũ. Trả một quyết định ⇒ engine áp đúng quyết định đó (câu gửi khách · chuyển người), không gọi model.
 *
 * Ba nhánh, theo thứ tự:
 *  1. NHÂN VIÊN BÁO TỔNG KHÁC ĐƠN NHÁP (tin phía page chép vào lịch sử, SAU câu cuối của bot): gắn cờ «món / số lượng khách chưa đồng ý»
 *     lên đơn (đơn không được tự xác nhận / giao — `autoConfirmComplete` · `decideShippingRoute`), chuyển người. Bot không bao giờ nói lại
 *     tổng của đơn nháp đè lên câu của nhân viên.
 *  2. KHÁCH HUỶ LẦN HAI (lượt giữ đơn đã có ở một lượt TRƯỚC): huỷ qua `cancel_order` bước 2 (`executeCustomerCancel` — vòng đời vận đơn).
 *     «Đã huỷ» chỉ khi kết quả có `cancelled = true` (đọc sau khi CSDL ghi). Đã giao ĐVVC / đã thu tiền / nhiều đơn / ghi hỏng ⇒ chuyển người.
 *  3. KHÁCH HUỶ LẦN ĐẦU NGAY SAU LỖI CỦA BOT (giỏ khách nói lệch đơn nháp · cờ món chưa đồng ý / giá · đang phản đối giá · nhân viên đã báo
 *     lệch): mở lượt giữ đơn (`cancel_order` bước 1 — cờ «khách huỷ», ghi yêu cầu huỷ) rồi máy chủ gửi câu xin lỗi CỤ THỂ + ĐƠN ĐÃ SỬA theo
 *     báo giá máy chủ — lượt giữ đơn DUY NHẤT. Không báo giá được / đơn không tự huỷ được ⇒ chuyển người, không đưa số nào.
 * Huỷ lần đầu KHÔNG do lỗi của bot ⇒ `null`: model giữ đơn đúng một lần như luật 10/10 (`cancel_order` bước 1).
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CANCEL_BLOCK_LABEL, customerCancelPlan } from "@/lib/constants/order-cancel";
import { orderReviewOf } from "@/lib/constants/order-review";
import { formatVND } from "@/lib/format";
import { loadCancelFacts } from "@/lib/records/order-cancel";
import { flagOrderForReviewAsAgent, type OrderAgent } from "@/lib/records/order-create";
import { botErrorFromReview, cartItemsText, explicitCancel, recoveryText, staffTotalConflict, cancelledText, DECLINE_NOTED_TEXT, type BotErrorKind } from "@/lib/sales-chatbot/cancel-recovery";
import type { CartCommitment } from "@/lib/sales-chatbot/cart-commitment";
import type { ChatChannel, SalesChatbotConfig } from "@/lib/sales-chatbot/config";
import { quoteSnapshotOf } from "@/lib/sales-chatbot/quote-shared";
import { draftCartReview, executeTool, type ChatState } from "@/lib/sales-chatbot/tools";

export type CancelStepInput = {
  conversationId: string;
  channel: ChatChannel;
  config: SalesChatbotConfig;
  agent: OrderAgent;
  state: ChatState;
  /** Giỏ có thẩm quyền TRƯỚC tin này — câu huỷ xoá giỏ, nhưng đơn đúng là giỏ khách nói ngay trước đó. */
  cartBefore: CartCommitment | undefined;
  text: string;
  turn: number;
  prevTurn?: number;
  now: Date;
  /** Tin phía page (nhân viên / chưa rõ) chép vào lịch sử SAU câu cuối của bot: seq + chữ (đã bỏ tiền tố). */
  staffTexts: readonly { seq: number; text: string }[];
};

/**
 * `SAY` = gửi đúng câu này (máy chủ đã dựng từ số máy chủ) · `HANDOFF` = chuyển người (kênh nhắn tin ⇒ bot im). `stopFollowups` = dọn
 * lịch nhắc của hội thoại. `state` = trạng thái mới của hội thoại (engine ghi).
 */
export type CancelStep =
  | { kind: "SAY"; text: string; state: ChatState; stopFollowups: boolean; note: string }
  | { kind: "HANDOFF"; reason: string; state: ChatState; note: string };

/** Đơn của hội thoại mà bot đang theo (đơn chốt thắng đơn nháp). */
const orderIdOf = (s: ChatState): string | null => s.confirmed?.orderId ?? s.draft?.orderId ?? null;

async function reviewCodesOf(orderId: string): Promise<string[]> {
  const db = await getDb();
  const [row] = await db.select({ raw: schema.orders.raw }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  return orderReviewOf(row?.raw)?.entries.map((e) => e.code) ?? [];
}

type ToolData = { cancelled?: boolean; order_code?: string; no_open_order?: boolean; handed_to_staff?: boolean; step?: string; reason?: string };
const dataOf = (content: string): ToolData => {
  try {
    return JSON.parse(content) as ToolData;
  } catch {
    return {};
  }
};

export async function serverCancelStep(i: CancelStepInput): Promise<CancelStep | null> {
  const ctx = { conversationId: i.conversationId, channel: i.channel, config: i.config, state: i.state, lastUserText: i.text, agent: i.agent, turn: i.turn, ...(i.prevTurn !== undefined ? { prevTurn: i.prevTurn } : {}), now: i.now };
  const words = i.text.trim().slice(0, 300);
  const orderId = orderIdOf(i.state);

  // ── 1. Nhân viên báo tổng khác đơn nháp ──
  const fresh = i.staffTexts.filter((s) => s.seq > (i.state.staffConflictSeq ?? 0));
  if (orderId && i.state.draft && fresh.length) {
    const d = i.state.draft;
    const totals = [i.state.quote?.total, i.state.quote?.subtotal, d.quote?.total, d.quote?.subtotal, i.state.confirmed?.total].filter((n): n is number => typeof n === "number");
    const said = staffTotalConflict(fresh.map((s) => s.text), totals);
    if (said !== null) {
      const draftTotal = d.quote?.total ?? d.quote?.subtotal ?? i.state.confirmed?.total ?? null;
      const note = `Nhân viên báo tổng ${formatVND(said)}${draftTotal !== null ? ` ≠ đơn nháp ${formatVND(draftTotal)}` : ""} — cần đối chiếu món / số lượng với khách`;
      await flagOrderForReviewAsAgent(i.agent, orderId, { code: "UPSELL_UNCONSENTED", note, quote: fresh.map((s) => s.text).join(" / ").slice(0, 300) || null }, i.now).catch(() => undefined);
      const reason = `Cần người xử lý — ${note}`.slice(0, 300);
      return { kind: "HANDOFF", reason, state: { ...i.state, staffConflictSeq: Math.max(...fresh.map((s) => s.seq)), handoff: { reason, at: i.now.toISOString() } }, note };
    }
  }

  if (!explicitCancel(i.text)) return null;

  // ── 2. Huỷ lần hai: lượt giữ đơn đã dùng ở một lượt trước ──
  const pending = i.state.cancelRequest && i.state.cancelRequest.turn !== i.turn ? i.state.cancelRequest : null;
  if (pending) {
    let r;
    try {
      r = await executeTool("cancel_order", { decision: "CANCEL", customer_words: words, reason: pending.reason }, ctx);
    } catch (error) {
      const reason = `Khách huỷ đơn — máy chưa huỷ được (${error instanceof Error ? error.message.slice(0, 120) : "lỗi không rõ"})`;
      return { kind: "HANDOFF", reason, state: { ...i.state, handoff: { reason, at: i.now.toISOString() } }, note: reason };
    }
    const data = dataOf(r.content);
    if (data.cancelled === true) return { kind: "SAY", text: cancelledText(data.order_code ?? null, Boolean(pending.recovery)), state: r.state, stopFollowups: true, note: "Khách huỷ lần hai — đã huỷ đơn qua vòng đời đơn" };
    if (data.no_open_order) {
      const st: ChatState = { ...r.state, declined: { reason: pending.reason || "Khách không mua", at: i.now.toISOString() }, stage: "DECLINED" };
      delete st.cart;
      return { kind: "SAY", text: DECLINE_NOTED_TEXT, state: st, stopFollowups: true, note: "Khách huỷ lần hai — không còn đơn mở" };
    }
    const reason = (r.requireHuman ?? `Khách huỷ đơn — ${data.reason ?? "máy chưa huỷ được"}`).slice(0, 300);
    return { kind: "HANDOFF", reason, state: { ...r.state, handoff: { reason, at: i.now.toISOString() } }, note: reason };
  }

  // ── 3. Huỷ lần đầu ngay sau lỗi của bot ──
  if (!orderId || !i.state.draft) return null;
  const codes = await reviewCodesOf(orderId).catch(() => [] as string[]);
  const fromFlags = botErrorFromReview(codes);
  const review = await draftCartReview(i.state, i.config, i.cartBefore, { fallbackToDraft: fromFlags === "PRICE" || (!fromFlags && Boolean(i.state.priceDispute)) }).catch(() => null);
  const kind: BotErrorKind | null = review?.diff.length ? "QUANTITY" : (fromFlags ?? (i.state.priceDispute ? "PRICE" : i.state.staffConflictSeq ? "STAFF_CONFLICT" : null));
  if (!kind) return null;
  const facts = await loadCancelFacts(orderId).catch(() => null);
  const plan = facts ? customerCancelPlan(facts.input) : null;
  let opened;
  try {
    opened = await executeTool("cancel_order", { decision: "CANCEL", customer_words: words, reason: `Khách huỷ vì đơn sai (${kind})` }, ctx);
  } catch (error) {
    const reason = `Khách huỷ vì đơn sai — máy chưa ghi được yêu cầu huỷ (${error instanceof Error ? error.message.slice(0, 120) : "lỗi không rõ"})`;
    return { kind: "HANDOFF", reason, state: { ...i.state, handoff: { reason, at: i.now.toISOString() } }, note: reason };
  }
  const st: ChatState = opened.state;
  if (!plan || plan.kind === "NEEDS_HUMAN") {
    const why = plan?.kind === "NEEDS_HUMAN" ? CANCEL_BLOCK_LABEL[plan.code] : "không đọc được vòng đời đơn";
    const reason = `Khách huỷ đơn sau lỗi của bot — ${why}`.slice(0, 300);
    return { kind: "HANDOFF", reason, state: { ...st, handoff: { reason, at: i.now.toISOString() } }, note: reason };
  }
  const c = review?.corrected ?? null;
  if (!c || !review?.lines || !c.quote.verified || c.missing.length || c.unpriced.length || c.addOnOnly) {
    const reason = "Khách huỷ đơn sau lỗi của bot — máy chủ chưa báo giá được đúng giỏ khách nói, cần người sửa đơn và báo lại khách".slice(0, 300);
    return { kind: "HANDOFF", reason, state: { ...st, handoff: { reason, at: i.now.toISOString() } }, note: reason };
  }
  if (kind === "QUANTITY") {
    const note = `Đơn nháp lệch giỏ khách nói: ${review.diff.map((x) => `${x.label} — khách ${x.want}, đơn ${x.got}`).join("; ")}`.slice(0, 300);
    await flagOrderForReviewAsAgent(i.agent, orderId, { code: "UPSELL_UNCONSENTED", note, quote: words || null }, i.now).catch(() => undefined);
  }
  const items = cartItemsText(i.cartBefore) && review.lines !== i.state.draft.lines ? cartItemsText(i.cartBefore) : c.lines.map((l) => `${l.quantity} × ${l.name}`).join(" + ");
  const offer = { items, subtotal: c.subtotal, total: c.total, shipFree: c.ship.kind === "FREE" };
  const text = recoveryText(kind, review.diff, offer);
  const next: ChatState = {
    ...st,
    quote: quoteSnapshotOf(c.quote, i.now),
    ...(st.cancelRequest ? { cancelRequest: { ...st.cancelRequest, recovery: { kind, lines: review.lines, items, subtotal: c.subtotal, total: c.total, quoteId: c.quote.quoteId, turn: i.turn } } } : {}),
    // Câu huỷ đã xoá giỏ; đơn đề nghị là đúng giỏ khách nói ngay trước ⇒ dựng lại giỏ đó (khách «ok» thì công cụ sửa đơn đối chiếu theo nó).
    ...(i.cartBefore ? { cart: { ...i.cartBefore, at: i.now.toISOString() }, cartRev: i.now.toISOString() } : {}),
  };
  return { kind: "SAY", text, state: next, stopFollowups: true, note: `Khách huỷ sau lỗi của bot (${kind}) — máy chủ xin lỗi + đề nghị đơn đã sửa ${formatVND(c.total ?? c.subtotal)}` };
}

/**
 * Lời nhắc khi lượt giữ đơn DO MÁY CHỦ đã gửi (khách vừa nghe câu xin lỗi + đơn đã sửa): khách đồng ý ⇒ sửa đơn đúng các dòng máy chủ đã báo;
 * khách vẫn từ chối ⇒ huỷ. Không giữ đơn thêm lần nào. Không có lượt giữ đơn của máy chủ ⇒ chuỗi rỗng (lời nhắc không đổi).
 */
export function recoveryPrompt(st: Pick<ChatState, "cancelRequest">): string {
  const r = st.cancelRequest?.recovery;
  if (!r) return "";
  const money = r.total !== null ? formatVND(r.total) : `${formatVND(r.subtotal)} + phí ship`;
  return [
    "KHÁCH ĐANG XIN HUỶ vì lỗi của shop — máy chủ ĐÃ xin lỗi và đề nghị ĐƠN ĐÃ SỬA (lượt giữ đơn DUY NHẤT đã dùng):",
    `  ${r.items} = ${money}. Dòng hàng: ${r.lines.map((l) => `variant_id ${l.variantId} × ${l.quantity}`).join(", ")}.`,
    "  Khách đồng ý ⇒ update_draft_order ĐÚNG các dòng này rồi cancel_order decision KEEP. Khách vẫn không lấy ⇒ cancel_order decision CANCEL.",
    "  TUYỆT ĐỐI KHÔNG giữ đơn thêm, KHÔNG mời thêm món, KHÔNG nói số tiền nào khác.",
  ].join("\n");
}
