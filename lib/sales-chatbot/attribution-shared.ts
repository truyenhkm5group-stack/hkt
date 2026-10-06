/**
 * ═══════════ QUY KẾT TỪNG ĐƠN: AI TỰ BÁN · AI GÓP CÔNG · NGƯỜI BÁN (docs/revenue-attribution.md) ═══════════
 *
 * Câu hỏi: «đơn này có bao nhiêu phần là công của AI?». Trả lời bằng sổ sự kiện hội thoại, cho đơn GẮN VỚI MỘT HỘI THOẠI
 * (`orders.sales_conversation_id`). Đơn không đi qua hội thoại nào (nhân viên lên tay trên Pancake / POS) NẰM NGOÀI phép
 * quy kết này — không phải «người bán»; màn hình in số đơn ấy riêng nếu cần, không trộn vào mẫu số.
 *
 * Ba nhãn, ĐỊNH NGHĨA KHÔNG ĐỔI (đổi ⇒ tăng `ATTRIBUTION_VERSION`, hai kỳ khác phiên bản không vẽ xu hướng — luật 40):
 *
 *  · `AI_ONLY`     — đơn chốt trong lượt của bot (khách đồng ý với bot) và TRƯỚC mốc chốt không có người nào chạm vào lượt mua
 *                    đó (không chuyển người, không nhân viên nhận / trả lời).
 *  · `AI_ASSISTED` — có người chạm vào, VÀ AI đã góp một việc bán hàng THẬT trong cùng lượt mua trước mốc lên đơn: báo giá bằng
 *                    công cụ giá, lên đơn nháp, mời mua thêm, hoặc khách để lại SĐT trong lượt bot. Gồm cả đơn bot chốt sau khi
 *                    người đã giúp, và đơn người chốt sau khi bot đã tư vấn.
 *  · `HUMAN_ONLY`  — người lên / chốt đơn và AI KHÔNG góp việc bán hàng nào ở trên. Đơn «AI ghi hộ nhân viên» (order-sync) là
 *                    đơn của người: AI chỉ chép lại cuộc bán của nhân viên, không bán.
 *
 * Một câu chào / một câu trả lời của bot KHÔNG phải góp công (`ai.replied` không có trong danh sách) — lệnh chủ shop: không
 * gắn nhãn «AI góp công» chỉ vì bot nói một câu vô nghĩa.
 *
 * HÀM THUẦN: không đọc / ghi CSDL; cùng sự kiện luôn ra cùng nhãn.
 */

export const ATTRIBUTION_VERSION = 1;

export const ORDER_ATTRIBUTIONS = ["AI_ONLY", "AI_ASSISTED", "HUMAN_ONLY"] as const;
export type OrderAttribution = (typeof ORDER_ATTRIBUTIONS)[number];

export const ORDER_ATTRIBUTION_LABEL: Record<OrderAttribution, string> = {
  AI_ONLY: "AI tự bán",
  AI_ASSISTED: "AI góp công",
  HUMAN_ONLY: "Người bán",
};

/** Loại sự kiện coi là AI GÓP VIỆC BÁN HÀNG thật (khi tác nhân không phải người). */
export const AI_CONTRIBUTION_EVENTS = ["quote.given", "order.drafted", "upsell.offered", "customer.identified"] as const;
/** Loại sự kiện nói «có người chạm vào hội thoại». */
export const HUMAN_TOUCH_EVENTS = ["handoff.requested", "human.took_over", "human.replied"] as const;

export type AttributionEvent = { type: string; actorKind: string; occurredAt: Date; cycle: number; orderId: string | null };

/**
 * Nhãn của MỘT đơn từ sự kiện của hội thoại gắn với nó. `null` = không quy kết được (đơn không có sự kiện lên / chốt đơn nào
 * trong sổ — vd đơn gắn tay trước ngày bật sổ): CHƯA BIẾT, không phải «người bán».
 */
export function attributeOrder(orderId: string, events: readonly AttributionEvent[]): OrderAttribution | null {
  const own = events.filter((e) => e.orderId === orderId && (e.type === "order.drafted" || e.type === "order.confirmed"));
  if (!own.length) return null;
  // Mốc lên đơn = sự kiện sớm nhất của chính đơn đó; lượt mua = lượt của mốc ấy.
  const first = own.reduce((a, b) => (b.occurredAt < a.occurredAt ? b : a));
  const confirm = own.find((e) => e.type === "order.confirmed");
  const humanMade = own.some((e) => e.actorKind === "HUMAN");
  /** Sự kiện của CÙNG lượt mua, xảy ra không muộn hơn `at` (`null` = cả lượt mua). */
  const inCycle = (e: AttributionEvent, at: Date | null) => e.cycle === first.cycle && (at === null || e.occurredAt <= at);
  const humanTouched = (at: Date | null) => events.some((e) => inCycle(e, at) && (HUMAN_TOUCH_EVENTS as readonly string[]).includes(e.type));

  // Người lên / chốt đơn: AI góp công khi TRƯỚC mốc lên đơn bot đã làm một việc bán hàng thật. Đơn nháp chỉ tính khi chính
  // AI lên (đơn người ghi `order.drafted` tác nhân HUMAN).
  if (humanMade) {
    const aiContributed = events.some(
      (e) => inCycle(e, first.occurredAt) && e.actorKind !== "HUMAN" && (AI_CONTRIBUTION_EVENTS as readonly string[]).includes(e.type) && (e.type !== "order.drafted" || e.actorKind === "AI"),
    );
    return aiContributed ? "AI_ASSISTED" : "HUMAN_ONLY";
  }
  // Bot lên / chốt đơn: người chạm vào trước mốc chốt (chưa chốt ⇒ cả lượt mua) ⇒ AI góp công, không phải AI tự bán.
  return humanTouched(confirm ? confirm.occurredAt : null) ? "AI_ASSISTED" : "AI_ONLY";
}

