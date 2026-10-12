/**
 * ═══════════ VÒNG ĐỜI KHÁCH DÙNG CHUNG — NƠI DUY NHẤT (P0 11/10/2026 · mission `followup-lifecycle`) ═══════════
 *
 * Sự cố (KimThu Le, hội thoại a8c10daf…): bot lên đơn #71B31FE3, lõi đơn ghi thẳng «Đã xác nhận» (công tắc «đơn đủ thông tin =
 * đã xác nhận» của tổ chức) — nhưng `state.confirmed` CHỈ do công cụ `confirm_order` ghi, nên job follow-up (chỉ đọc
 * `state.confirmed`) vẫn coi khách «đang có đơn nháp chưa xác nhận» và nhắn 11:54 «đơn … đã lên xong, em xác nhận để gửi đi
 * luôn nhé ạ?», 16:54, rồi 08:54 hôm sau «… có muốn tiếp tục chốt đơn …». Gốc: mỗi nơi tự suy «khách đang ở đâu» từ một
 * mảnh riêng (sổ của bot, SĐT, trạng thái Pancake) — không nơi nào đọc ĐƠN THẬT.
 *
 * Tệp này là MỘT phép dựng ảnh chụp vòng đời, sáu CHIỀU ĐỘC LẬP — không gộp thành một trường, vì mỗi chiều có nguồn sự thật
 * riêng và suy chiều này từ chiều kia là đúng lỗi cần chặn (AGENTS 0.1: logistics, tiền, tồn kho không suy ra nhau):
 *
 *  · `salesStage`  — HỘI THOẠI đã đi tới đâu (sổ của bot `state`): LEAD · CONSULTING · INTENT_TO_BUY · CUSTOMER_INFO_COLLECTED ·
 *                    AWAITING_CONFIRMATION · CUSTOMER_DECLINED. Là bước XA NHẤT hội thoại đạt; KHÔNG nói gì về đơn. SĐT + địa
 *                    chỉ chỉ cho ra CUSTOMER_INFO_COLLECTED — không bao giờ một mình suy ra đơn CREATED.
 *  · `quote`       — NONE · QUOTED · VERIFIED · UNKNOWN. Hôm nay ERP chưa có dữ kiện «báo giá đã xác thực» ⇒ mặc định UNKNOWN;
 *                    nháp của bot (đơn giá máy chủ đọc từ ERP) ⇒ QUOTED. VERIFIED chỉ do worker `authoritative-quote` cấp qua
 *                    `facts.quote` — tệp này không tự phong.
 *  · `order`       — NONE · CREATION_PENDING · CREATED · CONFIRMED · CANCELLED · RETURNED · UNKNOWN. Nguồn: dòng `orders` nối với
 *                    hội thoại (cùng các phép nối của claim-guard #789: `sales_conversation_id` · ô đơn / nháp của hội thoại ·
 *                    đơn trong sổ bot · cùng luồng Pancake `page_id + conversation_id`). CREATION_PENDING = nháp CỦA BOT đang
 *                    chờ khách xác nhận (đơn «Mới» mà bot chưa `confirm_order`) — công cụ tự gắn nhãn «Nháp — chưa chốt»,
 *                    claim-guard cũng không coi nó là đơn. Đơn «Mới» của NGƯỜI / máy ghi đơn là CREATED.
 *  · `payment`     — NONE · PENDING · PAID · UNKNOWN. CHỈ chứng từ thu `order_payments` CONFIRMED của đơn tạo tay
 *                    (`manualPaymentStatus`, như claim-guard). Trả trước khai trên POS / trạng thái «PAID» của Pancake KHÔNG
 *                    phải tiền thật ⇒ đơn Pancake là UNKNOWN (ERP không có sổ thu của nó), không phải NONE.
 *  · `fulfillment` — NONE · SHIPPING · DELIVERED · UNKNOWN. CHỈ `ORDER_OUTCOME` (nguồn chân lý duy nhất — AGENTS 0.2) +
 *                    `SHIPMENT_LEFT_WAREHOUSE` (mốc lấy hàng / chặng dựng từ sự kiện ĐVVC). Trạng thái Pancake không dùng.
 *  · `contact`     — OK · OPTED_OUT · HUMAN_TAKEOVER. OPTED_OUT = khách gõ rõ «đừng nhắn nữa / không muốn nhận tin…»
 *                    (`optOutInCustomerText`, chỉ cụm rõ ràng); HUMAN_TAKEOVER = hội thoại `HANDOFF` · `state.handoff` ·
 *                    chế độ HUMAN / COPILOT.
 *
 * Mỗi chiều mang câu NGUỒN (`sources`) để người đọc vết biết kết luận đứng trên dòng nào. Đọc lỗi ⇒ chiều đó UNKNOWN; người
 * dùng ảnh chụp phải rơi về phía HẸP (follow-up: không gửi). Đọc ra lúc cần, KHÔNG cột trạng thái, KHÔNG backfill (AGENTS 8.8).
 *
 * Hàm dựng `deriveLifecycle` là HÀM THUẦN; `loadLifecycle` là bộ nạp dữ kiện duy nhất (một lượt đọc hội thoại + một câu đơn
 * kèm ORDER_OUTCOME + một câu chứng từ thu + tin khách gần đây). Worker `authoritative-quote` dùng lại tệp này, không dựng bản
 * riêng.
 */