export type AttributedOrder = { attribution: OrderAttribution; valueVnd: number; delivered: boolean; deliveredRevenueVnd: number; settled: boolean; cancelled: boolean };
export type AttributionRow = { orders: number; valueVnd: number; delivered: number; deliveredRevenueVnd: number; settled: number; cancelled: number };
export type AttributionTable = Record<OrderAttribution, AttributionRow> & { unattributed: number };

const emptyRow = (): AttributionRow => ({ orders: 0, valueVnd: 0, delivered: 0, deliveredRevenueVnd: 0, settled: 0, cancelled: 0 });

/** Cộng theo nhãn. Ba nhãn KHÔNG bao giờ gộp thành một ô (AI tự bán ≠ AI có người giúp). HÀM THUẦN. */
export function attributionTable(orders: readonly AttributedOrder[], unattributed: number): AttributionTable {
  const t = { AI_ONLY: emptyRow(), AI_ASSISTED: emptyRow(), HUMAN_ONLY: emptyRow(), unattributed } as AttributionTable;
  for (const o of orders) {
    const r = t[o.attribution];
    r.orders += 1;
    r.valueVnd += o.valueVnd;
    if (o.delivered) {
      r.delivered += 1;
      r.deliveredRevenueVnd += o.deliveredRevenueVnd;
    }
    if (o.settled) r.settled += 1;
    if (o.cancelled) r.cancelled += 1;
  }
  return t;
}

// ─────────────────────────── Follow-up thu hồi ───────────────────────────

/**
 * Một hội thoại đã được bot NHẮC (`followup.sent`) có quay lại không, và có thành đơn không. ĐỊNH NGHĨA:
 *  · `replied`   — có tin khách (`message.received`) SAU một lần nhắc, trong cùng lượt mua với lần nhắc đó.
 *  · đơn THU HỒI — đơn có `order.confirmed` (bất kể ai chốt) mà mốc lên đơn đầu tiên nằm SAU tin trả lời ấy, trong cùng lượt
 *    mua. Khách tự quay lại mua mà KHÔNG trả lời sau lần nhắc nào thì không phải thu hồi.
 * Thu hồi là thuộc tính RIÊNG, đứng cạnh nhãn quy kết (một đơn thu hồi vẫn mang nhãn AI tự bán / góp công / người bán).
 * `fromAt` = chỉ xét lần nhắc từ mốc này (đầu kỳ). HÀM THUẦN.
 */
export function followupRecovery(events: readonly AttributionEvent[], fromAt: Date): { followedUp: boolean; replied: boolean; recoveredOrderIds: string[] } {
  const nudges = events.filter((e) => e.type === "followup.sent" && e.occurredAt >= fromAt);
  if (!nudges.length) return { followedUp: false, replied: false, recoveredOrderIds: [] };
  const firstEventOf = new Map<string, AttributionEvent>();
  const confirmed = new Set<string>();
  for (const e of events) {
    if (!e.orderId || (e.type !== "order.drafted" && e.type !== "order.confirmed")) continue;
    if (e.type === "order.confirmed") confirmed.add(e.orderId);
    const cur = firstEventOf.get(e.orderId);
    if (!cur || e.occurredAt < cur.occurredAt) firstEventOf.set(e.orderId, e);
  }
  let replied = false;
  const recovered = new Set<string>();
  for (const n of nudges) {
    const reply = events
      .filter((e) => e.type === "message.received" && e.cycle === n.cycle && e.occurredAt > n.occurredAt)
      .reduce<AttributionEvent | null>((a, b) => (!a || b.occurredAt < a.occurredAt ? b : a), null);
    if (!reply) continue;
    replied = true;
    for (const [orderId, first] of firstEventOf) if (confirmed.has(orderId) && first.cycle === n.cycle && first.occurredAt > reply.occurredAt) recovered.add(orderId);
  }
  return { followedUp: true, replied, recoveredOrderIds: [...recovered].sort() };
}