import { and, desc, eq, gte, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments, type OrderPaymentStatus } from "@/lib/constants/order-payments";
import type { OrderOutcome } from "@/lib/constants/returns";
import { ORDER_OUTCOME, PRIMARY_ATTEMPT, SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";
import type { AiBlock } from "@/lib/ai/provider";
import { controlOf, type ConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { foldVi } from "@/lib/sales-chatbot/text";
import type { ChatState } from "@/lib/sales-chatbot/tools";

/** Phiên bản ĐỊNH NGHĨA ảnh chụp (luật 40) — đổi cách suy một chiều ⇒ tăng số; vết follow-up ghi số này. */
export const LIFECYCLE_VERSION = "lc1";

export const LIFECYCLE_SALES_STAGES = ["LEAD", "CONSULTING", "INTENT_TO_BUY", "CUSTOMER_INFO_COLLECTED", "AWAITING_CONFIRMATION", "CUSTOMER_DECLINED"] as const;
export type LifecycleSalesStage = (typeof LIFECYCLE_SALES_STAGES)[number];
export type LifecycleQuote = "NONE" | "QUOTED" | "VERIFIED" | "UNKNOWN";
export type LifecycleOrder = "NONE" | "CREATION_PENDING" | "CREATED" | "CONFIRMED" | "CANCELLED" | "RETURNED" | "UNKNOWN";
export type LifecyclePayment = "NONE" | "PENDING" | "PAID" | "UNKNOWN";
export type LifecycleFulfillment = "NONE" | "SHIPPING" | "DELIVERED" | "UNKNOWN";
export type LifecycleContact = "OK" | "OPTED_OUT" | "HUMAN_TAKEOVER";
export type LifecycleDimension = "salesStage" | "quote" | "order" | "payment" | "fulfillment" | "contact";

/** Phép nối một đơn với hội thoại — cùng tập với claim-guard (#789) + đơn trong sổ bot. */
export type OrderLink = "SALES_CONVERSATION" | "CONV_ORDER" | "CONV_DRAFT" | "BOT_STATE" | "THREAD";

export type LinkedOrderFact = {
  id: string;
  /** `orders.stage` (chuỗi). */
  stage: string;
  insertedAt: Date | null;
  linkedBy: OrderLink[];
  /** `ORDER_OUTCOME` của đơn (LEFT JOIN vận đơn chính) — `null` = không đọc được. */
  outcome: OrderOutcome | null;
  /** `SHIPMENT_LEFT_WAREHOUSE` — `false` khi chưa có vận đơn. */
  leftWarehouse: boolean;
  /** Trạng thái chứng từ thu (đơn tạo tay `erp-`); `null` = đơn không có sổ thu trong ERP (Pancake). */
  payment: OrderPaymentStatus | null;
};

export type LifecycleFacts = {
  conversation: { status: string; handoffReason: string | null; control: ConversationControl; turns: number };
  state: ChatState;
  /** `null` = đọc đơn lỗi ⇒ order / payment / fulfillment UNKNOWN. */
  orders: readonly LinkedOrderFact[] | null;
  /** Do worker báo giá cấp (chưa có ⇒ bỏ trống). */
  quote?: { state: "QUOTED" | "VERIFIED"; source: string } | null;
  /** Chữ KHÁCH gõ gần đây (không lưu vào ảnh chụp) — chỉ để nhận lời từ chối nhận tin. */
  customerTexts: readonly string[];
};

export type LifecycleSnapshot = {
  version: string;
  salesStage: LifecycleSalesStage;
  quote: LifecycleQuote;
  order: LifecycleOrder;
  payment: LifecyclePayment;
  fulfillment: LifecycleFulfillment;
  contact: LifecycleContact;
  /** Đơn mà chiều `order` đang nói tới (mã đầy đủ) — `null` khi không có / chỉ là sổ bot mô phỏng. */
  orderId: string | null;
  /** Câu nguồn của từng chiều — không chứa SĐT / tên / chữ khách. */
  sources: Record<LifecycleDimension, string>;
};

/** Ảnh chụp khi không đọc được gì — mọi chiều về phía hẹp. */
export const UNKNOWN_LIFECYCLE: LifecycleSnapshot = {
  version: LIFECYCLE_VERSION,
  salesStage: "LEAD",
  quote: "UNKNOWN",
  order: "UNKNOWN",
  payment: "UNKNOWN",
  fulfillment: "UNKNOWN",
  contact: "OK",
  orderId: null,
  sources: { salesStage: "không đọc được hội thoại", quote: "không đọc được", order: "không đọc được", payment: "không đọc được", fulfillment: "không đọc được", contact: "không đọc được" },
};

// ═══ LỜI TỪ CHỐI NHẬN TIN ═══

/**
 * Cụm khách nói rõ KHÔNG MUỐN nhận tin nữa — đọc trên chữ đã bỏ dấu. Cố ý hẹp: «không nhận hàng» là từ chối ĐƠN (chiều bán),
 * không phải từ chối NHẬN TIN; chỉ cụm có «nhắn tin / gửi tin / làm phiền / … nữa» mới tính.
 */
const OPT_OUT_RULES: readonly RegExp[] = [
  /\b(?:dung|thoi|ngung|khong|ko|k)\s+(?:nhan|gui|ib|inbox)(?:\s+tin)?(?:\s+\S+){0,3}\s+nua\b/, // «đừng nhắn nữa» · «đừng nhắn tin cho chị nữa» · «không gửi tin nữa»
  /\b(?:dung|ngung|thoi)\s+(?:nhan tin|gui tin|spam|lam phien|ib|inbox)\b/, // «đừng nhắn tin» · «ngừng gửi tin» · «đừng làm phiền»
  /\b(?:khong|ko|k)\s+(?:muon|can)\s+nhan\s+(?:duoc\s+)?tin(?:\s+nhan)?\b/, // «không muốn nhận tin nhắn»
  /\b(?:huy dang ky|unsubscribe)\b/,
  /^\s*stop\s*$/,
];

/** Khách nói rõ không muốn nhận tin nữa không. HÀM THUẦN. */
export function optOutInCustomerText(text: string): boolean {
  const f = foldVi(text.normalize("NFC"));
  return OPT_OUT_RULES.some((re) => re.test(f));
}

// ═══ PHẦN THUẦN ═══

const LIVE_RANK: Partial<Record<LifecycleOrder, number>> = { CONFIRMED: 3, CREATED: 2, CREATION_PENDING: 1 };

/** Một đơn đọc thành chiều `order` (chưa xét đơn khác). HÀM THUẦN. */
export function orderStateOf(o: Pick<LinkedOrderFact, "id" | "stage" | "outcome">, botDraftId: string | null): LifecycleOrder {
  if (o.stage === "CANCELLED" || o.outcome === "CANCELLED") return "CANCELLED";
  if (o.stage === "RETURNED" || o.stage === "PARTIAL_RETURN" || o.outcome === "RETURNED" || o.outcome === "RETURNED_BY_RULE") return "RETURNED";
  if (o.stage === "NEW" && botDraftId !== null && o.id === botDraftId) return "CREATION_PENDING";
  if (o.stage === "NEW" || o.stage === "WAITING") return "CREATED";
  return "CONFIRMED";
}

const shortId = (id: string) => `#${manualOrderShortCode(id)}`;

/**
 * Dựng ảnh chụp vòng đời từ dữ kiện. HÀM THUẦN — cùng dữ kiện luôn ra cùng ảnh chụp.
 */
export function deriveLifecycle(f: LifecycleFacts): LifecycleSnapshot {
  const st = f.state;
  const sources = {} as Record<LifecycleDimension, string>;

  // ── order ──
  let order: LifecycleOrder;
  let chosen: LinkedOrderFact | null = null;
  const botDraftId = !st.confirmed ? (st.draft?.orderId ?? null) : null;
  if (f.orders === null) {
    order = "UNKNOWN";
    sources.order = "không đọc được đơn nối với hội thoại";
  } else {
    const rows = f.orders.filter((o) => o.stage !== "DELETED").map((o) => ({ o, s: orderStateOf(o, botDraftId) }));
    const t = (d: Date | null) => d?.getTime() ?? 0;
    const live = rows.filter((r) => LIVE_RANK[r.s] !== undefined).sort((a, b) => LIVE_RANK[b.s]! - LIVE_RANK[a.s]! || t(b.o.insertedAt) - t(a.o.insertedAt));
    const ended = rows.filter((r) => LIVE_RANK[r.s] === undefined).sort((a, b) => t(b.o.insertedAt) - t(a.o.insertedAt));
    const top = live[0] ?? ended[0] ?? null;
    if (top) {
      order = top.s;
      chosen = top.o;
      sources.order = `orders ${shortId(top.o.id)} stage=${top.o.stage}${top.o.outcome ? ` · ORDER_OUTCOME=${top.o.outcome}` : ""} (nối: ${top.o.linkedBy.join("+")})`;
    } else if (st.confirmed) {
      // Sổ bot nói đã chốt mà CSDL không có dòng (khung THỬ mô phỏng, hoặc dòng đã bị xoá) ⇒ vẫn coi là đã chốt (phía hẹp).
      order = "CONFIRMED";
      sources.order = `state.confirmed${st.confirmed.simulated ? " (mô phỏng)" : ""} — không thấy dòng orders`;
    } else if (st.cancelledOrders?.length) {
      order = "CANCELLED";
      sources.order = "state.cancelledOrders — không thấy dòng orders";
    } else if (st.draft) {
      order = "CREATION_PENDING";
      sources.order = `state.draft${st.draft.simulated ? " (mô phỏng)" : ""} — chưa có dòng orders`;
    } else {
      order = "NONE";
      sources.order = "không có đơn nối với hội thoại (sales_conversation_id · ô đơn · sổ bot · cùng luồng Pancake)";
    }
  }

  // ── payment (chỉ chứng từ thu) ──
  let payment: LifecyclePayment;
  if (f.orders === null) {
    payment = "UNKNOWN";
    sources.payment = "không đọc được đơn";
  } else if (!chosen) {
    payment = "NONE";
    sources.payment = "không có đơn ERP để có chứng từ thu";
  } else if (chosen.payment === null) {
    payment = "UNKNOWN";
    sources.payment = "đơn không tạo trong ERP — không có sổ chứng từ thu (trả trước POS / trạng thái Pancake không phải tiền thật)";
  } else {
    payment = chosen.payment === "PAID" ? "PAID" : chosen.payment === "PARTIALLY_PAID" ? "PENDING" : "NONE";
    sources.payment = `order_payments CONFIRMED của ${shortId(chosen.id)}: ${chosen.payment}`;
  }

  // ── fulfillment (ORDER_OUTCOME + chặng ĐVVC) ──
  let fulfillment: LifecycleFulfillment;
  if (f.orders === null) {
    fulfillment = "UNKNOWN";
    sources.fulfillment = "không đọc được đơn";
  } else if (!chosen) {
    fulfillment = "NONE";
    sources.fulfillment = "không có đơn";
  } else if (chosen.outcome === "DELIVERED") {
    fulfillment = "DELIVERED";
    sources.fulfillment = `ORDER_OUTCOME=DELIVERED (${shortId(chosen.id)})`;
  } else if (chosen.outcome === "IN_TRANSIT" || (chosen.leftWarehouse && order !== "CANCELLED" && order !== "RETURNED")) {
    fulfillment = "SHIPPING";
    sources.fulfillment = `${chosen.outcome === "IN_TRANSIT" ? "ORDER_OUTCOME=IN_TRANSIT" : "SHIPMENT_LEFT_WAREHOUSE"} (${shortId(chosen.id)})`;
  } else if (chosen.outcome === null || chosen.outcome === "UNKNOWN") {
    fulfillment = "UNKNOWN";
    sources.fulfillment = `ORDER_OUTCOME=${chosen.outcome ?? "không đọc được"} (${shortId(chosen.id)})`;
  } else {
    fulfillment = "NONE";
    sources.fulfillment = `ORDER_OUTCOME=${chosen.outcome} (${shortId(chosen.id)})`;
  }

  // ── salesStage (sổ của bot) ──
  let salesStage: LifecycleSalesStage;
  const hasContact = Boolean(st.customer?.phone && st.customer?.address);
  if (st.declined) {
    salesStage = "CUSTOMER_DECLINED";
    sources.salesStage = "state.declined (mark_declined)";
  } else if (st.draft || st.confirmed || st.stage === "CONFIRM" || st.stage === "DONE") {
    salesStage = "AWAITING_CONFIRMATION";
    sources.salesStage = st.draft || st.confirmed ? "state.draft / state.confirmed (tóm tắt đơn đã đọc cho khách)" : `state.stage=${st.stage}`;
  } else if (hasContact) {
    salesStage = "CUSTOMER_INFO_COLLECTED";
    sources.salesStage = "state.customer có SĐT + địa chỉ (KHÔNG phải bằng chứng có đơn)";
  } else if (st.customer || st.stage === "INFO" || st.stage === "UPSELL") {
    salesStage = "INTENT_TO_BUY";
    sources.salesStage = st.customer ? "state.customer (thiếu SĐT hoặc địa chỉ)" : `state.stage=${st.stage}`;
  } else if (st.stage === "QUOTE" || st.stage === "CONSULT" || f.conversation.turns > 0) {
    salesStage = "CONSULTING";
    sources.salesStage = st.stage ? `state.stage=${st.stage}` : "bot đã trả lời ít nhất một lượt";
  } else {
    salesStage = "LEAD";
    sources.salesStage = "chưa có lượt bot nào";
  }

  // ── quote ──
  let quote: LifecycleQuote;
  if (f.quote) {
    quote = f.quote.state;
    sources.quote = f.quote.source;
  } else if (st.draft || st.confirmed) {
    quote = "QUOTED";
    sources.quote = "đơn giá máy chủ đọc từ ERP lúc lên nháp (chưa có xác thực báo giá — worker authoritative-quote)";
  } else {
    quote = "UNKNOWN";
    sources.quote = "chưa có dữ kiện báo giá đã xác thực";
  }

  // ── contact ──
  let contact: LifecycleContact;
  const optedOut = f.customerTexts.some(optOutInCustomerText);
  if (optedOut) {
    contact = "OPTED_OUT";
    sources.contact = "khách gõ rõ lời từ chối nhận tin (optOutInCustomerText)";
  } else if (f.conversation.status === "HANDOFF" || st.handoff || f.conversation.control !== "AUTO") {
    contact = "HUMAN_TAKEOVER";
    sources.contact = f.conversation.status === "HANDOFF" ? "hội thoại HANDOFF" : st.handoff ? "state.handoff" : `chế độ hội thoại ${f.conversation.control}`;
  } else {
    contact = "OK";
    sources.contact = "AUTO, không chuyển người, không lời từ chối nhận tin";
  }

  return { version: LIFECYCLE_VERSION, salesStage, quote, order, payment, fulfillment, contact, orderId: chosen?.id ?? (order === "CONFIRMED" ? (st.confirmed?.orderId ?? null) : null), sources };
}

// ═══ PHẦN MÁY CHỦ — BỘ NẠP DỮ KIỆN DUY NHẤT ═══

/** Đơn nối được tính cho LƯỢT MUA hiện tại: tạo trong chừng này ngày (đơn ghi rõ trong ô / sổ bot thì luôn tính). */
export const LIFECYCLE_ORDER_LOOKBACK_DAYS = 30;
/** Số tin khách gần nhất đọc để nhận lời từ chối nhận tin. */
const OPT_OUT_SCAN_MESSAGES = 40;
/** = `SHOP_SAID` của engine.ts (tin phía shop chép vào lịch sử) — không import để tránh vòng engine ↔ lifecycle; bài kiểm so hai giá trị. */
export const LIFECYCLE_SHOP_SAID_PREFIX = "[Shop đã nhắn]";

export type LifecycleConvRow = {
  id: string;
  channel: string;
  status: string;
  handoffReason: string | null;
  state: ChatState;
  orderId: string | null;
  draftOrderId: string | null;
  pageId: string | null;
  threadId: string | null;
  turns: number;
  lastBotAt: Date | null;
  lastCustomerAt: Date | null;
  lastStaffAt: Date | null;
  waitingSince: Date | null;
  nextFollowupAt: Date | null;
  followupsSent: number;
  humanCooldownUntil: Date | null;
};

export type LoadedLifecycle = { conv: LifecycleConvRow; facts: LifecycleFacts; snapshot: LifecycleSnapshot };

/** Đơn nối với hội thoại + ORDER_OUTCOME + chứng từ thu. Ném khi CSDL lỗi (người gọi quyết phía hẹp). */
export async function linkedOrdersFor(conv: Pick<LifecycleConvRow, "id" | "orderId" | "draftOrderId" | "pageId" | "threadId" | "state">, now: Date, opts: { includePast?: boolean } = {}): Promise<LinkedOrderFact[]> {
  const db = await getDb();
  const o = schema.orders;
  const s = schema.shipments;
  const st = conv.state;
  const past = new Set((st.pastOrders ?? []).map((p) => p.orderId).filter((x): x is string => Boolean(x)));
  const explicit = new Map<string, OrderLink>();
  if (conv.orderId) explicit.set(conv.orderId, "CONV_ORDER");
  if (conv.draftOrderId && !explicit.has(conv.draftOrderId)) explicit.set(conv.draftOrderId, "CONV_DRAFT");
  for (const id of [st.confirmed?.orderId, st.draft?.orderId, ...(st.cancelledOrders ?? []).map((c) => c.orderId), ...(opts.includePast ? (st.pastOrders ?? []).map((p) => p.orderId) : [])]) if (id && !explicit.has(id)) explicit.set(id, "BOT_STATE");
  const since = new Date(now.getTime() - LIFECYCLE_ORDER_LOOKBACK_DAYS * 86_400_000);
  const recent: SQL[] = [eq(o.salesConversationId, conv.id)];
  if (conv.pageId && conv.threadId) recent.push(and(eq(o.pageId, conv.pageId), eq(o.conversationId, conv.threadId))!);
  const where = or(and(or(...recent), gte(o.insertedAt, since)), explicit.size ? inArray(o.id, [...explicit.keys()]) : undefined)!;
  const rows = await db
    .select({
      id: o.id,
      stage: sql<string>`${o.stage}::text`,
      insertedAt: o.insertedAt,
      salesConversationId: o.salesConversationId,
      pageId: o.pageId,
      conversationId: o.conversationId,
      total: o.totalPriceAfterDiscount,
      ship: o.shippingFee,
      outcome: sql<OrderOutcome>`${ORDER_OUTCOME}`,
      leftWarehouse: sql<boolean>`coalesce(${SHIPMENT_LEFT_WAREHOUSE}, false)`,
    })
    .from(o)
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(where, ne(o.stage, "DELETED")))
    .orderBy(desc(o.insertedAt))
    .limit(20);
  // `includePast` (giai đoạn sau bán — `loadCustomerPhase`): đơn của lượt mua CŨ vẫn là đơn khách đang chờ / vừa nhận — không loại.
  const kept = opts.includePast ? rows : rows.filter((r) => !past.has(r.id));
  const manual = kept.filter((r) => r.id.startsWith("erp-"));
  const pay = new Map<string, OrderPaymentStatus>();
  if (manual.length) {
    const p = schema.orderPayments;
    const prow = await db.select({ orderId: p.orderId, kind: p.kind, amount: p.amount, status: p.status }).from(p).where(inArray(p.orderId, manual.map((x) => x.id)));
    for (const x of manual) {
      const sums = sumConfirmedPayments(prow.filter((r) => r.orderId === x.id).map((r) => ({ kind: r.kind, amount: Number(r.amount), status: r.status })));
      pay.set(x.id, manualPaymentStatus(sums, manualOrderAmountDue({ totalPriceAfterDiscount: Number(x.total ?? 0), shippingFee: Number(x.ship ?? 0) })).status);
    }
  }
  return kept.map((r) => {
    const linkedBy: OrderLink[] = [];
    if (r.salesConversationId === conv.id) linkedBy.push("SALES_CONVERSATION");
    const ex = explicit.get(r.id);
    if (ex) linkedBy.push(ex);
    if (conv.pageId && conv.threadId && r.pageId === conv.pageId && r.conversationId === conv.threadId) linkedBy.push("THREAD");
    return { id: r.id, stage: r.stage, insertedAt: r.insertedAt, linkedBy, outcome: r.outcome ?? null, leftWarehouse: Boolean(r.leftWarehouse), payment: r.id.startsWith("erp-") ? (pay.get(r.id) ?? "UNPAID") : null };
  });
}

function customerTextsOf(rows: readonly { content: unknown }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const blocks = Array.isArray(r.content) ? (r.content as AiBlock[]) : [];
    for (const b of blocks) if (b.type === "text" && b.text.trim() && !b.text.startsWith(LIFECYCLE_SHOP_SAID_PREFIX)) out.push(b.text.slice(0, 500));
  }
  return out;
}

/**
 * Đọc MỚI hội thoại + dữ kiện vòng đời + ảnh chụp. `null` = không có hội thoại. Đọc đơn lỗi ⇒ `facts.orders = null` (chiều đơn
 * UNKNOWN), không ném. Mỗi lần gọi là một lượt đọc MỚI — không đệm (follow-up gọi lại ngay trước khi gửi).
 */
export async function loadLifecycle(conversationId: string, now: Date, extra: { quote?: LifecycleFacts["quote"] } = {}): Promise<LoadedLifecycle | null> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db
    .select({
      id: c.id,
      channel: c.channel,
      status: c.status,
      handoffReason: c.handoffReason,
      state: c.state,
      orderId: c.orderId,
      draftOrderId: c.draftOrderId,
      pageId: c.pageId,
      threadId: c.threadId,
      turns: c.turns,
      lastBotAt: c.lastBotAt,
      lastCustomerAt: c.lastCustomerAt,
      lastStaffAt: c.lastStaffAt,
      waitingSince: c.waitingSince,
      nextFollowupAt: c.nextFollowupAt,
      followupsSent: c.followupsSent,
      humanCooldownUntil: c.humanCooldownUntil,
    })
    .from(c)
    .where(eq(c.id, conversationId))
    .limit(1);
  if (!row) return null;
  const conv: LifecycleConvRow = { ...row, state: (row.state ?? {}) as ChatState };
  const orders = await linkedOrdersFor(conv, now).catch(() => null);
  const m = schema.salesChatMessages;
  const texts = await db
    .select({ content: m.content })
    .from(m)
    .where(and(eq(m.conversationId, conversationId), eq(m.role, "user")))
    .orderBy(desc(m.seq))
    .limit(OPT_OUT_SCAN_MESSAGES)
    .then(customerTextsOf)
    .catch(() => [] as string[]);
  const facts: LifecycleFacts = {
    conversation: { status: conv.status, handoffReason: conv.handoffReason, control: controlOf(conv.state), turns: conv.turns },
    state: conv.state,
    orders,
    quote: extra.quote ?? null,
    customerTexts: texts,
  };
  return { conv, facts, snapshot: deriveLifecycle(facts) };
}

// ═══ GIAI ĐOẠN KHÁCH SAU KHI CÓ ĐƠN (HOTFIX P0 12/10/2026 — ca HSLC «Khanh Nhung», đơn #6495CA72) ═══
//
// Sự cố: khách nhắn «Tôi nhận hàng rồi nhưng chưa thử chất lượng» khi AI đã DỪNG hơn 1.500 phút: luật cũ của engine «khách nhắn
// trong 3 ngày sau khi chốt đơn (chốt qua lời đồng ý) ⇒ chuyển người» bắt MỌI tin, kể cả lời cảm ơn, và phòng phụ trách không có ai.
// Hết 3 ngày thì engine đẩy đơn sang `pastOrders` rồi bán lại từ đầu ⇒ AI có thể chào bán / xin chốt lại khi khách chỉ báo đã nhận
// hàng. Gốc chung: không nơi nào gọi tên GIAI ĐOẠN của khách sau khi đã có đơn.
//
// `customerPhaseOf` là PHÉP CHIẾU của ảnh chụp sáu chiều ở trên (không phải trục thứ hai): đọc `order` + `fulfillment` (chứng từ ĐVVC /
// ORDER_OUTCOME) + `salesStage`, cộng HAI lời khai của khách trong tin đang trả lời — «đã nhận hàng» và «khiếu nại». Lời khai của
// khách CHỈ đổi cách AI nói chuyện; nó KHÔNG đổi trạng thái đơn, không đổi `fulfillment`, không ghi gì (AGENTS 0.1 — không kết luận
// giao thành công từ lời khách). Nhãn «đã nhận» luôn mang NGUỒN: `CARRIER` (chứng từ ĐVVC / phiếu giao) hay `CUSTOMER_CLAIM`.

export const CUSTOMER_PHASES = ["PRE_SALE", "CLOSING", "AWAITING_SHIPMENT", "IN_TRANSIT", "RECEIVED", "AFTER_SALES", "COMPLAINT"] as const;
export type CustomerPhase = (typeof CUSTOMER_PHASES)[number];
export const CUSTOMER_PHASE_LABEL: Record<CustomerPhase, string> = {
  PRE_SALE: "tư vấn trước bán",
  CLOSING: "đang chốt",
  AWAITING_SHIPMENT: "chờ giao",
  IN_TRANSIT: "đang giao",
  RECEIVED: "đã nhận hàng",
  AFTER_SALES: "chăm sóc sau bán",
  COMPLAINT: "khiếu nại",
};
/** Đơn đã nhận (theo ĐVVC hoặc lời khách) lên quá chừng này ngày ⇒ «chăm sóc sau bán» thay vì «vừa nhận hàng». Mốc phân nhóm, không phải đích. */
export const AFTER_SALES_DAYS = 7;

const RECEIPT_RULES: readonly RegExp[] = [
  /\b(?:da|moi|vua|minh|em|chi|toi|tui|anh)\s+nhan\s+(?:duoc\s+)?(?:hang|don|roi)\b/,
  /\bnhan\s+(?:duoc\s+)?(?:hang|don)\s+(?:roi|r)\b/,
  /\bhang\s+(?:ve|toi|den)\s+(?:roi|r)\b/,
];
const RECEIPT_NEGATION = /\b(?:chua|khong|ko|bao gio|khi nao|luc nao)\s+(?:\S+\s+){0,2}nhan\b|\bnhan\s+(?:hang\s+)?o\s+dau\b/;

/** Khách tự nói ĐÃ NHẬN HÀNG — LỜI KHAI, chỉ đổi cách AI trả lời. Đọc trên chữ đã bỏ dấu. HÀM THUẦN. */
export function customerReceiptClaim(text: string): boolean {
  const f = foldVi(text.normalize("NFC"));
  if (RECEIPT_NEGATION.test(f)) return false;
  return RECEIPT_RULES.some((re) => re.test(f));
}

/**
 * LUẬT KHIẾU NẠI (review #821 vòng 2): engine ép chuyển người + bot im theo luật này, nên bắt NHẦM một câu khen là tái tạo đúng sự cố PR
 * này sửa. Ba hàng rào:
 *  1. Từ MƠ HỒ khi bỏ dấu («dở» ↔ «đó / đỡ / đỏ», «chậm» ↔ «chấm / chăm», «ngứa» ↔ «ngừa», «đau» …) chỉ khớp trên chữ CÒN DẤU
 *     (`folded: false`). Luật chạy trên chữ bỏ dấu chỉ gồm cụm KHÔNG mơ hồ (khách gõ không dấu vẫn được bắt: «goi ruoc bi moc»).
 *  2. Phủ định ngay trước cụm («không / chưa / ko (bị) …») ⇒ không tính: «ruốc ngon, không bị chảy dầu như chỗ khác».
 *  3. Mệnh đề HỎI («thế nào», «… không em?») chỉ tính luật có từ LỖI rõ (`inQuestion: true` — mốc, hỏng, thiếu, sai…); «chậm … cũng
 *     được / không sao» không phải than phiền.
 */
type ComplaintRule = { re: RegExp; folded: boolean; inQuestion: boolean; unless?: RegExp };
const W0 = String.raw`(?:^|[^\p{L}\d])`;
const W1 = String.raw`(?=$|[^\p{L}\d])`;
const acc = (body: string): RegExp => new RegExp(`${W0}(?:${body})${W1}`, "u");
const SLOW_OK = /\b(?:cung duoc|khong sao|ko sao|tu tu|khong van de|cung ok)\b/;
const COMPLAINT_RULES: readonly ComplaintRule[] = [
  // Hàng lỗi — cụm không mơ hồ khi bỏ dấu.
  { re: /\bbi\s+(?:loi|hong|thiu|moc|chay dau|chay nuoc|het han|qua han)\b/, folded: true, inQuestion: true },
  // «bị đau bụng / ngộ độc» gõ không dấu — câu HỎI («ăn có bị đau bụng không em?») là hỏi trước khi mua, không tính.
  { re: /\bbi\s+(?:dau bung|ngo doc|tieu chay|di ung)\b/, folded: true, inQuestion: false },
  { re: /\b(?:hang|banh|san pham|sp|goi|hop|tui)\s+(?:loi|hong|thiu|moc|het han|qua han)\b/, folded: true, inQuestion: true },
  { re: acc("bị\\s+(?:vỡ|bể|dập|nát|hư|có mùi|bốc mùi)|(?:hàng|bánh|sản phẩm|gói|hộp|túi)\\s+(?:vỡ|bể|dập|nát|hư)"), folded: false, inQuestion: true },
  { re: acc("chảy dầu|chảy nước|bốc mùi|có mùi lạ"), folded: false, inQuestion: true },
  // Giao thiếu / sai.
  { re: /\b(?:giao|gui|ship)\s+(?:thieu|sai|nham)\b|\b(?:thieu|sai|nham)\s+(?:hang|mon|so luong|loai|size|mau)\b/, folded: true, inQuestion: true },
  // Đổi trả / hoàn tiền — câu hỏi chính sách («shop có đổi hàng không?») không tính.
  { re: /\b(?:tra|doi)\s+(?:lai\s+)?hang\b|\bhoan\s+(?:lai\s+)?tien\b|\btra\s+lai\s+tien\b|\bboi\s+thuong\b/, folded: true, inQuestion: false },
  { re: /\b(?:khieu nai|phan nan|boc phot|lua dao|that vong)\b/, folded: true, inQuestion: true },
  // Sức khoẻ sau khi ăn (CÓ DẤU — «ngứa» ≠ «ngừa»).
  { re: acc("đau bụng|ngộ độc|tiêu chảy|đi ngoài|buồn nôn|nôn ói|dị ứng|nổi mẩn|ngứa"), folded: false, inQuestion: false },
  // Chất lượng tệ (CÓ DẤU — «dở» ≠ «đó / đỡ / đỏ»); «không ngon MIỆNG» (khách tự nói về mình) không tính.
  { re: acc("(?:dở|tệ|chán|khó ăn|nhạt nhẽo)\\s+(?:quá|lắm|thật|thế|vậy|ghê)|không\\s+(?:còn\\s+)?(?:ngon|tươi|thơm)\\s+(?:như|bằng)|không\\s+(?:giống|đúng như)\\s+(?:ảnh|hình|mô tả|quảng cáo)|khác\\s+(?:ảnh|hình|mô tả|quảng cáo)"), folded: false, inQuestion: false },
  // Giao chậm (CÓ DẤU — «chậm» ≠ «chấm / chăm»); «N ngày chưa thấy» không mơ hồ khi bỏ dấu.
  { re: acc("(?:giao|ship|gửi)\\s+chậm|chậm\\s+quá"), folded: false, inQuestion: false, unless: SLOW_OK },
  { re: /\b\d+\s+ngay\s+(?:roi\s+)?(?:ma\s+)?(?:van\s+)?chua\s+(?:thay|nhan|toi|den|giao)\b/, folded: true, inQuestion: false, unless: SLOW_OK },
];
const COMPLAINT_NEGATION = new Set(["khong", "chua", "ko", "k", "chang", "cha", "khoi"]);
const COMPLAINT_QUESTION_RE = /(?:\b(?:the nao|ra sao)\b|\b(?:khong|ko|chua|nhi|sao|duoc khong)(?:\s+(?:em|shop|a|chi|anh|ban|c|e|vay|v|nhe))*\s*$)/;

/** Mệnh đề (cắt theo dấu câu / phẩy / xuống dòng) kèm cờ hỏi. */
function complaintClauses(text: string): { raw: string; folded: string; question: boolean }[] {
  const out: { raw: string; folded: string; question: boolean }[] = [];
  for (const m of text.normalize("NFC").matchAll(/[^.!?;\n,]+[.!?;\n,]*/g)) {
    const raw = m[0].trim().toLowerCase();
    if (!raw) continue;
    const folded = foldVi(raw).replace(/[.!?;,]+$/g, "").trim();
    out.push({ raw: raw.replace(/[.!?;,]+$/g, "").trim(), folded, question: raw.includes("?") || COMPLAINT_QUESTION_RE.test(folded) });
  }
  return out;
}

function negatedBefore(prefix: string): boolean {
  const words = foldVi(prefix).trim().split(/\s+/).filter(Boolean);
  const last = words.slice(-2);
  // «không bị …» / «chưa bị …» / «không …»: phủ định nằm trong hai từ ngay trước cụm.
  return last.some((w) => COMPLAINT_NEGATION.has(w));
}

/**
 * Khách KHIẾU NẠI / đòi đổi trả / hoàn tiền — câu rõ ràng về hàng lỗi, thiếu, sai, hỏng, chất lượng tệ, đau bụng sau khi ăn, giao chậm,
 * muốn trả / hoàn tiền. «chưa thử chất lượng» KHÔNG phải khiếu nại (khách chưa dùng). Có đơn sống mà khớp ⇒ MÁY CHỦ chuyển người (engine),
 * nên luật ưu tiên KHÔNG BẮT NHẦM (xem ba hàng rào ở trên). HÀM THUẦN.
 */
export function customerComplaintSignal(text: string): boolean {
  for (const c of complaintClauses(text)) {
    for (const rule of COMPLAINT_RULES) {
      if (c.question && !rule.inQuestion) continue;
      if (rule.unless && rule.unless.test(c.folded)) continue;
      const hay = rule.folded ? c.folded : c.raw;
      const m = rule.re.exec(hay);
      if (!m) continue;
      if (negatedBefore(hay.slice(0, m.index + (m[0].length - m[0].trimStart().length)))) continue;
      return true;
    }
  }
  return false;
}

const NOT_RECEIVED_RE = /\b(?:chua|khong|ko|k|van chua)\s+(?:\S+\s+){0,2}(?:nhan|thay)\s+(?:duoc\s+)?(?:hang|don|goi|hop|buu pham)\b|\bchua\s+(?:nhan|thay)\s+(?:gi|duoc gi)\b/;

/**
 * Khách nói CHƯA NHẬN / KHÔNG NHẬN ĐƯỢC hàng. Khi chứng từ ĐVVC báo ĐÃ GIAO thì đây là MÂU THUẪN chứng từ ↔ lời khách — việc của người
 * (kiểm với bưu cục), tuyệt đối không cảm ơn «đã nhận hàng». HÀM THUẦN.
 */
export function customerNotReceivedSignal(text: string): boolean {
  return NOT_RECEIVED_RE.test(foldVi(text.normalize("NFC")));
}

export type CustomerPhaseView = {
  phase: CustomerPhase;
  /** Nguồn của «đã nhận»: chứng từ ĐVVC hay lời khách — `null` khi chưa nói tới nhận hàng. */
  receivedBy: "CARRIER" | "CUSTOMER_CLAIM" | null;
  orderId: string | null;
  /** Câu nguồn cho vết (không chứa chữ khách). */
  source: string;
};

/**
 * Giai đoạn của khách. HÀM THUẦN. Thứ tự: khiếu nại (lời khách, khi có đơn) → không có đơn sống ⇒ trước bán / đang chốt theo
 * `salesStage` → ĐVVC đã giao / khách nói đã nhận ⇒ đã nhận (đơn lên quá `AFTER_SALES_DAYS` ⇒ chăm sóc sau bán) → đang giao → chờ giao.
 */
export function customerPhaseOf(snap: Pick<LifecycleSnapshot, "order" | "fulfillment" | "salesStage" | "orderId">, claims: { receipt: boolean; complaint: boolean; notReceived?: boolean }, orderAgeDays: number | null): CustomerPhaseView {
  const orderId = snap.orderId;
  const hasLive = snap.order === "CREATED" || snap.order === "CONFIRMED";
  if (claims.complaint && (hasLive || snap.order === "RETURNED")) return { phase: "COMPLAINT", receivedBy: null, orderId, source: "lời khách: khiếu nại / đổi trả / hoàn tiền" };
  // ĐVVC báo đã giao mà khách nói chưa nhận ⇒ mâu thuẫn chứng từ ↔ lời khách = khiếu nại (review #821 F2: trước đây ra RECEIVED/CARRIER
  // và lời nhắc CẢM ƠN khách đã nhận hàng).
  if (hasLive && snap.fulfillment === "DELIVERED" && claims.notReceived) return { phase: "COMPLAINT", receivedBy: null, orderId, source: "lời khách «chưa nhận được hàng» — chứng từ ĐVVC báo ĐÃ GIAO (mâu thuẫn, cần kiểm với bưu cục)" };
  if (!hasLive) {
    const closing = snap.order === "CREATION_PENDING" || snap.salesStage === "AWAITING_CONFIRMATION" || snap.salesStage === "CUSTOMER_INFO_COLLECTED";
    return { phase: closing ? "CLOSING" : "PRE_SALE", receivedBy: null, orderId, source: `order=${snap.order} · salesStage=${snap.salesStage}` };
  }
  const old = orderAgeDays !== null && orderAgeDays > AFTER_SALES_DAYS;
  if (snap.fulfillment === "DELIVERED") return { phase: old ? "AFTER_SALES" : "RECEIVED", receivedBy: "CARRIER", orderId, source: "ORDER_OUTCOME=DELIVERED (chứng từ ĐVVC / phiếu giao)" };
  if (claims.receipt) return { phase: old ? "AFTER_SALES" : "RECEIVED", receivedBy: "CUSTOMER_CLAIM", orderId, source: `lời khách «đã nhận hàng» — ERP chưa có chứng từ giao (fulfillment=${snap.fulfillment})` };
  if (snap.fulfillment === "SHIPPING") return { phase: "IN_TRANSIT", receivedBy: null, orderId, source: "ORDER_OUTCOME / chặng ĐVVC: đang giao" };
  return { phase: "AWAITING_SHIPMENT", receivedBy: null, orderId, source: `đơn ${snap.order} · fulfillment=${snap.fulfillment}` };
}

/**
 * Câu dặn AI theo giai đoạn SAU KHI ĐÃ CÓ ĐƠN. Trước bán / đang chốt ⇒ rỗng (lời nhắc bán hàng thường lo). HÀM THUẦN.
 * Luật chung: không hỏi lại SĐT / địa chỉ / món đã có (trừ khi khách tự báo đổi); không đòi chốt lại; không lên đơn mới trừ khi khách
 * nói rõ muốn mua THÊM; không chào bán sai ngữ cảnh. Người chỉ khi thật cần: khiếu nại · đổi trả · hoàn tiền · sửa đơn vượt quyền.
 */
export function postSalePrompt(v: CustomerPhaseView, shortCode: string | null): string {
  if (v.phase === "PRE_SALE" || v.phase === "CLOSING") return "";
  const code = shortCode ? ` #${shortCode}` : "";
  const common =
    `GIAI ĐOẠN KHÁCH: ${CUSTOMER_PHASE_LABEL[v.phase].toUpperCase()} — khách ĐÃ CÓ ĐƠN${code}. KHÔNG hỏi lại SĐT / địa chỉ / món đã có (chỉ khi khách tự báo đổi); KHÔNG mời chốt / xác nhận lại đơn; ` +
    "KHÔNG gọi create_draft_order trừ khi khách nói RÕ muốn mua THÊM một đơn mới; KHÔNG chào bán / giới thiệu món khác khi khách không hỏi. Trả lời đúng câu khách nói, ngắn, ấm áp.";
  if (v.phase === "COMPLAINT") return `${common} Khách đang KHIẾU NẠI / muốn đổi trả / hoàn tiền: xin lỗi ngắn gọn, KHÔNG hứa hoàn tiền / đổi hàng / bồi thường, KHÔNG đổ lỗi ⇒ handoff_to_human với reason «Khiếu nại — <ý khách>».`;
  if (v.phase === "RECEIVED" || v.phase === "AFTER_SALES") {
    const who = v.receivedBy === "CARRIER" ? "Đơn vị vận chuyển báo đã giao." : "Khách NÓI đã nhận hàng (lời khách — ERP chưa có chứng từ giao: KHÔNG nói thay đơn vị vận chuyển, KHÔNG nói đơn «đã giao thành công»).";
    return `${common} ${who} Cảm ơn khách đã nhận hàng, hỏi thăm nhẹ (dùng thử thấy thế nào / cần hướng dẫn bảo quản, sử dụng không). Khách chưa dùng thử ⇒ chúc khách dùng ngon và mời phản hồi khi dùng. Khách hỏi cách dùng / bảo quản ⇒ trả lời theo «Về shop» / sổ tay. Khách báo hàng lỗi / thiếu / sai / muốn đổi trả / hoàn tiền ⇒ handoff_to_human «Khiếu nại — <ý khách>».`;
  }
  if (v.phase === "IN_TRANSIT") return `${common} Đơn đang trên đường giao: khách hỏi bao giờ nhận ⇒ get_order_status rồi nói ĐÚNG «status», không hứa ngày giao.`;
  return `${common} Đơn đang chờ gửi đi: khách hỏi tình trạng ⇒ get_order_status rồi nói ĐÚNG «status» (không khẳng định «chưa gửi» khi ERP chưa có thông tin vận chuyển). Khách muốn đổi địa chỉ / số lượng ⇒ update_draft_order nếu đơn còn sửa được, không thì handoff_to_human «Sửa đơn — <ý khách>».`;
}

/**
 * Bộ nạp cho engine: ảnh chụp vòng đời GỒM đơn của lượt mua cũ (`pastOrders`) + giai đoạn khách cho tin `text`. Chỉ đọc khi hội thoại có
 * dấu đơn (sổ bot / ô đơn) — hội thoại chưa từng có đơn không tốn câu nào. Lỗi đọc ⇒ `null` (engine giữ lời nhắc bán hàng thường).
 */
export async function loadCustomerPhase(conv: Pick<LifecycleConvRow, "id" | "orderId" | "draftOrderId" | "pageId" | "threadId" | "state" | "status" | "handoffReason" | "turns">, text: string, now: Date): Promise<(CustomerPhaseView & { shortCode: string | null }) | null> {
  const st = conv.state;
  if (!st.confirmed && !st.pastOrders?.length && !conv.orderId && !st.draft) return null;
  try {
    const orders = await linkedOrdersFor(conv, now, { includePast: true });
    const snap = deriveLifecycle({ conversation: { status: conv.status, handoffReason: conv.handoffReason, control: controlOf(st), turns: conv.turns }, state: st, orders, customerTexts: [] });
    const chosen = snap.orderId ? orders.find((o) => o.id === snap.orderId) : undefined;
    const age = chosen?.insertedAt ? (now.getTime() - chosen.insertedAt.getTime()) / 86_400_000 : null;
    const v = customerPhaseOf(snap, { receipt: customerReceiptClaim(text), complaint: customerComplaintSignal(text), notReceived: customerNotReceivedSignal(text) }, age);
    return { ...v, shortCode: snap.orderId ? manualOrderShortCode(snap.orderId) : null };
  } catch {
    return null;
  }
}
